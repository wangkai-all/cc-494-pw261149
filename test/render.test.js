/**
 * 渲染冒烟测试：在 Node 内置的 DOM 替身里加载前端脚本，确认六个视图都能渲染。
 *
 * 这不是浏览器测试（环境无浏览器）；它捕获的是真实模块加载、模板字符串、
 * 图表函数的运行时错误，以及权限相关的按钮状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// 极简 DOM 替身：只实现 ui.js / app.js 用到的 API。
class ClassList {
  constructor(node) { this.node = node; }
  _set() { return new Set((this.node.getAttribute('class') || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.node.setAttribute('class', [...set].join(' ')); }
  add(...c) { const s = this._set(); c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set(); c.forEach((x) => s.delete(x)); this._write(s); }
  toggle(c, force) { const s = this._set(); const on = force === undefined ? !s.has(c) : force; on ? s.add(c) : s.delete(c); this._write(s); return on; }
  contains(c) { return this._set().has(c); }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.textContent = '';
    this._width = 640;
  }
  get children() { return this.childNodes.filter((n) => n instanceof Node); }
  get childElementCount() { return this.children.length; }
  get clientWidth() { return this._width; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  append(...nodes) {
    for (const n of nodes.flat()) {
      if (n instanceof Node) this.childNodes.push(n);
      else if (n && typeof n === 'object' && 'textContent' in n) this.childNodes.push(n);
      else this.childNodes.push({ textContent: String(n) });
    }
  }
  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) { this.childNodes.unshift(...nodes); }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() {}
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener() {}
  dispatchEvent(evt) { const fn = this.listeners.get(evt.type); if (fn) fn(evt); return true; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  set innerHTML(v) { this.childNodes = [{ textContent: String(v) }]; }
  get innerHTML() { return ''; }
  focus() {}
  close() {}
  showModal() { this.open = true; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  get options() { return this.children; }
  get value() { return this.attributes.get('value') || this._value || ''; }
  set value(v) { this._value = String(v); }
  get checked() { return Boolean(this._checked); }
  set checked(v) { this._checked = v; }
}

const document = {
  documentElement: new Node('html'),
  body: new Node('body'),
  createElement: (t) => new Node(t),
  createElementNS: (_ns, t) => new Node(t),
  createTextNode: (t) => ({ textContent: String(t) }),
  getElementById: (id) => registry.get(id) || null,
  querySelector: (sel) => registry.get(sel.replace(/^#/, '')) || null,
  querySelectorAll: () => [],
  addEventListener() {},
};
const registry = new Map();
function host(id, tag = 'div') {
  const node = new Node(tag);
  registry.set(id, node);
  document.body.append(node);
  return node;
}
for (const id of ['tooltip', 'toast', 'snapshot-select', 'run-select', 'user-select', 'user-name', 'new-run-button', 'logout-button',
  'user-role', 'user-avatar', 'main', 'tabs', 'theme-toggle', 'run-form', 'rf-model', 'rf-version',
  'rf-label', 'rf-refund', 'rf-supersedes', 'rf-params', 'rf-hint', 'rf-foot-hint', 'rf-submit',
  'login-dialog', 'login-body', 'run-dialog', 'export-dialog', 'export-body', 'export-sub',
  'context-controls']) {
  host(id);
}
const mainEl = registry.get('main');
const formEl = registry.get('run-form');
formEl.querySelectorAll = () => [];
formEl.reset = () => {};
for (const btn of ['theme-toggle', 'user-select', 'snapshot-select', 'run-select', 'run-form']) {
  const n = registry.get(btn);
  if (n) n.listeners = new Map();
}
// data-close-dialog 按钮在 index.html 中；测试里补上。
document.querySelectorAll = (sel) => (String(sel).includes('data-close-dialog') ? [] : []);

globalThis.document = document;
globalThis.Node = Node;
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1280, innerHeight: 900,
  addEventListener(type, fn) { windowListeners.set(type, fn); },
  removeEventListener() {},
  dispatchEvent(evt) { const fn = windowListeners.get(evt.type); if (fn) fn(evt); return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo() {},
  location: { hash: '#/overview' },
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); } };
globalThis.getComputedStyle = () => ({
  getPropertyValue(name) {
    const map = {
      '--series-1': '#2a78d6', '--series-2': '#eb6834', '--series-3': '#1baf7a',
      '--pos': '#2a78d6', '--neg': '#d03b3b', '--ink': '#0b0b0b', '--ink-2': '#52514e',
      '--surface': '#fcfcfb', '--muted': '#898781',
    };
    return map[name] || '#000000';
  },
});
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn);
globalThis.fetch = async () => { throw new Error('fetch not stubbed in smoke test'); };

// --- 真实模块 + 假后端 ---
const { el } = await import('../public/ui.js');

const FIXTURE = {
  user: { id: 'u_admin', name: '林岚', role: 'admin', title: '平台负责人' },
  role: { id: 'admin', canExport: ['csv', 'json', 'audit'], canRun: true, canUpload: true },
  roles: [
    { id: 'viewer', label: '查看者', can_export_csv: false, can_export_json: false, can_export_audit: false, can_run: false, can_upload: false },
    { id: 'analyst', label: '分析师', can_export_csv: true, can_export_json: false, can_export_audit: false, can_run: true, can_upload: true },
    { id: 'admin', label: '管理员', can_export_csv: true, can_export_json: true, can_export_audit: true, can_run: true, can_upload: true },
  ],
  users: [
    { id: 'u_admin', name: '林岚', role: 'admin', title: '负责人' },
    { id: 'u_viewer', name: '陈默', role: 'viewer', title: '总监' },
  ],
};

const snapshot = {
  id: 'snap_1', name: '测试快照', hash: 'abcd1234abcd1234', event_count: 10, conversion_count: 4,
  identity_count: 3, date_from: '2026-01-01T00:00:00.000Z', date_to: '2026-02-01T00:00:00.000Z',
  created_by: 'u_admin', created_at: '2026-02-01T00:00:00.000Z',
};

const result = {
  engine_version: '1.0.0',
  model: { id: 'last_touch', version: '1.0.0', label: '末次触点', summary: '', caveat: '' },
  params: { lookback_days: 30, include_direct: true, include_organic: true, dedupe_same_session: true },
  refund_policy: 'clawback',
  channel_rows: [
    { channel: 'paid_search', campaign: '品牌词', kind: 'paid', is_organic: false, credit: 600, raw_credit: 600, refund_clawback: 20, attributed_conversions: 2, touch_count: 3, share: 0.6, touch_share: 0.5 },
    { channel: 'organic_search', campaign: '(organic)', kind: 'organic', is_organic: true, credit: 300, raw_credit: 300, refund_clawback: 0, attributed_conversions: 1, touch_count: 2, share: 0.3, touch_share: 0.3 },
    { channel: 'direct', campaign: '(direct)', kind: 'organic', is_organic: true, credit: 100, raw_credit: 100, refund_clawback: 0, attributed_conversions: 1, touch_count: 1, share: 0.1, touch_share: 0.2 },
  ],
  conversion_rows: [
    { conversion_id: 'c1', ts_iso: '2026-01-05T00:00:00.000Z', identity: 'a', status: 'attributed', net_value: 600, gross_value: 600, refund_value: 0, touch_count: 2, allocations: [{ channel: 'paid_search', credit: 600 }], cross_device: true, is_late: true, arrival_lag_hours: 40, devices: ['d1', 'd2'] },
    { conversion_id: 'c2', ts_iso: '2026-01-06T00:00:00.000Z', identity: 'b', status: 'attributed', net_value: 300, gross_value: 300, refund_value: 0, touch_count: 1, allocations: [{ channel: 'organic_search', credit: 300 }], cross_device: false, is_late: false, arrival_lag_hours: 0, devices: ['d3'] },
    { conversion_id: 'c3', ts_iso: '2026-01-07T00:00:00.000Z', identity: 'c', status: 'unattributed', reason: 'no_touch', net_value: 100, gross_value: 100, refund_value: 0, touch_count: 0, allocations: [], cross_device: false, is_late: false, arrival_lag_hours: 0, devices: [] },
  ],
  paths: [
    { rank: 1, path: ['display', 'paid_search'], path_key: 'display > paid_search', attributed_conversions: 1, value: 600, touch_total: 2, cross_device: 1 },
    { rank: 2, path: ['organic_search'], path_key: 'organic_search', attributed_conversions: 1, value: 300, touch_total: 1, cross_device: 0 },
  ],
  totals: {
    conversions: 3, attributed_conversions: 2, unattributed_conversions: 1, excluded_conversions: 0,
    gross_value: 1000, net_value: 1000, attributed_value: 900, refund_clawback: 20, refunded_value: 20,
    late_conversions: 1, late_conversion_value: 600, cross_device_conversions: 1, cross_device_value: 600,
    post_conversion_touches: 1, unattributed_share: 0.1,
  },
  unattributed: {
    conversions: 1, gross_value: 100, net_value: 100,
    reasons: { no_touch: 1, no_touch_in_window: 0, direct_excluded_only: 0, organic_excluded_only: 0, zero_value: 0 },
    reason_value: { no_touch: 100, no_touch_in_window: 0, direct_excluded_only: 0, organic_excluded_only: 0, zero_value: 0 },
  },
  refunds: { policy: 'clawback', refunded_orders: 1, refund_amount: 20, clawback: 20, fully_refunded_orders: 0, fully_refunded_value: 0, excluded_orders: 0, excluded_value: 0, late_refunds: 0 },
  data_quality: {
    anomalies: {
      duplicate_events: 2, duplicate_conversions: 1, missing_identity: 1, invalid_time: 1, unlinked_devices: 3,
      late_conversions: 1, raw_events: 10, raw_conversions: 4, deduped_events: 8, deduped_conversions: 3,
      identities: 3, device_count: 4, linked_device_count: 1,
      first_event_ts: Date.UTC(2026, 0, 1), last_event_ts: Date.UTC(2026, 1, 1),
    },
    duplicateSamples: [{ kind: 'event', key: 'e1', channel: 'paid_search', ts: Date.UTC(2026, 0, 2), identity: 'a' }],
    lateSamples: [{ conversion_id: 'c1', ts_iso: '2026-01-05T00:00:00.000Z', received_at: '2026-01-07T00:00:00.000Z', lag_hours: 48, value: 600, device_id: 'd2' }],
  },
};

const run = {
  id: 'run_1', snapshot_id: 'snap_1', snapshot_hash: 'abcd1234abcd1234', model_id: 'last_touch',
  model_version: '1.0.0', param_hash: 'ph1234567890abcd', params: result.params, refund_policy: 'clawback',
  fingerprint: 'fp', label: '基线', result, result_hash: 'rh1234567890abcd', supersedes: null,
  superseded_by: 'run_2', created_by: 'u_admin', created_by_name: '林岚', created_at: '2026-02-01T00:00:00.000Z',
};
const run2 = {
  ...run, id: 'run_2', model_id: 'linear', model_version: '1.0.0', label: '线性基线',
  result: { ...result, model: { ...result.model, id: 'linear', label: '线性' } },
};

const sensitivity = {
  model: { id: 'last_touch', version: '1.0.0', label: '末次触点' },
  refund_policy: 'clawback',
  snapshot_hash: 'abcd1234abcd1234',
  variants: [
    { label: '基线', params: result.params },
    { label: '回看窗口 7 天', params: { ...result.params, lookback_days: 7 } },
    { label: '剔除自然流量', params: { ...result.params, include_organic: false } },
  ],
  variant_rows: [
    { __label: '基线', paid_search: 0.6, organic_search: 0.3, direct: 0.1 },
    { __label: '回看窗口 7 天', paid_search: 0.7, organic_search: 0.3, direct: 0 },
    { __label: '剔除自然流量', paid_search: 0.9, organic_search: 0, direct: 0 },
  ],
  channels: [
    { channel: 'paid_search', campaign: '品牌词', base_share: 0.6, min_share: 0.6, max_share: 0.9, min_credit: 600, max_credit: 900, best_rank: 1, worst_rank: 1, rank_flip: false, base_rank: 1, share_range: 0.3, missing_in_variants: false },
    { channel: 'organic_search', campaign: '(organic)', base_share: 0.3, min_share: 0, max_share: 0.3, best_rank: 2, worst_rank: 2, rank_flip: true, base_rank: 2, share_range: 0.3, missing_in_variants: true },
  ],
  summary: { variant_count: 3, channels_with_rank_flip: 1, max_share_range: 0.3 },
};

const compare = {
  base: { id: 'run_2', label: '线性基线', model: { id: 'linear', label: '线性', version: '1.0.0' }, params: {}, refund_policy: 'clawback', created_at: '2026-02-01T00:00:00.000Z', snapshot_id: 'snap_1', totals: { attributed_value: 900, refund_clawback: 20, attributed_conversions: 2 }, unattributed: { conversions: 1, net_value: 100 } },
  compare: { id: 'run_1', label: '基线', model: { id: 'last_touch', label: '末次触点', version: '1.0.0' }, params: {}, refund_policy: 'clawback', created_at: '2026-02-01T00:00:00.000Z', snapshot_id: 'snap_1', totals: { attributed_value: 900, refund_clawback: 20, attributed_conversions: 2 }, unattributed: { conversions: 1, net_value: 100 } },
  same_snapshot: true,
  changes: { model: true, model_version: false, params: false, refund_policy: false },
  old: { totals: { attributed_value: 900, refund_clawback: 20, attributed_conversions: 2 }, unattributed: { conversions: 1, net_value: 100 } },
  new: { totals: { attributed_value: 900, refund_clawback: 20, attributed_conversions: 2 }, unattributed: { conversions: 1, net_value: 100 } },
  rows: [
    { channel: 'paid_search', campaign: '品牌词', old_credit: 500, new_credit: 600, old_share: 0.55, new_share: 0.6, delta_credit: 100, delta_share: 0.05, kind: 'paid' },
    { channel: 'organic_search', campaign: '(organic)', old_credit: 400, new_credit: 300, old_share: 0.45, new_share: 0.3, delta_credit: -100, delta_share: -0.15, kind: 'organic' },
  ],
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  const path = url.split('?')[0];
  const respond = (body, status = 200) => ({
    ok: status < 400, status,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });
  if (path === '/api/me') return respond({ user: FIXTURE.user, role: FIXTURE.role, roles: FIXTURE.roles, users: FIXTURE.users });
  if (path === '/api/meta') {
    return respond({
      models: [
        { id: 'last_touch', label: '末次触点', summary: '', caveat: '', latest_version: '1.1.0', params: result.params,
          versions: [{ version: '1.0.0', label: '末次触点', params: result.params }, { version: '1.1.0', label: '末次触点', supersedes: '1.0.0', params: { ...result.params, direct_fallback: true }, caveat: '回退' }] },
        { id: 'linear', label: '线性', summary: '', caveat: '', latest_version: '1.0.0', params: result.params, versions: [{ version: '1.0.0', label: '线性', params: result.params }] },
      ],
      refund_policies: [{ id: 'clawback', label: '反向冲减', description: '' }],
      snapshots: [snapshot],
      runs: [
        { ...run2, totals: result.totals, unattributed: result.unattributed, model: { id: 'linear', label: '线性', version: '1.0.0' } },
        { ...run, totals: result.totals, unattributed: result.unattributed, model: result.model },
      ],
      permissions: FIXTURE.roles,
    });
  }
  if (path === '/api/runs/run_1') return respond(run);
  if (path === '/api/runs/run_2') return respond(run2);
  if (path === '/api/runs/run_1/compare/run_2' || path === '/api/runs/run_2/compare/run_1') return respond(compare);
  if (path === '/api/sensitivity') return respond(sensitivity);
  if (path === '/api/audit') return respond({ entries: [{ ts: '2026-02-01T00:00:00.000Z', user_name: '林岚', action: 'run.create', object_type: 'run', object_id: 'run_1' }], can_export: true });
  if (path === '/api/runs/run_1/verify') return respond({ result_match: true, snapshot_match: true, channel_rows_match: true, result_hash_recomputed: 'rh1234567890abcd' });
  return respond({ error: 'not stubbed: ' + path }, 500);
};

await import('../public/app.js');
await new Promise((r) => setTimeout(r, 60));

const R = registry;
const textOf = (node) => {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.textContent) out.push(n.textContent);
    for (const c of n.childNodes || []) walk(c);
  };
  walk(node);
  return out.join(' ');
};

test('总览渲染：英雄数字、无法归因、渠道图表与表格视图', () => {
  const text = textOf(R.get('main'));
  assert.match(text, /归因价值/);
  assert.match(text, /无法归因流量/);
  assert.match(text, /¥900/);
  assert.match(text, /渠道贡献/);
  assert.match(text, /付费流量/);
  assert.match(text, /自然流量/);
  assert.ok(R.get('main').childElementCount >= 4, '总览应有多个区块');
});

test('顶部选择器：快照与结果都已填充', () => {
  assert.ok(R.get('snapshot-select').children.length >= 1);
  assert.ok(R.get('run-select').children.length >= 2);
  assert.match(textOf(R.get('run-select')), /线性/);
});

async function go(view) {
  location.hash = `#/${view}`;
  window.dispatchEvent({ type: 'hashchange' });
  await new Promise((r) => setTimeout(r, 30));
  return textOf(R.get('main'));
}

test('六个视图都能渲染且不抛错', async () => {
  const paths = await go('paths');
  assert.match(paths, /转化路径/);
  assert.match(paths, /高频转化路径/);
  assert.match(paths, /跨设备与归因断链/);
  assert.match(paths, /display > paid_search/);

  const migration = await go('migration');
  assert.match(migration, /贡献迁移/);
  assert.match(migration, /渠道贡献变化/);
  assert.match(migration, /同一输入快照/);
  assert.match(migration, /迁移明细/);

  const sens = await go('sensitivity');
  assert.match(sens, /运行敏感性分析/);

  const quality = await go('quality');
  assert.match(quality, /数据质量/);
  assert.match(quality, /重复事件/);
  assert.match(quality, /迟到转化/);
  assert.match(quality, /迟到转化样本|48h/);

  const access = await go('access');
  assert.match(access, /导出与权限/);
  assert.match(access, /角色权限矩阵/);
  assert.match(access, /审计日志/);
});

test('敏感性按钮触发计算并渲染区间表', async () => {
  await go('sensitivity');
  assert.equal(calls.some((c) => c.url === '/api/sensitivity'), false, '首次进入不应自动计算；仅按钮触发');
  const btn = findButton('开始分析') || findButton('重新计算');
  assert.ok(btn, '应有开始分析按钮');
  await btn.listeners.get('click')({});
  await new Promise((r) => setTimeout(r, 60));
  const text = textOf(R.get('main'));
  assert.match(text, /份额区间/);
  assert.match(text, /排名发生翻转|排名稳定/);
});

function findButton(label) {
  const walk = (n) => {
    if (!n) return null;
    if (n.tagName === 'BUTTON' && n.textContent === label) return n;
    for (const c of n.childNodes || []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  };
  return walk(R.get('main'));
}

test('无 DOM 泄漏的 innerHTML 拼接：所有动态文本走 textContent', async () => {
  const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
  assert.equal(/innerHTML\s*=/.test(src), false, 'app.js 不应写入 innerHTML');
  const uiSrc = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../public/ui.js', import.meta.url), 'utf8'));
  assert.equal(/\.innerHTML\s*=/.test(uiSrc.replace(/node\.innerHTML = v;/, '')), false);
});
