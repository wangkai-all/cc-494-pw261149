import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个测试文件使用独立数据库，避免污染演示数据。
const dir = mkdtempSync(join(tmpdir(), 'attr-test-'));
process.env.DATA_DIR = dir;
process.env.DB_PATH = join(dir, 'test.sqlite3');

const { server } = await import('../src/server/index.js');
const { bootstrap, createSnapshot, createRun } = await import('../src/server/index.js');
const { buildSeedDataset } = await import('../src/server/seed-data.js');

bootstrap();
server.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const payload = buildSeedDataset();
const snap = createSnapshot({ payload, name: 'test', createdBy: 'u_admin' });
const run = createRun({
  snapshotId: snap.id,
  modelId: 'last_touch',
  modelVersion: '1.0.0',
  params: {},
  refundPolicy: 'clawback',
  label: 'test run',
  createdBy: 'u_admin',
});

test.after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(userId) {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
  });
}

test('未登录：除身份查询外一律 401（结果属于受限数据）', async () => {
  const me = await fetch(`${base}/api/me`);
  assert.equal((await me.json()).user, null);

  const meta = await fetch(`${base}/api/meta`);
  assert.equal(meta.status, 401);

  const read = await fetch(`${base}/api/runs/${run.id}`);
  assert.equal(read.status, 401);

  const exp = await fetch(`${base}/api/runs/${run.id}/export.csv`);
  assert.equal(exp.status, 401);

  const sens = await fetch(`${base}/api/sensitivity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'linear', model_version: '1.0.0' }),
  });
  assert.equal(sens.status, 401);

  const create = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'linear', model_version: '1.0.0' }),
  });
  assert.equal(create.status, 401);
});

test('查看者：不能导出 CSV / JSON / 审计，也不能新建运行或上传快照', async () => {
  const call = await login('u_viewer');
  assert.equal((await call(`/api/runs/${run.id}/export.csv`)).status, 403);
  assert.equal((await call(`/api/runs/${run.id}/export.json`)).status, 403);
  assert.equal((await call('/api/audit/export.csv')).status, 403);
  assert.equal(
    (await call('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ snapshot_id: snap.id, model_id: 'linear', model_version: '1.0.0' }),
    })).status,
    403
  );
  assert.equal((await call('/api/snapshots', { method: 'POST', body: JSON.stringify({ payload: { events: [], conversions: [] } }) })).status, 403);
});

test('分析师：可新建运行与 CSV，但 JSON 与审计导出被拒', async () => {
  const call = await login('u_analyst');
  const created = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'linear', model_version: '1.0.0', params: { lookback_days: 14 } }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.params.lookback_days, 14);

  const csv = await call(`/api/runs/${run.id}/export.csv?view=conversions`);
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /attribution-export/);
  assert.match(text, /snapshot_hash/);
  assert.match(text, /conversion_id/);

  assert.equal((await call(`/api/runs/${run.id}/export.json`)).status, 403);
  assert.equal((await call('/api/audit/export.csv')).status, 403);
});

test('管理员：可导出 JSON 与审计日志，且导出被记录', async () => {
  const call = await login('u_admin');
  const json = await call(`/api/runs/${run.id}/export.json`);
  assert.equal(json.status, 200);
  const data = await json.json();
  assert.equal(data.run.result_hash.length, 16);
  assert.ok(Array.isArray(data.run.result.channel_rows));

  const audit = await call('/api/audit/export.csv');
  assert.equal(audit.status, 200);
  const text = await audit.text();
  assert.match(text, /export.csv|export.json|export.audit/);
});

test('运行锁定：相同快照 + 版本 + 参数 + 退款策略复用同一结果，不覆盖历史', async () => {
  const call = await login('u_admin');
  const opts = {
    method: 'POST',
    body: JSON.stringify({
      snapshot_id: snap.id,
      model_id: 'time_decay',
      model_version: '1.0.0',
      params: { half_life_hours: 48 },
      refund_policy: 'clawback',
      label: '第一次',
    }),
  };
  const first = await call('/api/runs', opts);
  assert.equal(first.status, 201);
  const a = await first.json();
  const second = await call('/api/runs', { ...opts, body: JSON.stringify({
    snapshot_id: snap.id, model_id: 'time_decay', model_version: '1.0.0',
    params: { half_life_hours: 48 }, refund_policy: 'clawback', label: '第二次（同参数）',
  }) });
  assert.equal(second.status, 200);
  const b = await second.json();
  assert.equal(b.id, a.id);
  assert.equal(b.deduped, true);
  assert.equal(b.label, '第一次', '不能覆盖已锁定结果的名称与内容');

  const changed = await call('/api/runs', { ...opts, body: JSON.stringify({
    snapshot_id: snap.id, model_id: 'time_decay', model_version: '1.0.0',
    params: { half_life_hours: 168 }, refund_policy: 'clawback', label: '新参数',
  }) });
  assert.equal(changed.status, 201);
  const c = await changed.json();
  assert.notEqual(c.id, a.id);
  assert.notEqual(c.result_hash, a.result_hash);
});

test('口径修订：新版本产生新结果并保留旧结果，迁移可读', async () => {
  const call = await login('u_admin');
  const v10 = await (await call(`/api/runs/${run.id}`)).json();
  const created = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      snapshot_id: snap.id,
      model_id: 'last_touch',
      model_version: '1.1.0',
      params: {},
      refund_policy: 'clawback',
      supersedes: run.id,
      label: 'v1.1.0',
    }),
  });
  assert.equal(created.status, 201);
  const v11 = await created.json();
  assert.equal(v11.supersedes, run.id);

  const old = await (await call(`/api/runs/${run.id}`)).json();
  assert.equal(old.result_hash, v10.result_hash, '旧结果不得改变');

  const cmp = await (await call(`/api/runs/${v11.id}/compare/${run.id}`)).json();
  assert.equal(cmp.changes.model_version, true);
  assert.ok(cmp.rows.length > 0);
  const direct = cmp.rows.find((r) => r.channel === 'direct');
  assert.ok(direct.delta_credit <= 0, '直访回退应降低直接访问贡献');
  const deltaSum = cmp.rows.reduce((a, r) => a + r.delta_credit, 0);
  assert.ok(Math.abs(deltaSum) < 0.1, '同一快照下迁移净额为零');
});

test('校验接口：重算结果与存档一致', async () => {
  const call = await login('u_analyst');
  const v = await (await call(`/api/runs/${run.id}/verify`, { method: 'POST' })).json();
  assert.equal(v.snapshot_match, true);
  assert.equal(v.result_match, true);
  assert.equal(v.channel_rows_match, true);
});

test('敏感性接口：返回变体、区间与排名翻转', async () => {
  const call = await login('u_analyst');
  const res = await call('/api/sensitivity', {
    method: 'POST',
    body: JSON.stringify({
      snapshot_id: snap.id,
      model_id: 'time_decay',
      model_version: '1.0.0',
      params: {},
      refund_policy: 'clawback',
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.snapshot_hash.length, 16);
  assert.ok(data.summary.variant_count >= 8);
  assert.ok(data.channels.length > 0);
  assert.ok(data.variants.some((v) => v.label.includes('半衰期')));
  assert.ok(data.channels.every((c) => c.min_share <= c.max_share));
});

test('非法输入：未知模型、坏参数、坏快照返回 400/404 而非 500', async () => {
  const call = await login('u_admin');
  const bad1 = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'magic', model_version: '1.0.0' }),
  });
  assert.equal(bad1.status, 400);
  const bad2 = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'time_decay', model_version: '1.0.0', params: { lookback_days: 'abc' } }),
  });
  assert.equal(bad2.status, 400);
  const bad3 = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: 'snap_missing', model_id: 'linear', model_version: '1.0.0' }),
  });
  assert.equal(bad3.status, 404);
  const bad4 = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'last_touch', model_version: '7.0.0' }),
  });
  assert.equal(bad4.status, 400);
});

test('上传快照：相同内容去重，不同内容新建', async () => {
  const call = await login('u_analyst');
  const small = {
    events: [{ event_id: 'e1', identity_id: 'x', ts: '2026-01-01T00:00:00Z', channel: 'email', campaign: 'c' }],
    conversions: [{ conversion_id: 'c1', identity_id: 'x', ts: '2026-01-02T00:00:00Z', value: 10 }],
  };
  const a = await call('/api/snapshots', { method: 'POST', body: JSON.stringify({ payload: small, name: '小型' }) });
  assert.equal(a.status, 201);
  const b = await call('/api/snapshots', { method: 'POST', body: JSON.stringify({ payload: small, name: '小型' }) });
  assert.equal(b.status, 200);
  assert.equal((await b.json()).deduped, true);

  const changed = { ...small, conversions: [{ ...small.conversions[0], value: 11 }] };
  const c = await call('/api/snapshots', { method: 'POST', body: JSON.stringify({ payload: changed, name: '小型-改' }) });
  assert.equal(c.status, 201);
  assert.equal((await c.json()).deduped, false);

  const invalid = await call('/api/snapshots', { method: 'POST', body: JSON.stringify({ payload: { events: [] } }) });
  assert.equal(invalid.status, 400);
});

test('会话：退出后不可再运行', async () => {
  const call = await login('u_analyst');
  assert.equal((await call('/api/me')).status, 200);
  assert.equal((await call('/api/session', { method: 'DELETE' })).status, 200);
  const after = await call('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snap.id, model_id: 'linear', model_version: '1.0.0' }),
  });
  assert.equal(after.status, 401);
});
