/**
 * 零依赖 HTTP 服务器：静态页面 + JSON API。
 * 用 Node 内置 http 模块，数据落 SQLite（node:sqlite），无需联网安装依赖。
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb, nowIso, listAudit, audit } from './db.js';
import {
  createSession, destroySession, resolveSession, seedUsers, sessionCookie, clearCookie,
  requireRole, requireSession, logAction, permissionMatrix, listUsers, userById, ROLES,
} from './auth.js';
import {
  attribute, buildJourneys, modelCatalog, migrateContributions, normalizeParams, normalizeRefundPolicy,
  paramHash, resultHash, sensitivity, hashPayload, getModel, REFUND_POLICIES,
} from '../lib/attribution.js';
import { buildSeedDataset, snapshotMeta } from './seed-data.js';
import { toCsv } from './csv.js';

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(data);
}

function fail(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  json(res, status, { error: err.message || '服务器错误', status });
}

async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

function cookies(req) {
  return req.headers.cookie || '';
}

function ctxFrom(req) {
  return resolveSession(cookies(req));
}

/* ---------------------------- 快照 ---------------------------- */

export function createSnapshot({ payload, name, description, source, createdBy }) {
  const db = openDb();
  const meta = snapshotMeta(payload);
  const existing = db.prepare('SELECT id FROM snapshots WHERE hash = ?').get(meta.hash);
  if (existing) return { id: existing.id, deduped: true };
  const id = `snap_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO snapshots (id, name, description, source, hash, payload, event_count, conversion_count, identity_count, date_from, date_to, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, name || payload.name || '未命名快照', description || payload.description || '', source || 'upload',
    meta.hash, JSON.stringify(payload), meta.event_count, meta.conversion_count, meta.identity_count,
    meta.date_from, meta.date_to, createdBy, nowIso()
  );
  audit({ userId: createdBy, userName: createdBy, action: 'snapshot.create', objectType: 'snapshot', objectId: id, detail: { hash: meta.hash } });
  return { id, deduped: false, meta };
}

export function getSnapshot(id) {
  const row = openDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  if (!row) {
    const err = new Error('快照不存在');
    err.status = 404;
    throw err;
  }
  return { ...row, payload: JSON.parse(row.payload) };
}

function ensureSeedSnapshot() {
  const db = openDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n;
  if (count > 0) return;
  const payload = buildSeedDataset();
  createSnapshot({ payload, name: payload.name, description: payload.description, source: 'seed', createdBy: 'u_admin' });
}

/* ---------------------------- 运行 ---------------------------- */

function runFingerprint({ snapshotHash, engineVersion, modelId, modelVersion, paramHashValue, refundPolicy }) {
  return hashPayload({ snapshotHash, engineVersion, modelId, modelVersion, paramHashValue, refundPolicy });
}

export function createRun({ snapshotId, modelId, modelVersion, params, refundPolicy, label, createdBy, supersedes }) {
  const db = openDb();
  const snapshot = getSnapshot(snapshotId);
  const model = getModel(modelId, modelVersion);
  const normalizedParams = normalizeParams(modelId, params, model.version);
  const policy = normalizeRefundPolicy(refundPolicy);
  const pHash = paramHash(modelId, model.version, normalizedParams, policy);
  const fingerprint = runFingerprint({
    snapshotHash: snapshot.hash,
    engineVersion: '1.0.0',
    modelId,
    modelVersion: model.version,
    paramHashValue: pHash,
    refundPolicy: policy,
  });
  const existing = db.prepare('SELECT id FROM runs WHERE fingerprint = ?').get(fingerprint);
  if (existing) {
    return { id: existing.id, deduped: true };
  }
  const { journeys, anomalies, lateSamples, duplicateSamples } = buildJourneys(snapshot.payload);
  const result = attribute({ modelId, modelVersion: model.version, params: normalizedParams, journeys, refundPolicy: policy });
  result.data_quality = { anomalies, lateSamples, duplicateSamples };
  const rHash = resultHash(result);
  const id = `run_${randomUUID().slice(0, 8)}`;
  const created_at = nowIso();
  db.prepare(
    `INSERT INTO runs (id, snapshot_id, snapshot_hash, engine_version, model_id, model_version, param_hash, params, refund_policy,
       fingerprint, label, result, result_hash, supersedes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, snapshotId, snapshot.hash, result.engine_version, modelId, model.version, pHash,
    JSON.stringify(normalizedParams), policy, fingerprint, label || `${model.label} v${model.version}`,
    JSON.stringify(result), rHash, supersedes || null, createdBy, created_at
  );
  audit({
    userId: createdBy,
    userName: createdBy,
    action: 'run.create',
    objectType: 'run',
    objectId: id,
    detail: { model: modelId, version: model.version, params: normalizedParams, refund_policy: policy, supersedes: supersedes || null },
  });
  // 版本锁：旧运行标记为被替代，但结果不变。
  if (supersedes) {
    db.prepare('UPDATE runs SET supersedes = COALESCE(supersedes, ?) WHERE id = ?').run(id, supersedes);
  }
  return { id, deduped: false };
}

export function getRun(id) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  if (!row) {
    const err = new Error('运行不存在');
    err.status = 404;
    throw err;
  }
  const supersededBy = db.prepare('SELECT id FROM runs WHERE supersedes = ? ORDER BY created_at DESC LIMIT 1').get(id);
  return {
    ...row,
    params: JSON.parse(row.params),
    result: JSON.parse(row.result),
    superseded_by: supersededBy ? supersededBy.id : null,
    created_by_name: userById(row.created_by)?.name || row.created_by,
  };
}

function listRuns({ limit = 50, snapshotId } = {}) {
  const db = openDb();
  const rows = snapshotId
    ? db.prepare('SELECT * FROM runs WHERE snapshot_id = ? ORDER BY created_at DESC LIMIT ?').all(snapshotId, Number(limit))
    : db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(Number(limit));
  const db2 = openDb();
  return rows.map((r) => {
    const result = JSON.parse(r.result);
    const supersededBy = db2.prepare('SELECT id FROM runs WHERE supersedes = ? ORDER BY created_at DESC LIMIT 1').get(r.id);
    return {
      id: r.id,
      snapshot_id: r.snapshot_id,
      snapshot_hash: r.snapshot_hash,
      model_id: r.model_id,
      model_version: r.model_version,
      param_hash: r.param_hash,
      params: JSON.parse(r.params),
      refund_policy: r.refund_policy,
      fingerprint: r.fingerprint,
      result_hash: r.result_hash,
      label: r.label,
      supersedes: r.supersedes,
      created_by: r.created_by,
      created_by_name: userById(r.created_by)?.name || r.created_by,
      superseded_by: supersededBy ? supersededBy.id : null,
      created_at: r.created_at,
      totals: result.totals,
      unattributed: result.unattributed,
      model: result.model,
    };
  });
}

/* ---------------------------- 路由 ---------------------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[a-zA-Z]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$'
  );
  routes.push({ method, regex, keys, handler });
}

/* ---- 会话 ---- */

route('GET', '/api/me', (req, res) => {
  const ctx = ctxFrom(req);
  if (!ctx) return json(res, 200, { user: null, roles: permissionMatrix(), users: listUsers() });
  json(res, 200, { user: ctx.user, role: ctx.role, roles: permissionMatrix(), users: listUsers() });
});

route('POST', '/api/session', async (req, res) => {
  const body = await readBody(req);
  if (!body || !body.user_id) {
    const err = new Error('缺少 user_id');
    err.status = 400;
    throw err;
  }
  const session = createSession(body.user_id);
  audit({ userId: session.user.id, userName: session.user.name, action: 'session.login', objectType: 'session', objectId: session.id, detail: {} });
  json(res, 201, { user: session.user, role: ROLES[session.user.role] }, { 'set-cookie': sessionCookie(session.id) });
});

route('DELETE', '/api/session', (req, res) => {
  const ctx = ctxFrom(req);
  if (ctx) destroySession(ctx.sessionId);
  json(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
});

/* ---- 元数据 ---- */

route('GET', '/api/meta', (req, res) => {
  requireSession(ctxFrom(req));
  const db = openDb();
  const snapshots = db.prepare('SELECT id, name, description, source, hash, event_count, conversion_count, identity_count, date_from, date_to, created_by, created_at FROM snapshots ORDER BY created_at DESC').all();
  json(res, 200, {
    models: modelCatalog(),
    refund_policies: Object.values(REFUND_POLICIES),
    snapshots,
    runs: listRuns({ limit: 100 }),
    permissions: permissionMatrix(),
  });
});

/* ---- 快照 ---- */

route('POST', '/api/snapshots', async (req, res) => {
  const ctx = ctxFrom(req);
  requireRole(ctx, 'upload');
  const body = await readBody(req);
  if (!body || !body.payload) {
    const err = new Error('缺少 payload');
    err.status = 400;
    throw err;
  }
  const payload = body.payload;
  if (!Array.isArray(payload.events) || !Array.isArray(payload.conversions)) {
    const err = new Error('payload 必须包含 events 与 conversions 数组');
    err.status = 400;
    throw err;
  }
  const created = createSnapshot({
    payload,
    name: body.name || payload.name,
    description: body.description || payload.description,
    source: 'upload',
    createdBy: ctx.user.id,
  });
  logAction(ctx, 'snapshot.upload', 'snapshot', created.id, { hash: hashPayload(payload) });
  json(res, created.deduped ? 200 : 201, created);
});

route('GET', '/api/snapshots/:id', (req, res, params) => {
  const ctx = requireSession(ctxFrom(req));
  const snap = getSnapshot(params.id);
  const { payload, ...meta } = snap;
  json(res, 200, { ...meta, payload_summary: { events: payload.events.length, conversions: payload.conversions.length } });
});

/* ---- 运行 ---- */

route('POST', '/api/runs', async (req, res) => {
  const ctx = ctxFrom(req);
  requireRole(ctx, 'run');
  const body = await readBody(req);
  const created = createRun({
    snapshotId: body.snapshot_id,
    modelId: body.model_id,
    modelVersion: body.model_version,
    params: body.params || {},
    refundPolicy: body.refund_policy,
    label: body.label,
    createdBy: ctx.user.id,
    supersedes: body.supersedes || null,
  });
  const run = getRun(created.id);
  json(res, created.deduped ? 200 : 201, {
    ...run,
    deduped: created.deduped,
    fingerprint_note: created.deduped
      ? '相同快照、模型版本、参数与退款策略已存在运行，直接复用（结果锁定）。'
      : '新运行已固定；旧运行结果不受影响。',
  });
});

route('GET', '/api/runs/:id', (req, res, params) => {
  requireSession(ctxFrom(req));
  json(res, 200, getRun(params.id));
});

route('POST', '/api/runs/:id/verify', (req, res, params) => {
  const ctx = requireSession(ctxFrom(req));
  const run = getRun(params.id);
  const snap = getSnapshot(run.snapshot_id);
  const { journeys } = buildJourneys(snap.payload);
  const recomputed = attribute({
    modelId: run.model_id,
    modelVersion: run.model_version,
    params: run.params,
    journeys,
    refundPolicy: run.refund_policy,
  });
  const recomputedHash = resultHash(recomputed);
  const snapshotMatch = snap.hash === run.snapshot_hash;
  logAction(ctx, 'run.verify', 'run', run.id, { match: recomputedHash === run.result_hash, snapshot_match: snapshotMatch });
  json(res, 200, {
    run_id: run.id,
    snapshot_hash_stored: run.snapshot_hash,
    snapshot_hash_current: snap.hash,
    snapshot_match: snapshotMatch,
    result_hash_stored: run.result_hash,
    result_hash_recomputed: recomputedHash,
    result_match: recomputedHash === run.result_hash,
    channel_rows_match: JSON.stringify(recomputed.channel_rows) === JSON.stringify(run.result.channel_rows),
    verified_at: nowIso(),
  });
});

/* ---- 贡献迁移 ---- */

route('GET', '/api/runs/:id/compare/:otherId', (req, res, params) => {
  requireSession(ctxFrom(req));
  const a = getRun(params.id);
  const b = getRun(params.otherId);
  const migration = migrateContributions(b.result, a.result);
  const summaryOf = (run) => ({
    id: run.id,
    label: run.label,
    model: run.result.model,
    params: run.params,
    refund_policy: run.refund_policy,
    created_at: run.created_at,
    snapshot_id: run.snapshot_id,
    snapshot_hash: run.snapshot_hash,
    totals: run.result.totals,
    unattributed: run.result.unattributed,
  });
  json(res, 200, {
    base: summaryOf(b),
    compare: summaryOf(a),
    same_snapshot: a.snapshot_id === b.snapshot_id,
    ...migration,
  });
});

/* ---- 敏感性 ---- */

route('POST', '/api/sensitivity', async (req, res) => {
  requireSession(ctxFrom(req));
  const body = await readBody(req);
  const snap = getSnapshot(body.snapshot_id);
  const model = getModel(body.model_id, body.model_version);
  const { journeys } = buildJourneys(snap.payload);
  const result = sensitivity({
    modelId: model.id,
    modelVersion: model.version,
    baseParams: body.params || {},
    journeys,
    refundPolicy: body.refund_policy,
  });
  json(res, 200, { snapshot_id: snap.id, snapshot_hash: snap.hash, ...result });
});

/* ---- 审计 ---- */

route('GET', '/api/audit', (req, res) => {
  const ctx = requireSession(ctxFrom(req));
  const allowed = ctx.role.canExport.includes('audit');
  json(res, 200, { entries: listAudit(300), can_export: allowed });
});

/* ---- 导出 ---- */

function parseExportQuery(params, url) {
  return {
    view: url.searchParams.get('view') || 'channels',
    run_id: url.searchParams.get('run_id') || params.id,
  };
}

function assertExport(ctx, format) {
  requireSession(ctx);
  const cap = format === 'json' ? 'export_json' : 'export_csv';
  requireRole(ctx, cap);
}

route('GET', '/api/runs/:id/export.csv', (req, res, params, url) => {
  const ctx = ctxFrom(req);
  assertExport(ctx, 'csv');
  const run = getRun(params.id);
  const view = url.searchParams.get('view') || 'channels';
  const { filename, csv } = runCsv(run, view);
  logAction(ctx, 'export.csv', 'run', run.id, { view, rows: csv.split('\n').length - 1 });
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(csv);
});

route('GET', '/api/runs/:id/export.json', (req, res, params) => {
  const ctx = ctxFrom(req);
  assertExport(ctx, 'json');
  const run = getRun(params.id);
  logAction(ctx, 'export.json', 'run', run.id, {});
  const body = JSON.stringify({ exported_at: nowIso(), run }, null, 2);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${run.id}.json"`,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
});

route('GET', '/api/audit/export.csv', (req, res) => {
  const ctx = ctxFrom(req);
  assertExport(ctx, 'csv');
  requireRole(ctx, 'export_audit');
  const rows = listAudit(1000);
  const csv = toCsv(
    ['ts', 'user_name', 'role', 'action', 'object_type', 'object_id', 'detail'],
    rows.map((r) => [r.ts, r.user_name, '', r.action, r.object_type, r.object_id || '', JSON.stringify(r.detail)])
  );
  logAction(ctx, 'export.audit', 'audit', null, { rows: rows.length });
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="audit-log.csv"',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(csv);
});

export function runCsv(run, view) {
  const r = run.result;
  if (view === 'conversions') {
    const rows = r.conversion_rows.map((c) => [
      c.conversion_id, c.ts_iso, c.identity, c.status, c.reason || '',
      c.gross_value, c.refund_value, c.net_value, c.touch_count,
      (c.allocations || []).map((a) => `${a.channel}:${a.credit}`).join(' | '),
      c.cross_device ? 'yes' : 'no', c.is_late ? 'yes' : 'no', c.arrival_lag_hours,
    ]);
    return {
      filename: `${run.id}-conversions.csv`,
      csv: toCsv(
        ['conversion_id', 'ts', 'identity', 'status', 'reason', 'gross_value', 'refund_value', 'net_value', 'touch_count', 'allocations', 'cross_device', 'late', 'arrival_lag_hours'],
        rows,
        metadataRows(run)
      ),
    };
  }
  if (view === 'unattributed') {
    const rows = r.conversion_rows
      .filter((c) => c.status !== 'attributed')
      .map((c) => [c.conversion_id, c.ts_iso, c.identity, c.status, c.reason || '', c.gross_value, c.refund_value, c.net_value, c.touch_count, c.is_late ? 'yes' : 'no']);
    return {
      filename: `${run.id}-unattributed.csv`,
      csv: toCsv(
        ['conversion_id', 'ts', 'identity', 'status', 'reason', 'gross_value', 'refund_value', 'net_value', 'touch_count', 'late'],
        rows,
        metadataRows(run)
      ),
    };
  }
  if (view === 'paths') {
    const rows = r.paths.map((p) => [p.rank, p.path_key, p.attributed_conversions, p.value, p.touch_total, p.cross_device]);
    return {
      filename: `${run.id}-paths.csv`,
      csv: toCsv(['rank', 'path', 'attributed_conversions', 'value', 'touch_total', 'cross_device'], rows, metadataRows(run)),
    };
  }
  const rows = r.channel_rows.map((c) => [
    c.channel, c.campaign, c.kind, c.credit, c.share, c.attributed_conversions, c.touch_count, c.touch_share, c.refund_clawback,
  ]);
  return {
    filename: `${run.id}-channels.csv`,
    csv: toCsv(
      ['channel', 'campaign', 'kind', 'credit', 'share', 'attributed_conversions', 'touch_count', 'touch_share', 'refund_clawback'],
      rows,
      metadataRows(run)
    ),
  };
}

function metadataRows(run) {
  const r = run.result;
  return [
    ['run_id', run.id],
    ['snapshot_id', run.snapshot_id],
    ['snapshot_hash', run.snapshot_hash],
    ['model', `${r.model.id}@${r.model.version}`],
    ['engine_version', r.engine_version],
    ['param_hash', run.param_hash],
    ['result_hash', run.result_hash],
    ['refund_policy', r.refund_policy],
    ['params', JSON.stringify(r.params)],
    ['created_at', run.created_at],
    ['attributed_value', r.totals.attributed_value],
    ['unattributed_conversions', r.unattributed.conversions],
    ['unattributed_value', r.unattributed.net_value],
  ];
}

/* ---- 静态文件 ---- */

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^([/\\])+/, '');
  if (rel.includes('..')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const file = join(PUBLIC_DIR, rel);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': info.size,
      ...SECURITY_HEADERS,
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

/* ---- 主处理 ---- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.regex);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler(req, res, params, url);
      }
      return json(res, 404, { error: '接口不存在', status: 404 });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('method not allowed');
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    fail(res, err);
  }
});

export function bootstrap() {
  seedUsers();
  ensureSeedSnapshot();
}

if (process.argv[1] && process.argv[1].endsWith('/src/server/index.js')) {
  bootstrap();
  server.listen(PORT, () => {
    console.log(`归因控制台已启动: http://localhost:${PORT}`);
  });
}

export { server };
