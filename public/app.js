/* ==========================================================================
   归因控制台 — 应用外壳与视图
   ========================================================================== */
import {
  el, fmtMoney, fmtNum, fmtPct, fmtDate, fmtDateTime, channelLabel, REASON_LABEL,
  chartCard, horizontalBars, divergingBars, rangePlot, sparkline, badge, statTile,
  pathChips, initTooltip, hideTip, cssVar, seriesColor,
} from './ui.js';

const $ = (sel) => document.querySelector(sel);

const TABS = [
  { id: 'overview', label: '总览', icon: '◧' },
  { id: 'paths', label: '转化路径', icon: '⇢' },
  { id: 'migration', label: '贡献迁移', icon: '⇄' },
  { id: 'sensitivity', label: '敏感性', icon: '≈' },
  { id: 'quality', label: '数据质量', icon: '⚑' },
  { id: 'access', label: '导出与权限', icon: '⇩' },
];

const state = {
  me: null,
  meta: null,
  snapshotId: null,
  runId: null,
  run: null,
  compareId: null,
  compare: null,
  compareLoading: false,
  compareFailed: false,
  sensitivity: null,
  quality: null,
  view: 'overview',
  audit: null,
  auditStarted: false,
  loading: false,
  verified: null,
  runs: [],
};

/* ------------------------------- 网络 ---------------------------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  $('#toast').append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4200);
}

function can(cap) {
  const role = state.me && state.me.role;
  if (!role) return false;
  if (cap === 'csv') return role.canExport.includes('csv');
  if (cap === 'json') return role.canExport.includes('json');
  if (cap === 'audit') return role.canExport.includes('audit');
  if (cap === 'run') return role.canRun;
  if (cap === 'upload') return role.canUpload;
  return false;
}

/* ------------------------------ 身份 / 顶栏 ----------------------------- */

async function refreshMe() {
  state.me = await api('/api/me');
  renderUser();
}

function renderUser() {
  const me = state.me;
  const user = me.user;
  const select = $('#user-select');
  select.replaceChildren();
  for (const u of me.users) {
    select.append(el('option', { value: u.id, text: `${u.name} · ${roleLabel(u.role)}`, selected: user && user.id === u.id }));
  }
  if (!user) {
    select.value = '';
    select.prepend(el('option', { value: '', text: '选择身份…' }));
    $('#user-name').textContent = '未登录';
    $('#user-role').textContent = '以只读方式浏览';
    $('#user-avatar').textContent = '?';
    return;
  }
  $('#user-name').textContent = user.name;
  $('#user-role').textContent = `${roleLabel(user.role)} · ${user.title}`;
  $('#user-avatar').textContent = user.name.slice(-1);
}

function roleLabel(role) {
  return { admin: '管理员', analyst: '分析师', viewer: '查看者' }[role] || role;
}

async function login(userId) {
  if (!userId) {
    await api('/api/session', { method: 'DELETE' });
    state.me = await api('/api/me');
    state.run = null;
    state.meta = null;
    state.sensitivity = null;
    state.compare = null;
    state.audit = null;
    state.auditStarted = false;
    renderUser();
    render();
    return;
  }
  await api('/api/session', { body: { user_id: userId } });
  await refreshMe();
  await reloadMeta();
  state.run = state.runId ? await api(`/api/runs/${state.runId}`) : null;
  state.compare = null;
  state.compareId = null;
  state.sensitivity = null;
  state.verified = null;
  state.audit = null;
  state.auditStarted = false;
  toast(`已切换为 ${state.me.user.name}（${roleLabel(state.me.user.role)}）`, 'good');
  render();
}

function openLoginDialog() {
  const body = $('#login-body');
  body.replaceChildren();
  const rows = state.me.users.map((u) => {
    const role = state.me.roles.find((r) => r.id === u.role);
    return el('div', { class: 'run-item', role: 'button', tabindex: '0',
      onclick: async () => { await login(u.id); $('#login-dialog').close(); },
      onkeydown: async (e) => { if (e.key === 'Enter' || e.key === ' ') { await login(u.id); $('#login-dialog').close(); } },
    },
      el('div', { class: 'run-main' },
        el('div', { class: 'run-name', text: `${u.name} · ${roleLabel(u.role)}` }),
        el('div', { class: 'run-meta', text: `${u.title} — ${role ? role.description : ''}` })
      ),
      badge(roleLabel(u.role), u.role === 'admin' ? 'accent' : '')
    );
  });
  body.append(
    el('div', { class: 'tip', style: { marginBottom: '14px' } },
      el('span', { class: 'tip-icon', text: 'ⓘ' }),
      el('div', {}, '这是演示登录：选择身份即代表以该角色进入。权限校验在服务端执行，前端禁用的按钮同时会被接口拒绝。')
    ),
    el('div', { class: 'run-list' }, ...rows)
  );
  $('#login-dialog').showModal();
}

/* ------------------------------ 元数据 / 选择器 ------------------------- */

function runsForSnapshot(snapshotId) {
  return state.runs.filter((r) => r.snapshot_id === snapshotId);
}

function renderSelectors() {
  const snapSel = $('#snapshot-select');
  const runSel = $('#run-select');
  $('#context-controls').hidden = !state.me.user;
  $('#new-run-button').hidden = !(state.me.user && can('run'));
  $('#logout-button').hidden = !state.me.user;
  snapSel.replaceChildren();
  if (!state.meta) {
    snapSel.disabled = true;
    runSel.replaceChildren(el('option', { value: '', text: '登录后可用' }));
    runSel.disabled = true;
    return;
  }
  snapSel.disabled = false;
  for (const s of state.meta.snapshots) {
    snapSel.append(el('option', {
      value: s.id,
      text: `${s.name} · ${fmtNum(s.conversion_count)} 转化 · ${fmtDate(s.date_to)}`,
      selected: s.id === state.snapshotId,
    }));
  }
  const runs = runsForSnapshot(state.snapshotId);
  runSel.replaceChildren();
  if (!runs.length) {
    runSel.append(el('option', { value: '', text: '暂无结果，请新建运行' }));
    runSel.disabled = true;
  } else {
    runSel.disabled = false;
    for (const r of runs) {
      runSel.append(el('option', {
        value: r.id,
        text: `${r.model.label || r.model_id} v${r.model_version} · ${r.label}`,
        selected: r.id === state.runId,
      }));
    }
  }
}

async function reloadMeta() {
  state.meta = await api('/api/meta');
  state.runs = state.meta.runs;
  if (!state.snapshotId) state.snapshotId = state.meta.snapshots[0]?.id || null;
  const runs = runsForSnapshot(state.snapshotId);
  if (!state.runId || !runs.some((r) => r.id === state.runId)) state.runId = runs[0]?.id || null;
}

async function selectSnapshot(id) {
  state.snapshotId = id;
  const runs = runsForSnapshot(id);
  state.runId = runs[0]?.id || null;
  state.run = state.runId ? await api(`/api/runs/${state.runId}`) : null;
  state.sensitivity = null;
  state.verified = null;
  state.compare = null;
  state.compareId = null;
  renderSelectors();
  render();
}

async function selectRun(id) {
  state.runId = id;
  state.sensitivity = null;
  state.verified = null;
  state.compare = null;
  state.compareId = null;
  state.compareFailed = false;
  state.run = id ? await api(`/api/runs/${id}`) : null;
  renderSelectors();
  render();
}

/* --------------------------------- 渲染 --------------------------------- */

function setLoading(on) {
  state.loading = on;
  $('#main').classList.toggle('is-loading', on);
}

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  for (const t of TABS) {
    const btn = el('button', {
      class: 'tab', role: 'tab', type: 'button',
      'aria-selected': String(state.view === t.id),
      onclick: () => { location.hash = `#/${t.id}`; },
    },
      el('span', { 'aria-hidden': 'true', text: `${t.icon} ` }),
      t.label
    );
    nav.append(btn);
  }
}

function signedOutCard() {
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '需要登录' }),
      el('p', { text: '归因结果包含渠道与订单级数据，登录后才能查看。请选择一个演示身份继续。' })
    )),
    el('button', { class: 'btn primary', type: 'button', onclick: openLoginDialog, text: '选择演示身份' })
  );
}

function requireRun() {
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', { text: '还没有可用的归因结果' }),
      el('p', { text: '先选择一个输入快照并新建运行；结果一旦生成即被锁定。' }))),
    el('button', { class: 'btn primary', type: 'button', onclick: openRunDialog, text: '新建归因运行' })
  );
}

const viewRenderers = {
  overview: renderOverview,
  paths: renderPaths,
  migration: renderMigration,
  sensitivity: renderSensitivity,
  quality: renderQuality,
  access: renderAccess,
};

function render() {
  renderTabs();
  renderSelectors();
  maybeLoadCompare();
  const main = $('#main');
  if (!state.me.user) {
    main.replaceChildren(signedOutCard());
    return;
  }
  if (!state.run && state.view !== 'access') {
    main.replaceChildren(requireRun());
    return;
  }
  main.replaceChildren(...viewRenderers[state.view]());
}

/* -------------------------------- 总览 ---------------------------------- */

function aggregateByChannel(rows) {
  const map = new Map();
  for (const r of rows) {
    let c = map.get(r.channel);
    if (!c) c = { channel: r.channel, credit: 0, share: 0, attributed_conversions: 0, touch_count: 0, refund_clawback: 0, is_organic: r.is_organic, campaigns: 0 };
    c.credit += r.credit;
    c.attributed_conversions += r.attributed_conversions;
    c.touch_count += r.touch_count;
    c.refund_clawback += r.refund_clawback;
    c.campaigns++;
    map.set(r.channel, c);
  }
  const list = [...map.values()].sort((a, b) => b.credit - a.credit);
  const total = list.reduce((a, b) => a + b.credit, 0);
  for (const c of list) c.share = total > 0 ? c.credit / total : 0;
  return list;
}

function dailySeries(rows) {
  const map = new Map();
  for (const c of rows) {
    if (c.status !== 'attributed') continue;
    const d = c.ts_iso.slice(0, 10);
    map.set(d, (map.get(d) || 0) + c.net_value);
  }
  const keys = [...map.keys()].sort();
  if (keys.length < 2) return { labels: keys, values: keys.map((k) => map.get(k)) };
  const start = new Date(`${keys[0]}T00:00:00Z`);
  const end = new Date(`${keys[keys.length - 1]}T00:00:00Z`);
  const labels = [];
  const values = [];
  for (let d = start.getTime(); d <= end.getTime(); d += 86400000) {
    const iso = new Date(d).toISOString().slice(0, 10);
    labels.push(iso);
    values.push(map.get(iso) || 0);
  }
  return { labels, values };
}

function renderOverview() {
  const run = state.run;
  const r = run.result;
  const t = r.totals;
  const channels = aggregateByChannel(r.channel_rows);
  const days = dailySeries(r.conversion_rows);
  const last7 = days.values.slice(-7).reduce((a, b) => a + b, 0);
  const prior7 = days.values.slice(-14, -7).reduce((a, b) => a + b, 0);
  const trend = prior7 > 0 ? (last7 - prior7) / prior7 : 0;

  const hero = el('section', { class: 'card hero-card' },
    el('div', { class: 'hero-main' },
      el('div', { class: 'hero-label', text: `归因价值 · ${r.model.label} v${r.model.version}` }),
      el('div', { class: 'hero-value' }, fmtMoney(t.attributed_value), el('span', { class: 'unit', text: '元' })),
      el('div', { class: 'hero-sub' },
        `${fmtNum(t.attributed_conversions)} 笔已归因转化 · 占净额 ${fmtPct(t.net_value > 0 ? t.attributed_value / t.net_value : 0)} · 窗口 ${r.params.lookback_days} 天 · ${refundLabel(r.refund_policy)}`
      ),
      el('div', { class: 'chip-row', style: { marginTop: '12px' } },
        badge(r.model.label, 'accent'),
        badge(`v${r.model.version}`),
        badge(`快照 ${run.snapshot_id}`),
        badge(`参数 ${run.param_hash.slice(0, 8)}`),
        run.superseded_by ? badge('已被新版本替代', 'warn', '⇢') : null,
        run.supersedes ? badge('替代了旧口径', 'accent', '⇢') : null
      )
    ),
    el('div', { class: 'hero-spark' },
      el('div', { style: { width: '100%' } },
        el('div', { class: 'small muted', style: { marginBottom: '4px' }, text: `按转化日归因价值 · 近 ${Math.min(30, days.values.length)} 天` }),
        sparkline(320, days.values.slice(-30), { height: 52 }),
        el('div', { class: 'tiny muted', style: { marginTop: '2px' }, text: `近 7 天 ${fmtMoney(last7)}（环比 ${trend >= 0 ? '+' : '−'}${fmtPct(Math.abs(trend))}）` })
      )
    ),
    el('div', { class: 'stat-row' },
      statTile({
        label: '无法归因',
        value: fmtMoney(r.unattributed.net_value),
        note: el('span', {}, el('span', { class: 'dot', style: { background: 'var(--serious)' } }), `${fmtNum(r.unattributed.conversions)} 笔 · 占净额 ${fmtPct(t.unattributed_share)}`),
        noteKind: 'warn',
      }),
      statTile({
        label: '退款冲减',
        value: fmtMoney(r.refunds.clawback),
        note: `${fmtNum(r.refunds.refunded_orders)} 笔退款 · 全额退款 ${fmtNum(r.refunds.fully_refunded_orders)} 笔`,
      }),
      statTile({
        label: '跨设备转化',
        value: `${fmtNum(t.cross_device_conversions)} 笔`,
        note: `${fmtMoney(t.cross_device_value)} · 占已归因 ${fmtPct(t.attributed_value > 0 ? t.cross_device_value / t.attributed_value : 0)}`,
      }),
      statTile({
        label: '迟到转化',
        value: `${fmtNum(t.late_conversions)} 笔`,
        note: `${fmtMoney(t.late_conversion_value)} · 回传延迟 > 24h`,
        noteKind: 'warn',
      })
    )
  );

  const channelChart = chartCard({
    title: '渠道贡献',
    subtitle: '按渠道汇总归因价值；颜色区分付费与自然流量，悬停查看明细。',
    legend: [
      { label: '付费流量', color: 'var(--series-1)' },
      { label: '自然流量', color: 'var(--series-3)' },
    ],
    draw: (w) => horizontalBars(w, channels.map((c) => ({
      label: channelLabel(c.channel),
      value: c.credit,
      color: seriesColor(c.is_organic ? 2 : 0),
      tipRows: [
        { label: '份额', value: fmtPct(c.share) },
        { label: '触点', value: `${fmtNum(c.touch_count)} 次` },
        { label: '退款冲减', value: fmtMoney(c.refund_clawback) },
      ],
      meta: `${c.is_organic ? '自然流量' : '付费流量'} · ${c.campaigns} 个广告系列`,
    })), { labelWidth: 92, barHeight: 22, gap: 12 }),
    table: () => channelTable(channels, r),
    note: '自然流量（自然搜索 / 直接访问 / 外部引荐）作为真实触点参与模型，可被参数排除并计入“无法归因”。',
  });

  const unattributedCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h2', { text: '无法归因流量' }),
        el('p', { text: '单独统计，不摊派给任何渠道；可按原因导出明细。' })
      )
    ),
    el('div', { class: 'stat', style: { borderLeft: '0', padding: '0 0 12px' } },
      el('div', { class: 'stat-value', style: { fontSize: '26px' } }, fmtMoney(r.unattributed.net_value)),
      el('div', { class: 'stat-note', text: `${fmtNum(r.unattributed.conversions)} 笔转化 · 占净额 ${fmtPct(t.unattributed_share)}` })
    ),
    el('div', { class: 'table-wrap', style: { maxHeight: 'none' } },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', { text: '原因' }),
          el('th', { class: 'num', text: '转化' }),
          el('th', { class: 'num', text: '净值' })
        )),
        el('tbody', {}, ...Object.entries(r.unattributed.reasons)
          .filter(([, count]) => count > 0)
          .map(([key, count]) => el('tr', {},
            el('td', {}, el('span', { text: REASON_LABEL[key] || key })),
            el('td', { class: 'num', text: fmtNum(count) }),
            el('td', { class: 'num', text: fmtMoney(r.unattributed.reason_value?.[key] || 0) })
          ))),
        el('tr', { class: 'total' },
          el('td', { text: '合计' }),
          el('td', { class: 'num', text: fmtNum(r.unattributed.conversions) }),
          el('td', { class: 'num', text: fmtMoney(r.unattributed.net_value) })
        )
      )
    ),
    el('div', { class: 'card-foot' },
      `另有 ${fmtNum(r.totals.post_conversion_touches)} 个触点发生在转化之后（已排除，用于迟到转化识别）。`
    )
  );

  return [
    pageHead('总览', `当前结果锁定于 ${fmtDateTime(run.created_at)}，由 ${run.created_by} 生成。快照与参数不可更改；任何改版只能新建结果。`, [
      el('button', { class: 'btn', type: 'button', onclick: openRunDialog, text: '新建运行' }),
      el('button', { class: 'btn primary', type: 'button', onclick: () => openExportDialog(run), text: '导出' }),
    ]),
    hero,
    el('div', { class: 'grid side', style: { marginTop: '16px' } },
      channelChart,
      unattributedCard
    ),
    el('div', { class: 'grid cols-2', style: { marginTop: '16px' } },
      campaignCard(r),
      configCard(run)
    ),
  ];
}

function refundLabel(id) {
  return { clawback: '退款反向冲减', exclude: '退款整单剔除', ignore: '按毛额（对账）' }[id] || id;
}

function channelTable(channels, r) {
  const total = channels.reduce((a, c) => a + c.credit, 0);
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data' },
      el('caption', { text: '渠道贡献（无障碍表格视图，与图表同源）' }),
      el('thead', {}, el('tr', {},
        el('th', { text: '渠道' }),
        el('th', { text: '类型' }),
        el('th', { class: 'num', text: '归因价值' }),
        el('th', { class: 'num', text: '份额' }),
        el('th', { class: 'num', text: '触点' }),
        el('th', { class: 'num', text: '退款冲减' })
      )),
      el('tbody', {},
        ...channels.map((c) => el('tr', {},
          el('td', { class: 'strong', text: channelLabel(c.channel) }),
          el('td', {}, c.is_organic ? badge('自然', '') : '付费'),
          el('td', { class: 'num', text: fmtMoney(c.credit) }),
          el('td', { class: 'num', text: fmtPct(c.share) }),
          el('td', { class: 'num', text: fmtNum(c.touch_count) }),
          el('td', { class: 'num', text: fmtMoney(c.refund_clawback) })
        )),
        el('tr', { class: 'total' },
          el('td', { text: '合计' }),
          el('td', {}),
          el('td', { class: 'num', text: fmtMoney(total) }),
          el('td', { class: 'num', text: total > 0 ? '100.0%' : '—' }),
          el('td', { class: 'num', text: fmtNum(channels.reduce((a, c) => a + c.touch_count, 0)) }),
          el('td', { class: 'num', text: fmtMoney(channels.reduce((a, c) => a + c.refund_clawback, 0)) })
        )
      )
    )
  );
}

function campaignCard(r) {
  const rows = r.channel_rows;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', { text: '渠道 × 广告系列' }), el('p', { text: '按归因价值排序；这是导出 CSV 的默认口径。' }))
    ),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', { text: '渠道' }),
          el('th', { text: '广告系列' }),
          el('th', { class: 'num', text: '归因价值' }),
          el('th', { class: 'num', text: '份额' }),
          el('th', { class: 'num', text: '转化数' })
        )),
        el('tbody', {}, ...rows.slice(0, 14).map((c) => el('tr', {},
          el('td', { class: 'strong', text: channelLabel(c.channel) }),
          el('td', {}, el('span', { text: c.campaign }), c.is_organic ? el('span', { class: 'sub', text: ' · 自然' }) : null),
          el('td', { class: 'num', text: fmtMoney(c.credit) }),
          el('td', { class: 'num', text: fmtPct(c.share) }),
          el('td', { class: 'num', text: fmtNum(c.attributed_conversions, 1) })
        )))
      )
    ),
    el('div', { class: 'card-foot', text: `共 ${rows.length} 行；完整数据见导出。` })
  );
}

function configCard(run) {
  const r = run.result;
  const paramRows = Object.entries(r.params).map(([k, v]) =>
    el('tr', {},
      el('td', {}, el('code', { text: k })),
      el('td', { class: 'num', text: typeof v === 'boolean' ? (v ? '是' : '否') : String(v) })
    )
  );
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', { text: '结果固定信息' }), el('p', { text: '用于复核与重算；任何一项变化都会产生新的指纹。' }))
    ),
    el('div', { class: 'kv', style: { marginBottom: '12px' } },
      el('span', {}, el('b', { text: '运行 ' }), el('code', { text: run.id })),
      el('span', {}, el('b', { text: '快照 ' }), el('code', { text: run.snapshot_id })),
      el('span', {}, el('b', { text: '快照哈希 ' }), el('code', { text: run.snapshot_hash })),
      el('span', {}, el('b', { text: '结果哈希 ' }), el('code', { text: run.result_hash })),
      el('span', {}, el('b', { text: '引擎 ' }), el('code', { text: `v${r.engine_version}` }))
    ),
    el('div', { class: 'table-wrap', style: { maxHeight: '260px' } },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', { text: '参数' }), el('th', { class: 'num', text: '取值' }))),
        el('tbody', {}, ...paramRows,
          el('tr', {}, el('td', {}, el('code', { text: 'refund_policy' })), el('td', { class: 'num', text: refundLabel(r.refund_policy) }))
        )
      )
    ),
    el('div', { class: 'card-foot' },
      el('button', { class: 'btn small', type: 'button', onclick: verifyRun, text: '用快照重算并校验' }),
      state.verified ? el('span', { style: { marginLeft: '10px' } },
        state.verified.result_match
          ? badge('重算一致', 'good', '✓')
          : badge('重算不一致', 'critical', '✕')
      ) : null
    )
  );
}

async function verifyRun() {
  try {
    state.verified = await api(`/api/runs/${state.runId}/verify`, { method: 'POST' });
    toast(state.verified.result_match ? '重算结果与存档一致（结果已锁定）' : '重算结果不一致，请检查快照或版本', state.verified.result_match ? 'good' : 'err');
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* -------------------------------- 路径 ---------------------------------- */

function renderPaths() {
  const r = state.run.result;
  const paths = r.paths;
  const maxValue = Math.max(...paths.map((p) => p.value), 1);
  const crossDevicePaths = paths.filter((p) => p.cross_device > 0).length;

  const chart = chartCard({
    title: '高频转化路径',
    subtitle: '按归因价值排序的触点序列（同渠道连续出现已合并）。虚线标签为自然流量。',
    draw: (w) => {
      const rowH = 40;
      const top = 8;
      const labelW = 0;
      const height = top + paths.slice(0, 10).length * rowH + 8;
      const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      root.setAttribute('viewBox', `0 0 ${w} ${height}`);
      root.setAttribute('role', 'img');
      root.setAttribute('aria-label', '高频转化路径列表');
      paths.slice(0, 10).forEach((p, i) => {
        const y = top + i * rowH;
        const barW = (p.value / maxValue) * (w * 0.32);
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', 0); rect.setAttribute('y', y);
        rect.setAttribute('width', w); rect.setAttribute('height', rowH);
        rect.setAttribute('fill', 'transparent');
        const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar.setAttribute('x', 0); bar.setAttribute('y', y + rowH - 10);
        bar.setAttribute('width', Math.max(barW, 2)); bar.setAttribute('height', 4);
        bar.setAttribute('rx', 2);
        bar.setAttribute('fill', cssVar('--series-1'));
        bar.setAttribute('opacity', '0.5');
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', 0); label.setAttribute('y', y + 16);
        label.setAttribute('fill', cssVar('--ink-2'));
        label.setAttribute('font-size', '11.5');
        label.textContent = `${i + 1}. ${p.path_key}`;
        const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        val.setAttribute('x', w); val.setAttribute('y', y + 16);
        val.setAttribute('text-anchor', 'end');
        val.setAttribute('fill', cssVar('--ink'));
        val.setAttribute('font-size', '11.5');
        val.style.fontVariantNumeric = 'tabular-nums';
        val.textContent = `${fmtMoney(p.value)} · ${p.attributed_conversions} 笔`;
        g.append(rect, bar, label, val);
        root.append(g);
      });
      return root;
    },
    table: () => el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('caption', { text: '路径明细（含跨设备标记）' }),
        el('thead', {}, el('tr', {},
          el('th', { class: 'num', text: '#' }),
          el('th', { text: '路径' }),
          el('th', { class: 'num', text: '转化' }),
          el('th', { class: 'num', text: '价值' }),
          el('th', { class: 'num', text: '平均触点' }),
          el('th', { class: 'num', text: '跨设备' })
        )),
        el('tbody', {}, ...paths.map((p) => el('tr', {},
          el('td', { class: 'num', text: String(p.rank) }),
          el('td', { class: 'wrap' }, pathChips(p.path, 8)),
          el('td', { class: 'num', text: fmtNum(p.attributed_conversions) }),
          el('td', { class: 'num', text: fmtMoney(p.value) }),
          el('td', { class: 'num', text: (p.touch_total / Math.max(p.attributed_conversions, 1)).toFixed(1) }),
          el('td', { class: 'num', text: p.cross_device ? fmtNum(p.cross_device) : '—' })
        )))
      )
    ),
  });

  const crossDeviceCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '跨设备与归因断链' }),
      el('p', { text: '身份解析顺序：identity_id → user_id → device_id，并可经身份链接表合并。' })
    )),
    el('div', { class: 'grid cols-2', style: { gap: '12px' } },
      statTile({ label: '跨设备转化', value: fmtNum(r.totals.cross_device_conversions), note: fmtMoney(r.totals.cross_device_value) }),
      statTile({ label: '跨设备路径', value: fmtNum(crossDevicePaths), note: '出现在前 30 条路径中' }),
      statTile({ label: '身份数', value: fmtNum(r.data_quality.anomalies.identities), note: `设备 ${fmtNum(r.data_quality.anomalies.device_count)} 台` }),
      statTile({ label: '已关联设备', value: fmtNum(r.data_quality.anomalies.linked_device_count), note: '通过 identityLinks 合并' })
    ),
    el('div', { class: 'tip warn', style: { marginTop: '14px' } },
      el('span', { class: 'tip-icon', text: '⚑' }),
      el('div', {}, el('strong', { text: '未关联设备会拆散旅程。' }),
        ` 当前有 ${fmtNum(r.data_quality.anomalies.unlinked_devices)} 个设备未接入身份图；这些设备上的触点会被计入各自旅程，可能低估跨设备路径的贡献。`)
    ),
    el('div', { class: 'card-foot' },
      el('a', { href: '#/quality', class: 'small', text: '查看完整数据质量报告 →' })
    )
  );

  return [
    pageHead('转化路径', '路径由窗口内的触点按时间排序、合并连续同渠道得到；跨设备旅程已按身份合并。', [
      el('button', { class: 'btn', type: 'button', onclick: () => openExportDialog(state.run, 'paths'), text: '导出路径' }),
    ]),
    el('div', { class: 'grid side' }, chart, crossDeviceCard),
    el('section', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'card-head' }, el('div', {},
        el('h2', { text: '路径明细' }),
        el('p', { text: `共 ${paths.length} 条路径（按价值排序，前 30 条）；每条路径的转化数与价值可直接用于比对模型差异。` })
      )),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            el('th', { class: 'num', text: '#' }),
            el('th', { text: '路径' }),
            el('th', { class: 'num', text: '转化' }),
            el('th', { class: 'num', text: '价值' }),
            el('th', { class: 'num', text: '平均触点' }),
            el('th', { class: 'num', text: '跨设备' })
          )),
          el('tbody', {}, ...paths.map((p) => el('tr', {},
            el('td', { class: 'num', text: String(p.rank) }),
            el('td', { class: 'wrap' }, pathChips(p.path, 10)),
            el('td', { class: 'num', text: fmtNum(p.attributed_conversions) }),
            el('td', { class: 'num', text: fmtMoney(p.value) }),
            el('td', { class: 'num', text: (p.touch_total / Math.max(p.attributed_conversions, 1)).toFixed(1) }),
            el('td', { class: 'num', text: p.cross_device ? fmtNum(p.cross_device) : '—' })
          )))
        )
      )
    ),
  ];
}

/* ------------------------------ 贡献迁移 -------------------------------- */

async function loadCompare(otherId) {
  state.compareId = otherId;
  if (!otherId) { state.compare = null; render(); return; }
  state.compareLoading = true;
  try {
    state.compare = await api(`/api/runs/${state.runId}/compare/${otherId}`);
  } finally {
    state.compareLoading = false;
  }
  render();
}

/** 进入“贡献迁移”时默认选中第一个可对比的基线，避免空白页。 */
function maybeLoadCompare() {
  if (state.view !== 'migration') return;
  if (!state.me.user || !state.run) return;
  if (state.compare || state.compareLoading || state.compareFailed) return;
  const candidates = state.runs.filter((r) => r.id !== state.runId);
  if (!candidates.length) return;
  const target = candidates.find((r) => r.snapshot_id === state.run.snapshot_id) || candidates[0];
  state.compareId = target.id;
  state.compareLoading = true;
  api(`/api/runs/${state.runId}/compare/${target.id}`)
    .then((data) => { state.compare = data; })
    .catch((err) => { state.compareFailed = true; toast(err.message, 'err'); })
    .finally(() => { state.compareLoading = false; render(); });
}

function renderMigration() {
  const me = state.run;
  const candidates = state.runs.filter((r) => r.id !== state.runId);
  const cmp = state.compare;

  const head = pageHead('贡献迁移', '模型改版或参数变更只生成新结果；这里对比两份已锁定结果的渠道贡献差异。',
    [el('button', { class: 'btn', type: 'button', onclick: () => openExportDialog(state.run), text: '导出当前结果' })]);

  const picker = el('section', { class: 'card', style: { marginBottom: '16px' } },
    el('div', { class: 'hstack' },
      el('label', { class: 'field' },
        el('span', { text: '基线结果（旧）' }),
        (() => {
          const sel = el('select', { onchange: (e) => loadCompare(e.target.value).catch((err) => toast(err.message, 'err')) });
          sel.append(el('option', { value: '', text: '选择基线…' }));
          for (const r of candidates) {
            sel.append(el('option', {
              value: r.id,
              text: `${r.model.label || r.model_id} v${r.model_version} · ${r.label} · ${fmtDate(r.created_at)}`,
              selected: r.id === state.compareId,
            }));
          }
          return sel;
        })()
      ),
      el('div', { class: 'muted', text: '→' }),
      el('div', {},
        el('div', { class: 'tiny muted', text: '对比结果（当前）' }),
        el('div', { class: 'small', style: { marginTop: '6px' } },
          `${me.result.model.label} v${me.result.model.version} · ${me.label} · ${fmtDate(me.created_at)}`)
      )
    )
  );

  if (!cmp) {
    return [head, picker, el('div', { class: 'card' },
      el('p', { class: 'muted', text: '选择一个基线结果以查看贡献迁移。' }),
      candidates.length === 0 ? el('div', { class: 'tip', style: { marginTop: '12px' } },
        el('span', { class: 'tip-icon', text: 'ⓘ' }),
        el('div', {}, '当前快照只有一个结果。先新建另一个模型或版本的运行，才能对比迁移。')) : null
    )];
  }

  const changed = Object.entries(cmp.changes).filter(([, v]) => v).map(([k]) => ({
    model_version: '模型版本', model: '模型', params: '参数', refund_policy: '退款策略',
  }[k] || k));
  const summary = el('div', { class: 'banner' },
    el('div', { class: 'hstack' },
      badge(`${cmp.base.model.label} v${cmp.base.model.version}`, ''),
      el('span', { class: 'muted', text: '→' }),
      badge(`${cmp.compare.model.label} v${cmp.compare.model.version}`, 'accent')
    ),
    el('span', { class: 'muted', text: changed.length ? `差异来源：${changed.join('、')}` : '配置相同（仅快照或运行时不同）' }),
    el('div', { class: 'spacer' }),
    !cmp.same_snapshot ? badge('两次运行使用了不同快照，差异同时包含数据变化', 'warn', '⚑') : badge('同一输入快照', 'good', '✓')
  );

  const byChannel = new Map();
  for (const row of cmp.rows) {
    let c = byChannel.get(row.channel);
    if (!c) c = { channel: row.channel, value: 0, old_credit: 0, new_credit: 0 };
    c.value += row.delta_credit;
    c.old_credit += row.old_credit;
    c.new_credit += row.new_credit;
    byChannel.set(row.channel, c);
  }
  const channelDeltas = [...byChannel.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const chart = chartCard({
    title: '渠道贡献变化',
    subtitle: '新结果减去旧结果：蓝色为增加，红色为减少。',
    legend: [
      { label: '贡献增加', color: 'var(--pos)' },
      { label: '贡献减少', color: 'var(--neg)' },
    ],
    draw: (w) => divergingBars(w, channelDeltas.map((c) => ({
      label: channelLabel(c.channel),
      value: c.value,
      tipRows: [
        { label: '旧结果', value: fmtMoney(c.old_credit), color: 'var(--muted)' },
        { label: '新结果', value: fmtMoney(c.new_credit), color: 'var(--series-1)' },
        { label: '变化', value: fmtSignedMoney(c.value) },
      ],
      meta: `变化幅度 ${fmtPct(c.old_credit > 0 ? c.value / c.old_credit : 0)}`,
    })), { labelWidth: 92 }),
    table: () => deltaTable(cmp, channelDeltas),
  });

  const totalsTable = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '总量与口径变化' }),
      el('p', { text: '贡献迁移只解释渠道之间的重新分配；总量差异来自退款、快照或口径。' })
    )),
    el('div', { class: 'table-wrap', style: { maxHeight: 'none' } },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', { text: '指标' }),
          el('th', { class: 'num', text: '基线' }),
          el('th', { class: 'num', text: '对比' }),
          el('th', { class: 'num', text: '差异' })
        )),
        el('tbody', {},
          compareRow('已归因价值', cmp.base.totals.attributed_value, cmp.compare.totals.attributed_value, fmtMoney),
          compareRow('无法归因价值', cmp.base.unattributed.net_value, cmp.compare.unattributed.net_value, fmtMoney),
          compareRow('无法归因笔数', cmp.base.unattributed.conversions, cmp.compare.unattributed.conversions, (v) => fmtNum(v)),
          compareRow('退款冲减', cmp.base.totals.refund_clawback, cmp.compare.totals.refund_clawback, fmtMoney),
          compareRow('已归因转化数', cmp.base.totals.attributed_conversions, cmp.compare.totals.attributed_conversions, (v) => fmtNum(v))
        )
      )
    )
  );

  return [head, picker, summary, el('div', { class: 'grid side' }, chart, totalsTable),
    el('section', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'card-head' }, el('div', {},
        el('h2', { text: '迁移明细（渠道 × 广告系列）' }),
        el('p', { text: '按绝对变化排序；份额变化以百分点表示。' })
      )),
      deltaTable(cmp, null, true)
    )];
}

function fmtSignedMoney(v) {
  const n = Number(v) || 0;
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n))}`;
}

function compareRow(label, a, b, fmt) {
  const delta = b - a;
  return el('tr', {},
    el('td', { class: 'strong', text: label }),
    el('td', { class: 'num', text: fmt(a) }),
    el('td', { class: 'num', text: fmt(b) }),
    el('td', { class: `num ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : ''}`.trim(), text: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${fmt(Math.abs(delta))}` })
  );
}

function deltaTable(cmp, channelDeltas, full = false) {
  const rows = full ? cmp.rows : channelDeltas;
  return el('div', { class: 'table-wrap', style: full ? {} : { maxHeight: 'none' } },
    el('table', { class: 'data' },
      el('caption', { text: full ? '全部行；delta_credit 为绝对值变化，delta_share 为份额变化（百分点）' : '渠道级汇总' }),
      el('thead', {}, el('tr', {},
        el('th', { text: '渠道' }),
        full ? el('th', { text: '广告系列' }) : null,
        el('th', { class: 'num', text: '基线' }),
        el('th', { class: 'num', text: '对比' }),
        el('th', { class: 'num', text: '变化' }),
        el('th', { class: 'num', text: '份额变化' })
      )),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        el('td', { class: 'strong', text: channelLabel(r.channel) }),
        full ? el('td', { text: r.campaign }) : null,
        el('td', { class: 'num', text: fmtMoney(r.old_credit) }),
        el('td', { class: 'num', text: fmtMoney(r.new_credit) }),
        el('td', { class: `num ${r.delta_credit > 0 ? 'pos' : r.delta_credit < 0 ? 'neg' : ''}`.trim(), text: fmtSignedMoney(r.delta_credit) }),
        el('td', { class: 'num', text: `${r.delta_share > 0 ? '+' : r.delta_share < 0 ? '−' : ''}${(Math.abs(r.delta_share) * 100).toFixed(2)}pp` })
      )))
    )
  );
}

/* ------------------------------- 敏感性 --------------------------------- */

async function runSensitivity() {
  if (!state.run) return;
  setLoading(true);
  try {
    state.sensitivity = await api('/api/sensitivity', {
      body: {
        snapshot_id: state.snapshotId,
        model_id: state.run.model_id,
        model_version: state.run.model_version,
        params: state.run.params,
        refund_policy: state.run.refund_policy,
      },
    });
    render();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

function renderSensitivity() {
  const r = state.run.result;
  if (!state.sensitivity) {
    return [
      pageHead('敏感性', '在同一快照上改变回看窗口、自然流量口径与半衰期，观察份额区间与排名翻转。', []),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('div', {},
          el('h2', { text: '运行敏感性分析' }),
          el('p', { text: `模型 ${r.model.label} v${r.model.version} · 当前参数 ${JSON.stringify(r.params)}` })
        )),
        el('button', { class: 'btn primary', type: 'button', onclick: runSensitivity, text: '开始分析' })
      )
    ];
  }
  const s = state.sensitivity;
  const flips = s.channels.filter((c) => c.rank_flip);

  const chart = chartCard({
    title: '份额区间',
    subtitle: `在 ${s.summary.variant_count} 个参数变体下的渠道份额范围；圆点为基线值。`,
    draw: (w) => rangePlot(w, s.channels.map((c) => ({
      label: channelLabel(c.channel),
      min: c.min_share,
      max: c.max_share,
      base: c.base_share,
      tipRows: [
        { label: '区间', value: `${fmtPct(c.min_share)} – ${fmtPct(c.max_share)}`, color: 'var(--series-1)' },
        { label: '基线', value: fmtPct(c.base_share) },
        { label: '排名区间', value: `#${c.best_rank} – #${c.worst_rank}` },
      ],
      meta: c.rank_flip ? '该渠道在变体间排名发生翻转' : '排名稳定',
    })), { labelWidth: 92 }),
    table: () => el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('caption', { text: '敏感性区间（表格视图）' }),
        el('thead', {}, el('tr', {},
          el('th', { text: '渠道' }),
          el('th', { class: 'num', text: '基线份额' }),
          el('th', { class: 'num', text: '最小' }),
          el('th', { class: 'num', text: '最大' }),
          el('th', { class: 'num', text: '区间宽度' }),
          el('th', { class: 'num', text: '排名' })
        )),
        el('tbody', {}, ...s.channels.map((c) => el('tr', {},
          el('td', { class: 'strong', text: channelLabel(c.channel) }),
          el('td', { class: 'num', text: fmtPct(c.base_share) }),
          el('td', { class: 'num', text: fmtPct(c.min_share) }),
          el('td', { class: 'num', text: fmtPct(c.max_share) }),
          el('td', { class: 'num', text: `${(c.share_range * 100).toFixed(2)}pp` }),
          el('td', { class: 'num', text: `#${c.best_rank} – #${c.worst_rank}` })
        )))
      )
    ),
  });

  const variantTable = el('div', { class: 'table-wrap', style: { maxHeight: '240px', marginTop: '4px' } },
    el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', { class: 'num', text: '#' }), el('th', { text: '变体' }), el('th', { text: '参数覆盖' }))),
      el('tbody', {}, ...s.variants.map((v, i) => el('tr', {},
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', { text: v.label }),
        el('td', {}, el('code', { class: 'tiny', text: diffParams(v.params, state.run.result.params) }))
      )))
    )
  );

  const summaryCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '结论与风险' }),
      el('p', { text: '排名翻转意味着预算决策会随参数假设变化，必须先对齐口径。' })
    )),
    el('div', { class: 'vstack' },
      flips.length
        ? el('div', { class: 'tip warn' },
          el('span', { class: 'tip-icon', text: '⚑' }),
          el('div', {}, el('strong', { text: `${flips.length} 个渠道排名发生翻转：` }), flips.map((c) => channelLabel(c.channel)).join('、'),
            '。这些渠道的预算结论对参数敏感。'))
        : el('div', { class: 'tip good' },
          el('span', { class: 'tip-icon', text: '✓' }),
          el('div', {}, el('strong', { text: '所有渠道排名稳定。' }), '当前参数区间内结论一致。')),
      el('div', { class: 'tip' },
        el('span', { class: 'tip-icon', text: 'ⓘ' }),
        el('div', {}, el('strong', { text: `最大份额波动 ${(s.summary.max_share_range * 100).toFixed(1)}pp。` }),
          ' 波动越大，说明该渠道的贡献越依赖窗口与自然流量口径。')),
      el('div', { class: 'section-label', text: '变体参数' }),
      variantTable,
    )
  );

  return [
    pageHead('敏感性', '同一快照下的参数扰动实验；不会创建新结果，也不影响已锁定的运行。', [
      el('button', { class: 'btn', type: 'button', onclick: runSensitivity, text: '重新计算' }),
    ]),
    el('div', { class: 'grid side' }, chart, summaryCard),
    el('section', { class: 'card', style: { marginTop: '16px' } },
      el('div', { class: 'card-head' }, el('div', {},
        el('h2', { text: '各变体的渠道份额' }),
        el('p', { text: '横向阅读可看出参数选择如何改变结论。' })
      )),
      variantMatrix(s)
    )
  ];
}

function diffParams(params, base) {
  const diffs = [];
  for (const [k, v] of Object.entries(params)) {
    if (JSON.stringify(v) !== JSON.stringify(base[k])) diffs.push(`${k}=${typeof v === 'boolean' ? (v ? '是' : '否') : v}`);
  }
  return diffs.length ? diffs.join(' · ') : '基线';
}

function variantMatrix(s) {
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', { text: '变体' }),
        ...s.channels.slice(0, 10).map((c) => el('th', { class: 'num', text: channelLabel(c.channel) }))
      )),
      el('tbody', {}, ...s.variants.map((v, i) => {
        const run = s.variant_rows ? s.variant_rows[i] : null;
        return el('tr', {},
          el('td', { text: v.label }),
          ...s.channels.slice(0, 10).map((c) => el('td', {
            class: `num ${run && run[c.channel] === undefined ? 'muted' : ''}`.trim(),
            text: run && run[c.channel] !== undefined ? fmtPct(run[c.channel]) : '—',
          }))
        );
      }))
    )
  );
}

/* ------------------------------ 数据质量 -------------------------------- */

function renderQuality() {
  const r = state.run.result;
  const dq = r.data_quality || { anomalies: {}, lateSamples: [], duplicateSamples: [] };
  const a = dq.anomalies || {};

  const summary = el('div', { class: 'grid cols-4' },
    qualityTile('重复事件（已去重）', a.duplicate_events, '按 event_id 与自然键判重', a.duplicate_events ? 'warn' : ''),
    qualityTile('重复转化（已去重）', a.duplicate_conversions, '同一 conversion_id / 订单只计一次', a.duplicate_conversions ? 'warn' : ''),
    qualityTile('迟到转化（>24h）', a.late_conversions, '回传时间晚于转化时间，仍计入归因', a.late_conversions ? 'warn' : ''),
    qualityTile('脏数据（丢弃）', (a.missing_identity || 0) + (a.invalid_time || 0), '缺身份或时间戳非法，未进入旅程', 'critical'),
  );

  const lateCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '迟到转化' }),
      el('p', { text: '转化发生后才回传的事件不会回溯改变已锁定结果；如需重算请生成新快照与新运行。' })
    )),
    dq.lateSamples.length
      ? el('div', { class: 'table-wrap', style: { maxHeight: '360px' } },
        el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            el('th', { text: '转化' }),
            el('th', { text: '转化时间' }),
            el('th', { class: 'num', text: '延迟' }),
            el('th', { text: '回传时间' }),
            el('th', { class: 'num', text: '价值' })
          )),
          el('tbody', {}, ...dq.lateSamples.map((c) => el('tr', {},
            el('td', {}, el('code', { text: c.conversion_id })),
            el('td', { text: fmtDateTime(c.ts_iso) }),
            el('td', { class: 'num' }, badge(`${c.lag_hours}h`, 'warn')),
            el('td', { text: c.received_at ? fmtDateTime(c.received_at) : '—' }),
            el('td', { class: 'num', text: fmtMoney(c.value) })
          )))
        )
      )
      : el('p', { class: 'muted small', text: '没有迟到转化。' }),
    el('div', { class: 'card-foot', text: `迟到转化影响的归因价值：${fmtMoney(r.totals.late_conversion_value)}（${r.totals.late_conversions} 笔）` })
  );

  const dupCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '重复事件样本' }),
      el('p', { text: '同一事件 ID / 同一自然键重复到达时只保留首条，样本仅供排查埋点。' })
    )),
    dq.duplicateSamples.length
      ? el('div', { class: 'table-wrap', style: { maxHeight: '360px' } },
        el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            el('th', { text: '类型' }),
            el('th', { text: '键' }),
            el('th', { text: '渠道 / 价值' }),
            el('th', { text: '时间' })
          )),
          el('tbody', {}, ...dq.duplicateSamples.map((d) => el('tr', {},
            el('td', {}, badge(d.kind === 'event' ? '事件' : '转化', '')),
            el('td', {}, el('code', { class: 'tiny', text: d.key })),
            el('td', { text: d.kind === 'event' ? channelLabel(d.channel) : fmtMoney(d.value) }),
            el('td', { text: fmtDateTime(new Date(d.ts).toISOString()) })
          )))
        )
      )
      : el('p', { class: 'muted small', text: '没有重复事件。' }),
  );

  const verifyCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '结果可复算性' }),
      el('p', { text: '用存档快照重跑同一模型版本与参数，核对结果哈希；这是版本锁定的验收项。' })
    )),
    el('div', { class: 'kv' },
      el('span', {}, el('b', { text: '快照哈希 ' }), el('code', { text: state.run.snapshot_hash })),
      el('span', {}, el('b', { text: '结果哈希 ' }), el('code', { text: state.run.result_hash }))
    ),
    el('div', { class: 'hstack', style: { marginTop: '12px' } },
      el('button', { class: 'btn primary', type: 'button', onclick: verifyRun, text: '重算并校验' }),
      state.verified ? badge(state.verified.result_match ? '一致' : '不一致', state.verified.result_match ? 'good' : 'critical', state.verified.result_match ? '✓' : '✕') : null
    ),
    state.verified ? el('div', { class: 'tip good', style: { marginTop: '12px' } },
      el('span', { class: 'tip-icon', text: '✓' }),
      el('div', {}, `重算哈希 ${state.verified.result_hash_recomputed.slice(0, 12)}… · 快照${state.verified.snapshot_match ? '匹配' : '不匹配'} · 渠道行${state.verified.channel_rows_match ? '逐行一致' : '存在差异'}`)
    ) : null
  );

  return [
    pageHead('数据质量', '重复事件、迟到转化与脏数据都在归并阶段处理；此处展示计数与样本。', [
      el('button', { class: 'btn', type: 'button', onclick: verifyRun, text: '校验结果' }),
    ]),
    summary,
    el('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, lateCard, dupCard),
    el('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, verifyCard, rawStatsCard(a))
  ];
}

function qualityTile(label, value, note, kind = '') {
  return el('section', { class: 'card' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', style: { marginTop: '4px' } }, fmtNum(value)),
    el('div', { class: 'stat-note' },
      kind === 'critical' ? el('span', { class: 'dot', style: { background: 'var(--critical)' } }) : null,
      kind === 'warn' ? el('span', { class: 'dot', style: { background: 'var(--warning)' } }) : null,
      note
    )
  );
}

function rawStatsCard(a) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '归并统计' }),
      el('p', { text: '原始行数 → 去重后行数；未归并的记录不会进入归因。' })
    )),
    el('div', { class: 'table-wrap', style: { maxHeight: 'none' } },
      el('table', { class: 'data' },
        el('tbody', {},
          statRow('原始事件', a.raw_events),
          statRow('去重后事件', a.deduped_events),
          statRow('原始转化', a.raw_conversions),
          statRow('去重后转化', a.deduped_conversions),
          statRow('身份数', a.identities),
          statRow('设备数', a.device_count),
          statRow('已关联设备', a.linked_device_count),
          statRow('未关联设备', a.unlinked_devices),
          statRow('数据区间', `${fmtDate(new Date(a.first_event_ts).toISOString())} – ${fmtDate(new Date(a.last_event_ts).toISOString())}`)
        )
      )
    )
  );
}

function statRow(label, value) {
  return el('tr', {},
    el('td', { text: label }),
    el('td', { class: 'num strong', text: typeof value === 'number' ? fmtNum(value) : String(value) })
  );
}

/* ---------------------------- 导出与权限 -------------------------------- */

function renderAccess() {
  const permissions = state.me.roles;
  const entries = state.audit || [];
  if (state.me.user && !state.auditStarted) {
    state.auditStarted = true;
    api('/api/audit').then((data) => { state.audit = data.entries; render(); }).catch(() => {});
  }
  const run = state.run;

  const exportCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '导出' }),
      el('p', { text: '导出文件带快照哈希、模型版本、参数哈希与结果哈希，便于下游复核。' })
    )),
    run
      ? el('div', { class: 'vstack' },
        el('div', { class: 'hstack' },
          el('button', { class: 'btn', type: 'button', disabled: !can('csv'), onclick: () => download(`/api/runs/${run.id}/export.csv?view=channels`), text: '渠道 CSV' }),
          el('button', { class: 'btn', type: 'button', disabled: !can('csv'), onclick: () => download(`/api/runs/${run.id}/export.csv?view=conversions`), text: '转化明细 CSV' }),
          el('button', { class: 'btn', type: 'button', disabled: !can('csv'), onclick: () => download(`/api/runs/${run.id}/export.csv?view=paths`), text: '路径 CSV' }),
          el('button', { class: 'btn', type: 'button', disabled: !can('json'), onclick: () => download(`/api/runs/${run.id}/export.json`), text: '完整 JSON' })
        ),
        !can('csv') ? el('div', { class: 'tip warn' },
          el('span', { class: 'tip-icon', text: '⚑' }),
          el('div', {}, el('strong', { text: '当前角色不可导出。' }), ' 查看者只能浏览结果；导出能力由管理员授予。')) : null,
        el('div', { class: 'tiny muted', text: '每次导出都会写入审计日志（操作者、格式、行数）。' })
      )
      : el('p', { class: 'muted small', text: '当前没有可导出的结果。' })
  );

  const matrixCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '角色权限矩阵' }),
      el('p', { text: '权限在服务端校验；按钮禁用只是提示，接口同样会拒绝越权请求。' })
    )),
    el('div', { class: 'table-wrap', style: { maxHeight: 'none' } },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', { text: '角色' }),
          el('th', { text: '新建运行' }),
          el('th', { text: '上传快照' }),
          el('th', { text: 'CSV' }),
          el('th', { text: 'JSON' }),
          el('th', { text: '审计日志' })
        )),
        el('tbody', {}, ...permissions.map((p) => el('tr', {},
          el('td', { class: 'strong' }, p.label, state.me.user && state.me.user.role === p.id ? el('span', { class: 'sub', text: ' · 你' }) : null),
          el('td', {}, yn(p.can_run)),
          el('td', {}, yn(p.can_upload)),
          el('td', {}, yn(p.can_export_csv)),
          el('td', {}, yn(p.can_export_json)),
          el('td', {}, yn(p.can_export_audit))
        )))
      )
    )
  );

  const auditCard = el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {},
      el('h2', { text: '审计日志' }),
      el('p', { text: '登录、运行、校验与导出都会记录。' })
    ),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn small', type: 'button', disabled: !can('audit'), onclick: () => download('/api/audit/export.csv'), text: '导出审计 CSV' })
    ),
    entries.length
      ? el('div', { class: 'table-wrap', style: { maxHeight: '420px' } },
        el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            el('th', { text: '时间' }),
            el('th', { text: '操作者' }),
            el('th', { text: '动作' }),
            el('th', { text: '对象' })
          )),
          el('tbody', {}, ...entries.map((e) => el('tr', {},
            el('td', { class: 'nowrap', text: fmtDateTime(e.ts) }),
            el('td', { text: e.user_name }),
            el('td', {}, el('code', { class: 'tiny', text: e.action })),
            el('td', {}, el('code', { class: 'tiny', text: `${e.object_type}/${e.object_id || '—'}` }))
          )))
        )
      )
      : el('p', { class: 'muted small', text: '暂无记录。' })
  );

  return [
    pageHead('导出与权限', '按角色控制导出范围；所有操作留痕。', [
      el('button', { class: 'btn', type: 'button', onclick: openLoginDialog, text: '切换身份' }),
    ]),
    el('div', { class: 'grid cols-2' }, exportCard, matrixCard),
    el('section', { style: { marginTop: '16px' } }, auditCard),
  ];
}

function yn(v) {
  return v ? el('span', { class: 'pos', text: '✓ 是' }) : el('span', { class: 'muted', text: '— 否' });
}

function download(url) {
  const a = el('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    if (state.view === 'access') {
      api('/api/audit').then((d) => { state.audit = d.entries; render(); }).catch(() => {});
    }
  }, 400);
}

/* ------------------------------- 页头 ---------------------------------- */

function pageHead(title, subtitle, actions = []) {
  return el('div', { class: 'view-head' },
    el('div', {},
      el('h1', { text: title }),
      el('p', { text: subtitle })
    ),
    el('div', { class: 'spacer' }),
    el('div', { class: 'hstack' }, ...actions.filter(Boolean))
  );
}

/* ------------------------------ 运行弹窗 -------------------------------- */

function openRunDialog() {
  if (!can('run')) {
    toast('当前角色不能新建运行，请切换为分析师或管理员', 'err');
    return;
  }
  const form = $('#run-form');
  form.reset();
  const modelSel = $('#rf-model');
  const versionSel = $('#rf-version');
  modelSel.replaceChildren();
  for (const m of state.meta.models) {
    modelSel.append(el('option', { value: m.id, text: m.label, selected: m.id === (state.run?.model_id || 'last_touch') }));
  }
  const fillVersions = () => {
    const model = state.meta.models.find((m) => m.id === modelSel.value);
    versionSel.replaceChildren();
    for (const v of model.versions) {
      versionSel.append(el('option', { value: v.version, text: `v${v.version}${v.supersedes ? ' · 口径修订' : ''}`, selected: v.version === model.latest_version }));
    }
    fillParams();
  };
  const fillParams = () => renderRunParams();
  modelSel.onchange = fillVersions;
  versionSel.onchange = fillParams;

  const refundSel = $('#rf-refund');
  refundSel.replaceChildren();
  for (const p of state.meta.refund_policies) {
    refundSel.append(el('option', { value: p.id, text: `${p.label} — ${p.description}`, selected: p.id === 'clawback' }));
  }

  const superSel = $('#rf-supersedes');
  superSel.replaceChildren(el('option', { value: '', text: '不替代（新建独立结果）' }));
  for (const r of runsForSnapshot(state.snapshotId)) {
    superSel.append(el('option', { value: r.id, text: `${r.model.label || r.model_id} v${r.model_version} · ${r.label}` }));
  }

  fillVersions();
  $('#rf-label').value = '';
  $('#rf-foot-hint').textContent = `快照：${state.snapshotId}`;
  $('#run-dialog').showModal();
}

function renderRunParams() {
  const host = $('#rf-params');
  const modelId = $('#rf-model').value;
  const version = $('#rf-version').value;
  const model = state.meta.models.find((m) => m.id === modelId);
  const spec = model.versions.find((v) => v.version === version) || model;
  host.replaceChildren();
  host.append(el('div', { class: 'section-label', text: '模型参数' }));
  const grid = el('div', { class: 'form-grid' });
  for (const [key, p] of Object.entries(spec.params)) {
    if (p.type === 'bool') {
      const id = `param-${key}`;
      grid.append(el('label', { class: 'check full', for: id },
        el('input', { type: 'checkbox', id, name: key, checked: p.default }),
        `${p.label} `,
        el('code', { class: 'tiny', text: key })
      ));
    } else {
      const id = `param-${key}`;
      grid.append(el('div', { class: 'form-field' },
        el('label', { for: id, text: p.label }),
        el('input', {
          type: 'number', id, name: key, value: p.default,
          min: p.min, max: p.max, step: p.type === 'int' ? 1 : 'any',
        }),
        el('div', { class: 'help', text: `默认 ${p.default}${p.min !== undefined ? ` · 范围 ${p.min}–${p.max}` : ''}` })
      ));
    }
  }
  host.append(grid);
  if (spec.caveat) {
    host.append(el('div', { class: 'tip', style: { marginTop: '14px' } },
      el('span', { class: 'tip-icon', text: 'ⓘ' }),
      el('div', {}, el('strong', { text: '口径说明：' }), spec.caveat)));
  }
}

async function submitRun(evt) {
  evt.preventDefault();
  const form = $('#run-form');
  const params = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (key.startsWith('rf-')) continue;
    params[key] = value;
  }
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    params[input.name] = input.checked;
  }
  const body = {
    snapshot_id: state.snapshotId,
    model_id: $('#rf-model').value,
    model_version: $('#rf-version').value,
    params,
    refund_policy: $('#rf-refund').value,
    label: $('#rf-label').value.trim() || undefined,
    supersedes: $('#rf-supersedes').value || null,
  };
  try {
    setLoading(true);
    const created = await api('/api/runs', { body });
    $('#run-dialog').close();
    await reloadMeta();
    state.runId = created.id;
    state.run = await api(`/api/runs/${created.id}`);
    state.sensitivity = null;
    state.verified = null;
    localStorage.setItem('attr.runId', created.id);
    toast(created.deduped ? '已存在相同配置的结果，直接复用（未覆盖历史）' : '新结果已生成并锁定', 'good');
    render();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

/* ------------------------------ 导出弹窗 -------------------------------- */

function openExportDialog(run, view = 'channels') {
  const body = $('#export-body');
  body.replaceChildren();
  if (!run) { toast('没有可导出的结果', 'err'); return; }
  const views = [
    { id: 'channels', label: '渠道 × 广告系列', desc: '默认口径，含份额、触点、退款冲减。' },
    { id: 'conversions', label: '转化明细', desc: '每笔转化的状态、净值与触点分配。' },
    { id: 'paths', label: '转化路径', desc: '路径序列、价值与跨设备计数。' },
    { id: 'unattributed', label: '无法归因', desc: '单独统计的无法归因转化，含原因。' },
  ];
  body.append(el('div', { class: 'kv', style: { marginBottom: '14px' } },
    el('span', {}, el('b', { text: '运行 ' }), el('code', { text: run.id })),
    el('span', {}, el('b', { text: '快照 ' }), el('code', { text: run.snapshot_hash })),
    el('span', {}, el('b', { text: '参数 ' }), el('code', { text: run.param_hash })),
    el('span', {}, el('b', { text: '结果 ' }), el('code', { text: run.result_hash }))
  ));
  const rows = views.map((v) => el('div', { class: 'run-item' },
    el('div', { class: 'run-main' },
      el('div', { class: 'run-name', text: v.label }),
      el('div', { class: 'run-meta', text: v.desc })
    ),
    el('button', {
      class: 'btn small', type: 'button', disabled: !can('csv'),
      onclick: () => download(`/api/runs/${run.id}/export.csv?view=${v.id}`),
      text: 'CSV',
    })
  ));
  rows.push(el('div', { class: 'run-item' },
    el('div', { class: 'run-main' },
      el('div', { class: 'run-name', text: '完整结果 JSON' }),
      el('div', { class: 'run-meta', text: '包含参数、全部渠道行、转化行与路径；仅管理员可导出。' })
    ),
    el('button', {
      class: 'btn small', type: 'button', disabled: !can('json'),
      onclick: () => download(`/api/runs/${run.id}/export.json`),
      text: 'JSON',
    })
  ));
  body.append(el('div', { class: 'run-list' }, ...rows));
  if (!can('csv')) {
    body.append(el('div', { class: 'tip warn', style: { marginTop: '14px' } },
      el('span', { class: 'tip-icon', text: '⚑' }),
      el('div', {}, el('strong', { text: '当前角色不可导出。' }), ' 切换到分析师或管理员以启用。')));
  }
  $('#export-dialog').showModal();
}

/* -------------------------------- 启动 ---------------------------------- */

async function boot() {
  initTooltip();
  bindChrome();
  const hash = (location.hash || '#/overview').replace('#/', '');
  state.view = viewRenderers[hash] ? hash : 'overview';

  try {
    await refreshMe();
    if (!state.me.user) {
      renderUser();
      render();
      openLoginDialog();
      return;
    }
    await reloadMeta();
    state.run = state.runId ? await api(`/api/runs/${state.runId}`) : null;
    render();
  } catch (err) {
    $('#main').replaceChildren(el('div', { class: 'card' },
      el('h2', { text: '加载失败' }),
      el('p', { class: 'muted', text: err.message }),
      el('button', { class: 'btn', type: 'button', onclick: () => location.reload(), text: '重试' })));
  }
}

function bindChrome() {
  $('#user-select').addEventListener('change', (e) => login(e.target.value).catch((err) => toast(err.message, 'err')));
  $('#snapshot-select').addEventListener('change', (e) => selectSnapshot(e.target.value).catch((err) => toast(err.message, 'err')));
  $('#run-select').addEventListener('change', (e) => selectRun(e.target.value).catch((err) => toast(err.message, 'err')));
  $('#run-form').addEventListener('submit', submitRun);
  $('#run-dialog').addEventListener('close', () => {});
  for (const btn of document.querySelectorAll('[data-close-dialog]')) {
    btn.addEventListener('click', () => document.getElementById(btn.dataset.closeDialog).close());
  }
  $('#new-run-button').addEventListener('click', () => openRunDialog());
  $('#logout-button').addEventListener('click', () => login('').catch((err) => toast(err.message, 'err')));
  $('#theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : current === 'light' ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('attr.theme', next);
    render();
  });
  const savedTheme = localStorage.getItem('attr.theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

  window.addEventListener('hashchange', () => {
    const v = (location.hash || '#/overview').replace('#/', '');
    state.view = viewRenderers[v] ? v : 'overview';
    render();
    window.scrollTo({ top: 0 });
  });
  window.addEventListener('resize', () => {});
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideTip(); }
  });
}

boot();
