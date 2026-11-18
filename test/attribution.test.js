import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attribute, buildJourneys, migrateContributions, sensitivity, touchWeights,
  normalizeParams, paramHash, resultHash, getModel, MODEL_REGISTRY, AttributionError,
} from '../src/lib/attribution.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);
const iso = (ms) => new Date(ms).toISOString();

function fixtures() {
  const events = [
    // 旅程 A：跨设备，先展示后搜索再直接访问；退款；迟到回传
    { event_id: 'a1', identity_id: 'alice', device_id: 'desk', ts: iso(T0), channel: 'display', campaign: '开屏' },
    { event_id: 'a2', device_id: 'mob', ts: iso(T0 + 2 * DAY), channel: 'paid_search', campaign: '品牌词' },
    { event_id: 'a3', identity_id: 'alice', device_id: 'mob', ts: iso(T0 + 3 * DAY), channel: 'direct', campaign: '(direct)' },
    // 旅程 B：自然搜索 + 邮件
    { event_id: 'b1', identity_id: 'bob', device_id: 'bob-pc', ts: iso(T0 + 1 * DAY), channel: 'organic_search', campaign: '(organic)' },
    { event_id: 'b2', identity_id: 'bob', device_id: 'bob-pc', ts: iso(T0 + 2 * DAY), channel: 'email', campaign: '会员唤醒' },
    // 旅程 C：触点早于窗口
    { event_id: 'c1', identity_id: 'carol', device_id: 'carol-pc', ts: iso(T0 - 60 * DAY), channel: 'display', campaign: '旧广告' },
    // 旅程 D：只有直接访问
    { event_id: 'd1', identity_id: 'dave', device_id: 'dave-pc', ts: iso(T0 + 4 * DAY), channel: 'direct', campaign: '(direct)' },
    // 重复事件
    { event_id: 'b1', identity_id: 'bob', device_id: 'bob-pc', ts: iso(T0 + 1 * DAY), channel: 'organic_search', campaign: '(organic)' },
    // 转化后触点（不参与归因）
    { event_id: 'a4', identity_id: 'alice', device_id: 'mob', ts: iso(T0 + 6 * DAY), channel: 'direct', campaign: '(direct)' },
  ];
  const conversions = [
    { conversion_id: 'cvA', identity_id: 'alice', ts: iso(T0 + 5 * DAY), received_at: iso(T0 + 7 * DAY), value: 1000, order_id: 'ordA' },
    { conversion_id: 'cvB', identity_id: 'bob', ts: iso(T0 + 3 * DAY), received_at: iso(T0 + 3 * DAY), value: 200, order_id: 'ordB', refund_amount: 200 },
    { conversion_id: 'cvC', identity_id: 'carol', ts: iso(T0 + 5 * DAY), value: 500, order_id: 'ordC' },
    { conversion_id: 'cvD', identity_id: 'dave', ts: iso(T0 + 5 * DAY), value: 300, order_id: 'ordD' },
    { conversion_id: 'cvE', identity_id: 'erin', ts: iso(T0 + 5 * DAY), value: 400, order_id: 'ordE' },
    { conversion_id: 'cvD', identity_id: 'dave', ts: iso(T0 + 5 * DAY), value: 300, order_id: 'ordD' },
  ];
  return {
    events,
    conversions,
    identityLinks: { mob: 'alice' },
  };
}

function run(modelId, version, params = {}, refundPolicy = 'clawback', input = fixtures()) {
  const { journeys, anomalies } = buildJourneys(input);
  const result = attribute({ modelId, modelVersion: version, params, journeys, refundPolicy });
  return { result, journeys, anomalies };
}

test('末次触点：跨设备旅程按身份合并，末次触点获得全部信用', () => {
  const { result, journeys } = run('last_touch', '1.0.0');
  const alice = journeys.find((j) => j.identity === 'alice');
  assert.deepEqual(alice.devices, ['desk', 'mob'], '设备应通过身份链接合并到同一旅程');
  const conv = result.conversion_rows.find((c) => c.conversion_id === 'cvA');
  assert.equal(conv.status, 'attributed');
  assert.equal(conv.cross_device, true);
  assert.equal(conv.allocations.length, 1);
  assert.equal(conv.allocations[0].channel, 'direct');
  assert.equal(conv.allocations[0].credit, 1000);
});

test('末次触点 v1.1.0：直接访问回退到最后一个非直接触点', () => {
  const v10 = run('last_touch', '1.0.0').result;
  const v11 = run('last_touch', '1.1.0').result;
  const a10 = v10.conversion_rows.find((c) => c.conversion_id === 'cvA');
  const a11 = v11.conversion_rows.find((c) => c.conversion_id === 'cvA');
  assert.equal(a10.allocations[0].channel, 'direct');
  assert.equal(a11.allocations[0].channel, 'paid_search');
  const direct10 = v10.channel_rows.find((r) => r.channel === 'direct');
  const direct11 = v11.channel_rows.find((r) => r.channel === 'direct');
  assert.ok((direct10?.credit || 0) > (direct11?.credit || 0), '回退规则应降低直接访问贡献');
});

test('线性：窗口内触点均分，转化后触点不参与', () => {
  const { result } = run('linear', '1.0.0');
  const conv = result.conversion_rows.find((c) => c.conversion_id === 'cvA');
  assert.equal(conv.allocations.length, 3);
  for (const a of conv.allocations) assert.ok(Math.abs(a.credit - 1000 / 3) < 0.02);
  assert.equal(result.totals.post_conversion_touches, 1);
});

test('时间衰减：权重随年龄单调下降，半衰期决定尾部', () => {
  const { result } = run('time_decay', '1.0.0', { half_life_hours: 24 });
  const conv = result.conversion_rows.find((c) => c.conversion_id === 'cvA');
  const byChannel = Object.fromEntries(conv.allocations.map((a) => [a.channel, a.weight]));
  assert.ok(byChannel.direct > byChannel.paid_search);
  assert.ok(byChannel.paid_search > byChannel.display);
  const model = getModel('time_decay', '1.0.0');
  const raw = touchWeights(model, normalizeParams('time_decay', { half_life_hours: 24 }), [
    { ts: T0 + 5 * DAY - 2 * DAY, channel: 'direct' },
    { ts: T0 + 5 * DAY - 3 * DAY, channel: 'paid_search' },
  ], T0 + 5 * DAY);
  assert.ok(Math.abs(raw[0] - 0.25) < 1e-9, '48h 前触点绝对权重 = 0.5^2');
  assert.ok(Math.abs(raw[1] - 0.125) < 1e-9, '72h 前触点绝对权重 = 0.5^3');
  const long = run('time_decay', '1.0.0', { half_life_hours: 720 }).result;
  const longConv = long.conversion_rows.find((c) => c.conversion_id === 'cvA');
  assert.ok(longConv.allocations.find((a) => a.channel === 'display').weight > byChannel.display);
});

test('窗口变化：触点早于窗口的转化进入无法归因并注明原因', () => {
  const narrow = run('linear', '1.0.0', { lookback_days: 1 }).result;
  const carol = narrow.conversion_rows.find((c) => c.conversion_id === 'cvC');
  assert.equal(carol.status, 'unattributed');
  assert.equal(carol.reason, 'no_touch_in_window');
  assert.ok(narrow.unattributed.reasons.no_touch_in_window >= 1);
  const wide = run('linear', '1.0.0', { lookback_days: 90 }).result;
  assert.equal(wide.conversion_rows.find((c) => c.conversion_id === 'cvC').status, 'attributed');
});

test('自然流量：默认可参与；排除后仅自然触点的转化单独统计', () => {
  const organicOnly = {
    events: [
      { event_id: 'o1', identity_id: 'zoe', ts: iso(T0), channel: 'organic_search', campaign: '(organic)' },
      { event_id: 'o2', identity_id: 'zoe', ts: iso(T0 + DAY), channel: 'referral', campaign: '(referral)' },
    ],
    conversions: [{ conversion_id: 'cvZ', identity_id: 'zoe', ts: iso(T0 + 2 * DAY), value: 800, order_id: 'ordZ' }],
  };
  const withOrganic = run('linear', '1.0.0', { include_organic: true }, 'clawback', organicOnly).result;
  const withoutOrganic = run('linear', '1.0.0', { include_organic: false }, 'clawback', organicOnly).result;
  assert.ok(withOrganic.channel_rows.some((r) => r.channel === 'organic_search'));
  assert.ok(withOrganic.channel_rows.some((r) => r.channel === 'referral'));
  assert.equal(withoutOrganic.channel_rows.length, 0);
  assert.equal(withoutOrganic.unattributed.reasons.organic_excluded_only, 1);
  assert.equal(withoutOrganic.unattributed.net_value, 800);
  assert.equal(withoutOrganic.totals.attributed_value, 0);
  // 主数据集中，排除自然流量不应改变非自然渠道的信用总额（只是重新分配旅程）。
  const base = run('linear', '1.0.0', { include_organic: true }).result;
  const excluded = run('linear', '1.0.0', { include_organic: false }).result;
  assert.equal(excluded.unattributed.reasons.organic_excluded_only, 1, 'dave 只有直接访问，排除自然流量后无可用触点');
  assert.ok(excluded.totals.attributed_value <= base.totals.attributed_value);
});

test('直接访问排除：只排除 direct，不误伤其它自然渠道', () => {
  const { result } = run('linear', '1.0.0', { include_direct: false });
  assert.equal(result.unattributed.reasons.direct_excluded_only, 1, 'dave 只有直接访问');
  const dave = result.conversion_rows.find((c) => c.conversion_id === 'cvD');
  assert.equal(dave.reason, 'direct_excluded_only');
  const alice = result.conversion_rows.find((c) => c.conversion_id === 'cvA');
  assert.equal(alice.status, 'attributed');
  assert.ok(!alice.allocations.some((a) => a.channel === 'direct'));
});

test('退款：clawback 按权重反向冲减，净额与渠道合计一致', () => {
  const { result } = run('linear', '1.0.0', {}, 'clawback');
  const bob = result.conversion_rows.find((c) => c.conversion_id === 'cvB');
  assert.equal(bob.net_value, 0);
  assert.equal(bob.status, 'fully_refunded');
  assert.equal(result.unattributed.reasons.zero_value, 0, '全额退款不属于“无法归因”，单独归类');
  assert.equal(result.refunds.fully_refunded_orders, 1);
  const credited = result.channel_rows.reduce((a, r) => a + r.credit, 0);
  assert.ok(Math.abs(credited - result.totals.attributed_value) < 0.02);
  const netSum = result.conversion_rows.filter((c) => c.status === 'attributed').reduce((a, c) => a + c.net_value, 0);
  assert.ok(Math.abs(netSum - credited) < 0.05, '渠道信用合计应等于已归因转化的净额合计');
  const allNet = result.conversion_rows.filter((c) => c.status !== 'excluded_refund').reduce((a, c) => a + c.net_value, 0);
  assert.ok(Math.abs(allNet - result.totals.net_value) < 0.05, '总净额 = 已归因 + 无法归因');
  assert.ok(Math.abs(result.totals.net_value - result.totals.attributed_value - result.unattributed.net_value) < 0.05);
});

test('退款：exclude 整单剔除并单独列出，不与无法归因混淆', () => {
  const { result } = run('linear', '1.0.0', {}, 'exclude');
  const bob = result.conversion_rows.find((c) => c.conversion_id === 'cvB');
  assert.equal(bob.status, 'excluded_refund');
  assert.equal(result.totals.excluded_conversions, 1);
  assert.equal(result.refunds.excluded_orders, 1);
  assert.equal(result.unattributed.reasons.zero_value, 0);
});

test('退款：ignore 按毛额归因，仅用于对账', () => {
  const { result } = run('linear', '1.0.0', {}, 'ignore');
  const bob = result.conversion_rows.find((c) => c.conversion_id === 'cvB');
  assert.equal(bob.status, 'attributed');
  assert.equal(bob.net_value, 200);
});

test('重复事件与重复转化：只在归并阶段计一次并计数', () => {
  const { result, anomalies } = run('linear', '1.0.0');
  assert.equal(anomalies.duplicate_events, 1);
  assert.equal(anomalies.duplicate_conversions, 1);
  assert.equal(result.conversion_rows.length, 5);
  assert.equal(result.totals.conversions, 5);
});

test('迟到转化：按 received_at 判定，仍可归因但被标记', () => {
  const { result, anomalies } = run('last_touch', '1.0.0');
  assert.equal(anomalies.late_conversions, 1);
  const late = result.conversion_rows.find((c) => c.conversion_id === 'cvA');
  assert.equal(late.is_late, true);
  assert.ok(late.arrival_lag_hours >= 48);
  assert.equal(late.status, 'attributed');
  assert.equal(result.totals.late_conversions, 1);
});

test('无触点转化：单独计入无法归因，不摊派', () => {
  const { result } = run('linear', '1.0.0');
  const erin = result.conversion_rows.find((c) => c.conversion_id === 'cvE');
  assert.equal(erin.status, 'unattributed');
  assert.equal(erin.reason, 'no_touch');
  assert.equal(result.unattributed.reasons.no_touch, 1);
  assert.equal(result.unattributed.net_value, 900); // carol 500 + dave 300 + erin 400 ... 见下方断言
});

test('路径：连续同渠道合并，按价值排序', () => {
  const { result } = run('linear', '1.0.0');
  assert.ok(result.paths.length >= 2);
  assert.ok(result.paths.every((p, i, arr) => i === 0 || arr[i - 1].value >= p.value));
  for (const p of result.paths) {
    for (let i = 1; i < p.path.length; i++) assert.notEqual(p.path[i], p.path[i - 1]);
  }
});

test('无法归因合计：等于各原因的净额之和', () => {
  const { result } = run('linear', '1.0.0', { include_direct: false });
  const reasonSum = Object.values(result.unattributed.reason_value).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(reasonSum - result.unattributed.net_value) < 0.02);
  assert.ok(Math.abs(result.unattributed.net_value - (500 + 300 + 400)) < 0.02);
});

test('结果指纹稳定：同输入同参数得到同哈希，改参数即改变', () => {
  const a = run('time_decay', '1.0.0', { half_life_hours: 48 }).result;
  const b = run('time_decay', '1.0.0', { half_life_hours: 48 }).result;
  const c = run('time_decay', '1.0.0', { half_life_hours: 72 }).result;
  assert.equal(resultHash(a), resultHash(b));
  assert.notEqual(resultHash(a), resultHash(c));
  assert.notEqual(paramHash('time_decay', '1.0.0', a.params, 'clawback'), paramHash('time_decay', '1.0.0', c.params, 'clawback'));
});

test('参数归一化：裁剪越界、忽略未知键、拒绝未知模型', () => {
  const p = normalizeParams('time_decay', { lookback_days: 1000, half_life_hours: 0, include_direct: 'false', bogus: 1 });
  assert.equal(p.lookback_days, 365);
  assert.equal(p.half_life_hours, 1);
  assert.equal(p.include_direct, false);
  assert.equal('bogus' in p, false);
  assert.throws(() => normalizeParams('nope', {}), AttributionError);
  assert.throws(() => normalizeParams('time_decay', { lookback_days: 'x' }), /必须是数字/);
});

test('贡献迁移：同一快照下总额守恒，跨渠道重新分配', () => {
  const a = run('linear', '1.0.0').result;
  const b = run('time_decay', '1.0.0').result;
  assert.equal(a.totals.attributed_value, b.totals.attributed_value);
  const mig = migrateContributions(a, b);
  const deltaSum = mig.rows.reduce((acc, r) => acc + r.delta_credit, 0);
  assert.ok(Math.abs(deltaSum) < 0.1, '同快照同总量时迁移应净为零');
  assert.ok(mig.rows.some((r) => Math.abs(r.delta_credit) > 0.01));
  assert.equal(mig.changes.model, true);
  assert.equal(mig.changes.model_version, false);
});

test('敏感性：变体包含窗口与自然流量口径，区间覆盖基线', () => {
  const { journeys } = buildJourneys(fixtures());
  const s = sensitivity({
    modelId: 'time_decay',
    modelVersion: '1.0.0',
    baseParams: {},
    journeys,
    refundPolicy: 'clawback',
  });
  const labels = s.variants.map((v) => v.label);
  assert.ok(labels.some((l) => l.includes('7 天')));
  assert.ok(labels.some((l) => l.includes('90 天')));
  assert.ok(labels.some((l) => l.includes('自然流量')));
  assert.ok(labels.some((l) => l.includes('半衰期 24')));
  for (const c of s.channels) {
    assert.ok(c.min_share <= c.base_share + 1e-6, `${c.channel}/${c.campaign} min<=base`);
    assert.ok(c.max_share >= c.base_share - 1e-6, `${c.channel}/${c.campaign} max>=base`);
    assert.ok(c.min_share >= 0 && c.max_share <= 1);
  }
  const late = s.channels.find((c) => c.campaign === '旧广告');
  assert.ok(late && late.min_share === 0, '仅在部分变体出现的渠道区间必须包含 0');
  assert.equal(late.missing_in_variants, true);
  assert.ok(s.summary.variant_count >= 8);
});

test('注册表版本链完整：口径修订版声明被替代版本且参数可归一化', () => {
  const lt = MODEL_REGISTRY.filter((m) => m.id === 'last_touch').map((m) => m.version);
  assert.deepEqual(lt, ['1.0.0', '1.1.0']);
  const v11 = getModel('last_touch', '1.1.0');
  assert.equal(v11.supersedes, '1.0.0');
  assert.equal(normalizeParams('last_touch', {}, '1.0.0').direct_fallback, undefined);
  assert.equal(normalizeParams('last_touch', {}, '1.1.0').direct_fallback, true);
  assert.throws(() => getModel('last_touch', '9.9.9'), /不存在版本/);
  assert.equal(MODEL_REGISTRY.length, 4);
});
