/**
 * 图表几何单元测试：用最小 SVG 替身检查条形路径、刻度与标签位置，
 * 避免出现负宽度、越界标签或缺失的表格视图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class SvgNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    this.listeners = new Map();
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  append(...nodes) { for (const n of nodes.flat()) if (n) this.children.push(n); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  get childElementCount() { return this.children.length; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; }
}

globalThis.document = {
  createElementNS: (_ns, tag) => new SvgNode(tag),
  createElement: (tag) => new SvgNode(tag),
  documentElement: new SvgNode('html'),
  getElementById: () => ({ classList: { add() {}, remove() {} }, style: {}, replaceChildren() {}, append() {} }),
};
globalThis.getComputedStyle = () => ({
  getPropertyValue: (n) => ({ '--series-1': '#2a78d6', '--pos': '#2a78d6', '--neg': '#d03b3b', '--ink': '#0b0b0b', '--ink-2': '#52514e', '--surface': '#fcfcfb' }[n] || '#000'),
});

const { horizontalBars, divergingBars, rangePlot, niceTicks, barPath, barPathLeft, compact, fmtMoney, fmtPct } = await import('../public/ui.js');

function collect(node, tag, out = []) {
  if (node.tagName === tag) out.push(node);
  for (const c of node.children) collect(c, tag, out);
  return out;
}

test('niceTicks：覆盖最大值且步长取整', () => {
  for (const max of [1, 9, 10, 137, 4321, 99999]) {
    const ticks = niceTicks(max, 3);
    assert.ok(ticks[ticks.length - 1] >= max, `${max} 的刻度应覆盖最大值`);
    assert.equal(ticks[0], 0);
    const step = ticks[1] - ticks[0];
    for (let i = 2; i < ticks.length; i++) {
      assert.ok(Math.abs((ticks[i] - ticks[i - 1]) - step) < 1e-9, '刻度等距');
    }
  }
});

test('条形路径：宽度非负且不出现 NaN', () => {
  for (const d of [barPath(10, 5, 0, 20, 4), barPath(10, 5, 1, 20, 4), barPath(10, 5, 200, 20, 4), barPathLeft(10, 5, 60, 20, 4)]) {
    assert.equal(/NaN|undefined/.test(d), false, d);
  }
  assert.match(barPath(10, 5, 200, 20, 4), /^M10,5h/);
});

test('横向条形：每行都有标签与值，且值标签位于条形末端右侧', () => {
  const root = horizontalBars(800, [
    { label: '付费搜索', value: 600 },
    { label: '自然搜索', value: 300 },
    { label: '直接访问', value: 100 },
  ], { labelWidth: 100, barHeight: 20, gap: 10 });
  const texts = collect(root, 'text');
  const values = texts.map((t) => t.textContent);
  assert.ok(values.includes('付费搜索'));
  assert.ok(values.includes('¥600'));
  assert.ok(values.includes('¥300'));
  const paths = collect(root, 'path');
  assert.equal(paths.length, 3);
  const widths = paths.map((p) => Number(p.getAttribute('d').match(/h([\d.-]+)/)[1]));
  assert.ok(widths[0] > widths[1] && widths[1] > widths[2], '条形宽度应单调对应数值');
  for (const p of paths) assert.ok(!/NaN/.test(p.getAttribute('d')));
  // 值标签 x 必须大于条形起点
  const valueTexts = texts.filter((t) => /^¥/.test(t.textContent));
  for (const t of valueTexts) assert.ok(Number(t.getAttribute('x')) >= 100);
});

test('发散条形：正负方向分开绘制，零线在中间', () => {
  const root = divergingBars(800, [
    { label: '付费搜索', value: 120 },
    { label: '自然搜索', value: -80 },
  ], { labelWidth: 100 });
  const bars = collect(root, 'path');
  assert.equal(bars.length, 2);
  const [pos, neg] = bars.map((b) => b.getAttribute('d'));
  assert.ok(/^M[\d.]+,[\d.]+h/.test(pos));
  assert.ok(/^M[\d.]+,[\d.]+h/.test(neg));
  const fills = bars.map((b) => b.getAttribute('fill'));
  assert.notEqual(fills[0], fills[1], '正负应使用不同颜色');
  const labels = collect(root, 'text').map((t) => t.textContent);
  assert.ok(labels.includes('+120'));
  assert.ok(labels.includes('−80'));
});

test('区间图：圆点位于区间内，标签不超出画布', () => {
  const root = rangePlot(700, [
    { label: '付费搜索', min: 0.2, max: 0.6, base: 0.4 },
    { label: '自然搜索', min: 0, max: 0.3, base: 0.1 },
  ], { labelWidth: 100 });
  const circles = collect(root, 'circle');
  assert.equal(circles.length, 2);
  for (const c of circles) {
    const cx = Number(c.getAttribute('cx'));
    assert.ok(cx >= 100 && cx <= 700, `圆点 x=${cx} 应在绘图区内`);
  }
  for (const t of collect(root, 'text')) {
    const x = Number(t.getAttribute('x'));
    assert.ok(Number.isFinite(x) && x <= 700, `文本 x=${x} 不应超出画布`);
  }
});

test('格式化：金额、百分比与紧凑数值在边界处稳定', () => {
  assert.equal(fmtMoney(0), '¥0.00');
  assert.equal(fmtMoney(12000), '¥1.2万');
  assert.equal(fmtMoney(2500000), '¥250万');
  assert.equal(fmtMoney(-350), '−¥350'.replace('−¥', '-¥'));
  assert.equal(fmtPct(0.1234), '12.3%');
  assert.equal(compact(999), '999');
  assert.equal(compact(1500), '1.5k');
  assert.equal(compact(12000), '1.2万');
});
