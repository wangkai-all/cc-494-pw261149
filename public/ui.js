/* ==========================================================================
   图表原语：纯 SVG，无依赖。
   规范：细线条、4px 圆角数据端（基线端为方角）、2px 表面间隙、
        发丝网格、直接标注只用于关键值、悬停/聚焦显示同源提示。
   ========================================================================== */

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];

/** 按当前主题取分类色（浅/深色分别取对应步进，避免自动翻转导致对比度不足）。 */
export function seriesColor(i) {
  return cssVar(`--series-${(i % 3) + 1}`) || SERIES[i % 3];
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ------------------------------- 数字格式 -------------------------------- */

export function fmtMoney(v, opts = {}) {
  const n = Number(v) || 0;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (opts.full) return `${sign}¥${a.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (a >= 1e8) return `${sign}¥${(a / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${sign}¥${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  if (a >= 1000) return `${sign}¥${a.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
  return `${sign}¥${a.toFixed(a < 10 ? 2 : 0)}`;
}

export function fmtNum(v, digits = 0) {
  const n = Number(v) || 0;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(v, digits = 1) {
  const n = Number(v) || 0;
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtSigned(v) {
  const n = Number(v) || 0;
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n))}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const CHANNEL_LABEL = {
  paid_search: '付费搜索',
  paid_social: '付费社交',
  display: '展示广告',
  affiliate: '联盟',
  email: '邮件',
  organic_search: '自然搜索',
  direct: '直接访问',
  referral: '外部引荐',
};

export function channelLabel(key) {
  return CHANNEL_LABEL[key] || key;
}

export const REASON_LABEL = {
  no_touch: '本旅程无任何触点',
  no_touch_in_window: '触点均在回看窗口外',
  direct_excluded_only: '仅直接访问触点，已被参数排除',
  organic_excluded_only: '仅自然流量触点，已被参数排除',
  zero_value: '转化价值为 0',
  fully_refunded: '退款后净额为 0',
  refund_policy_exclude: '含退款，按策略整单剔除',
  zero_weight: '触点权重为 0',
};

/* -------------------------------- 提示层 -------------------------------- */

let tipEl;

export function initTooltip() {
  tipEl = document.getElementById('tooltip');
}

export function showTip(evt, title, rows, note) {
  if (!tipEl) return;
  tipEl.replaceChildren();
  if (title) tipEl.append(el('div', { class: 'tt-title', text: title }));
  for (const r of rows || []) {
    tipEl.append(
      el('div', { class: 'tt-row' },
        el('span', { class: 'tt-key' },
          r.color ? el('span', { class: 'tt-line', style: { background: r.color } }) : null,
          el('span', { text: r.label })
        ),
        el('span', { class: 'tt-val', text: r.value })
      )
    );
  }
  if (note) tipEl.append(el('div', { class: 'tt-note', text: note }));
  tipEl.classList.add('show');
  const pad = 14;
  const rect = tipEl.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() {
  if (tipEl) tipEl.classList.remove('show');
}

/** 给图元绑定指针与键盘提示，键盘焦点与悬停等价。 */
export function bindTip(node, content) {
  node.addEventListener('pointermove', (e) => showTip(e, ...content()));
  node.addEventListener('pointerenter', (e) => showTip(e, ...content()));
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip({ clientX: r.right, clientY: r.top + r.height / 2 }, ...content());
  });
  node.addEventListener('blur', hideTip);
}

/* ------------------------------ 图形基元 -------------------------------- */

/** 横向条形：右端圆角，基线端方角。 */
export function barPath(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  if (rr === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y}h${w - rr}q${rr},0 ${rr},${rr}v${h - 2 * rr}q0,${rr} ${-rr},${rr}h${-(w - rr)}Z`;
}

/** 向左延伸的条形：左端（数据端）圆角，右端（零基线）方角。 */
export function barPathLeft(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  if (rr === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y}h${w - rr}q${rr},0 ${rr},${rr}v${h - 2 * rr}q0,${rr} ${-rr},${rr}h${-(w - rr)}Z`;
}

/** 纵向条形：顶端圆角，基线端方角。 */
export function vBarPath(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, h, w / 2));
  if (rr === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + rr}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}h${-w}Z`;
}

export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(Number(t.toFixed(10)));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function compact(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(1)}亿`;
  if (a >= 1e4) return `${s}${(a / 1e4).toFixed(a >= 1e5 ? 0 : 1)}万`;
  if (a >= 1000) return `${s}${(a / 1000).toFixed(a % 1000 === 0 ? 0 : 1)}k`;
  return `${s}${a % 1 === 0 ? a : a.toFixed(1)}`;
}

/* ------------------------------ 图表卡片 -------------------------------- */

/**
 * 可重绘的图表容器：宽度变化时重绘；提供“图表 / 表格”无障碍切换。
 */
export function chartCard({ title, subtitle, legend, draw, table, actions, note }) {
  let mode = 'chart';
  const body = el('div', { class: 'card-body' });
  const legendRow = el('div', { class: 'legend', hidden: true });
  const toggle = el('div', { class: 'chart-toggle', role: 'group', 'aria-label': '视图切换' });
  const chartBtn = el('button', { type: 'button', 'aria-pressed': 'true', text: '图表' });
  const tableBtn = el('button', { type: 'button', 'aria-pressed': 'false', text: '表格' });
  toggle.append(chartBtn, tableBtn);

  let observer;
  let lastWidth = 0;
  let chartHost = el('div', { class: 'chart' });

  function paint(force = false) {
    if (mode === 'table') return;
    const w = chartHost.clientWidth;
    if (!w) return;
    if (!force && w === lastWidth && chartHost.childElementCount) return;
    lastWidth = w;
    try {
      chartHost.replaceChildren(draw(w));
    } catch (err) {
      console.error(err);
      chartHost.replaceChildren(el('p', { class: 'muted small', text: '图表渲染失败，请切换表格视图。' }));
    }
  }

  function setMode(next) {
    mode = next;
    chartBtn.setAttribute('aria-pressed', String(mode === 'chart'));
    tableBtn.setAttribute('aria-pressed', String(mode === 'table'));
    legendRow.hidden = mode !== 'chart' || !legend;
    if (mode === 'chart') {
      body.replaceChildren(chartHost);
      lastWidth = 0;
      paint(true);
    } else {
      body.replaceChildren(table());
    }
  }

  chartBtn.addEventListener('click', () => setMode('chart'));
  tableBtn.addEventListener('click', () => setMode('table'));

  if (legend) {
    legendRow.hidden = false;
    for (const item of legend) {
      legendRow.append(
        el('span', { class: 'legend-item' },
          el('span', { class: 'swatch', style: { background: item.color } }),
          item.label
        )
      );
    }
  }

  const card = el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h2', { text: title }),
        subtitle ? el('p', { text: subtitle }) : null
      ),
      el('div', { class: 'spacer' }),
      actions || null,
      toggle
    ),
    body,
    legendRow,
    note ? el('div', { class: 'card-foot', text: note }) : null
  );

  body.append(chartHost);
  queueMicrotask(() => {
    paint(true);
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => paint());
      observer.observe(chartHost);
    }
  });
  return card;
}

/* --------------------------- 具体图表：横向条形 --------------------------- */

/**
 * @param {number} width
 * @param {{label:string, value:number, color:string, meta?:string}[]} rows
 */
export function horizontalBars(width, rows, { format = fmtMoney, labelWidth = 128, barHeight = 20, gap = 10 } = {}) {
  const padRight = 68;
  const padTop = 6;
  const plotW = Math.max(60, width - labelWidth - padRight);
  const height = padTop + rows.length * (barHeight + gap) + 26;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1] || 1;
  const scale = (v) => (v / top) * plotW;
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '渠道贡献条形图' });

  for (const t of ticks) {
    const x = labelWidth + scale(t);
    root.append(
      svg('line', { class: 'grid-line', x1: x, x2: x, y1: padTop, y2: height - 22 }),
      svg('text', { class: 'axis-label', x, y: height - 6, 'text-anchor': 'middle', text: compact(t) })
    );
  }

  rows.forEach((r, i) => {
    const y = padTop + i * (barHeight + gap);
    const w = Math.max(scale(Math.abs(r.value)), 1);
    const g = svg('g', { class: 'group', tabindex: '0', role: 'img', 'aria-label': `${r.label} ${format(r.value)}` });
    g.append(svg('rect', { class: 'hit', x: 0, y: y - gap / 2, width, height: barHeight + gap, rx: 4 }));
    g.append(svg('text', { class: 'cat-label', x: labelWidth - 10, y: y + barHeight * 0.7, 'text-anchor': 'end', text: r.label }));
    g.append(svg('path', { class: 'bar', d: barPath(labelWidth, y, w, barHeight, 4), fill: r.color }));
    g.append(svg('text', { class: 'value-label', x: labelWidth + w + 8, y: y + barHeight * 0.7, text: format(r.value) }));
    bindTip(g, () => [r.label, [{ label: '归因贡献', value: format(r.value), color: r.color }, ...(r.tipRows || [])], r.meta]);
    root.append(g);
  });
  root.append(svg('line', { class: 'baseline', x1: labelWidth, x2: labelWidth, y1: padTop, y2: height - 22 }));
  return root;
}

/* --------------------------- 发散条形（迁移） ---------------------------- */

export function divergingBars(width, rows, { format = fmtMoney, labelWidth = 132 } = {}) {
  const rowH = 22;
  const gap = 12;
  const padTop = 10;
  const height = padTop + rows.length * (rowH + gap) + 28;
  const plotW = width - labelWidth - 20;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const ticks = niceTicks(max, 2);
  const top = ticks[ticks.length - 1] || 1;
  const zeroX = labelWidth + plotW / 2;
  const scale = (v) => (v / top) * (plotW / 2);
  const posColor = cssVar('--pos');
  const negColor = cssVar('--neg');
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '渠道贡献迁移发散条形图' });

  for (const t of ticks) {
    for (const sign of t === 0 ? [1] : [1, -1]) {
      const x = zeroX + sign * scale(t);
      root.append(svg('line', { class: 'grid-line', x1: x, x2: x, y1: padTop, y2: height - 24 }));
      root.append(svg('text', { class: 'axis-label', x, y: height - 8, 'text-anchor': 'middle', text: sign < 0 ? `−${compact(t)}` : compact(t) }));
    }
  }
  rows.forEach((r, i) => {
    const y = padTop + i * (rowH + gap);
    const val = r.value;
    const w = Math.abs(scale(val));
    const color = val >= 0 ? posColor : negColor;
    const x = val >= 0 ? zeroX : zeroX - w;
    const g = svg('g', { class: 'group', tabindex: '0', role: 'img', 'aria-label': `${r.label} 贡献变化 ${format(val)}` });
    g.append(svg('rect', { class: 'hit', x: 0, y: y - gap / 2, width, height: rowH + gap }));
    g.append(svg('text', { class: 'cat-label', x: labelWidth - 10, y: y + rowH * 0.7, 'text-anchor': 'end', text: r.label }));
    if (w > 0.5) {
      const d = val >= 0
        ? barPath(x, y, Math.max(w, 1.5), rowH, 4)
        : barPathLeft(x, y, Math.max(w, 1.5), rowH, 4);
      g.append(svg('path', { class: 'bar', d, fill: color }));
    }
    const labelX = val >= 0 ? x + w + 7 : x - 7;
    g.append(svg('text', {
      class: 'value-label', x: labelX, y: y + rowH * 0.7,
      'text-anchor': val >= 0 ? 'start' : 'end',
      text: `${val > 0 ? '+' : val < 0 ? '−' : ''}${compact(Math.abs(val))}`,
    }));
    bindTip(g, () => [r.label, r.tipRows || [], r.meta]);
    root.append(g);
  });
  root.append(svg('line', { class: 'zero-line', x1: zeroX, x2: zeroX, y1: padTop, y2: height - 24 }));
  return root;
}

/* --------------------------- 区间图（敏感性） ---------------------------- */

export function rangePlot(width, rows, { labelWidth = 132, label = '份额' } = {}) {
  const rowH = 14;
  const gap = 20;
  const padTop = 14;
  const height = padTop + rows.length * (rowH + gap) + 30;
  const plotW = width - labelWidth - 76;
  const max = Math.max(...rows.map((r) => r.max), 0.0001);
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1] || 1;
  const scale = (v) => (v / top) * plotW;
  const dot = cssVar('--series-1');
  const range = cssVar('--series-1');
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `敏感性分析区间图：${label}` });

  for (const t of ticks) {
    const x = labelWidth + scale(t);
    root.append(svg('line', { class: 'grid-line', x1: x, x2: x, y1: padTop, y2: height - 24 }));
    root.append(svg('text', { class: 'axis-label', x, y: height - 8, 'text-anchor': 'middle', text: fmtPct(t, 0) }));
  }
  rows.forEach((r, i) => {
    const y = padTop + i * (rowH + gap) + rowH / 2;
    const x1 = labelWidth + scale(r.min);
    const x2 = labelWidth + scale(r.max);
    const xb = labelWidth + scale(r.base);
    const g = svg('g', { class: 'group', tabindex: '0', role: 'img', 'aria-label': `${r.label} 份额区间 ${fmtPct(r.min)} 到 ${fmtPct(r.max)}` });
    g.append(svg('rect', { class: 'hit', x: 0, y: y - (rowH + gap) / 2, width, height: rowH + gap }));
    g.append(svg('text', { class: 'cat-label', x: labelWidth - 10, y: y + 4, 'text-anchor': 'end', text: r.label }));
    g.append(svg('line', {
      x1, x2, y1: y, y2: y,
      stroke: range, 'stroke-width': 6, 'stroke-linecap': 'round', opacity: 0.22,
    }));
    g.append(svg('circle', { cx: xb, cy: y, r: 4.5, fill: dot, stroke: cssVar('--surface'), 'stroke-width': 2 }));
    g.append(svg('text', { class: 'value-label', x: width - 4, y: y + 4, 'text-anchor': 'end', text: fmtPct(r.base) }));
    bindTip(g, () => [r.label, r.tipRows || [], r.meta]);
    root.append(g);
  });
  root.append(svg('line', { class: 'baseline', x1: labelWidth, x2: labelWidth, y1: padTop, y2: height - 24 }));
  return root;
}

/* ------------------------------- 折线 ---------------------------------- */

export function sparkline(width, values, { height = 44 } = {}) {
  const n = values.length;
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '按日归因价值趋势' });
  if (n < 2) return root;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const xAt = (i) => (i / (n - 1)) * (width - 4) + 2;
  const yAt = (v) => height - 4 - ((v - min) / (max - min || 1)) * (height - 10);
  let d = '';
  values.forEach((v, i) => {
    d += `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
  });
  root.append(svg('path', { d: `${d}L${xAt(n - 1)},${height}L${xAt(0)},${height}Z`, fill: cssVar('--series-1'), opacity: 0.1 }));
  root.append(svg('path', { d, fill: 'none', stroke: cssVar('--series-1'), 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  root.append(svg('circle', {
    cx: xAt(n - 1), cy: yAt(values[n - 1]), r: 4,
    fill: cssVar('--series-1'), stroke: cssVar('--surface'), 'stroke-width': 2,
  }));
  return root;
}

/* ------------------------------- 微型元素 -------------------------------- */

export function badge(text, kind = '', icon) {
  return el('span', { class: `badge ${kind}`.trim() },
    icon ? el('span', { class: 'ico', 'aria-hidden': 'true', text: icon }) : null,
    text
  );
}

export function statTile({ label, value, note, noteKind = '', sub }) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value' }, value, sub ? el('small', { text: ` ${sub}` }) : null),
    note ? el('div', { class: `stat-note ${noteKind}`.trim() }, note) : null
  );
}

export function pathChips(pathArr, max = 6) {
  const wrap = el('span', { class: 'path' });
  pathArr.slice(0, max).forEach((c, i) => {
    if (i) wrap.append(el('span', { class: 'arrow', text: '→' }));
    wrap.append(el('span', {
      class: `step ${['direct', 'organic_search', 'referral'].includes(c) ? 'organic' : ''}`.trim(),
      text: channelLabel(c),
    }));
  });
  if (pathArr.length > max) wrap.append(el('span', { class: 'arrow', text: `+${pathArr.length - max}` }));
  return wrap;
}
