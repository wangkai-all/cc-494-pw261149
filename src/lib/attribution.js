/**
 * 归因引擎（纯函数，无 IO）。
 *
 * 版本锁定规则
 *  - 模型语义由 MODEL_REGISTRY 中 (id, version) 唯一确定；改动任何分支都必须同时
 *    新增或提升 version，旧版本保留，历史结果可复算。
 *  - 参数只接受 schema 内声明的键，normalizeParams 负责裁剪与类型转换。
 *  - 运行结果的输入是快照；快照、模型版本、参数、退款策略共同决定结果指纹。
 *
 * 统计口径
 *  - 跨设备：事件先按身份归并（identity_id > user_id > device_id，经身份链接表解析），
 *    再按身份形成旅程。
 *  - 自然流量：organic_search / direct / referral。默认计入，也可按参数排除；
 *    被排除导致的无法归因单独计数，不静默丢弃。
 *  - 退款：clawback 按归因权重反向冲减；exclude 整单剔除；ignore 按毛额（仅对账）。
 *  - 窗口：触点必须落在 [转化 - lookback_days, 转化]。
 *  - 迟到转化：received_at 晚于转化时间超过 LATE_CONVERSION_HOURS 的转化。
 *  - 重复事件：event_id 或自然键完全相同的记录只计一次。
 */

export const ENGINE_VERSION = '1.0.0';
export const LATE_CONVERSION_HOURS = 24;

/** 模型注册表；同 id 多版本共存，版本号不可复用。 */
export const MODEL_REGISTRY = [
  {
    id: 'last_touch',
    version: '1.0.0',
    label: '末次触点',
    summary: '100% 贡献归给转化前窗口内的最后一个触点。',
    caveat: '会高估临门一脚渠道（品牌词、直接访问），不反映种草环节。',
    params: {
      lookback_days: { type: 'int', default: 30, min: 1, max: 365, label: '回看窗口（天）' },
      include_direct: { type: 'bool', default: true, label: '直接访问计入触点' },
      include_organic: { type: 'bool', default: true, label: '自然流量计入触点' },
      dedupe_same_session: { type: 'bool', default: true, label: '同会话同渠道去重' },
    },
  },
  {
    id: 'last_touch',
    version: '1.1.0',
    label: '末次触点',
    summary: '末次触点；当末次为直接访问时回退到最后一个非直接触点。',
    caveat: '回退规则降低品牌词/直接访问对自然流量的劫持，但属于口径修订，需与 1.0.0 对比迁移。',
    supersedes: '1.0.0',
    params: {
      lookback_days: { type: 'int', default: 30, min: 1, max: 365, label: '回看窗口（天）' },
      include_direct: { type: 'bool', default: true, label: '直接访问计入触点' },
      include_organic: { type: 'bool', default: true, label: '自然流量计入触点' },
      dedupe_same_session: { type: 'bool', default: true, label: '同会话同渠道去重' },
      direct_fallback: { type: 'bool', default: true, label: '直接访问回退到非直接触点' },
    },
  },
  {
    id: 'linear',
    version: '1.0.0',
    label: '线性',
    summary: '窗口内所有触点均分贡献。',
    caveat: '忽略触点先后与强度，适合渠道健康度与预算基线。',
    params: {
      lookback_days: { type: 'int', default: 30, min: 1, max: 365, label: '回看窗口（天）' },
      include_direct: { type: 'bool', default: true, label: '直接访问计入触点' },
      include_organic: { type: 'bool', default: true, label: '自然流量计入触点' },
      dedupe_same_session: { type: 'bool', default: true, label: '同会话同渠道去重' },
    },
  },
  {
    id: 'time_decay',
    version: '1.0.0',
    label: '时间衰减',
    summary: '按指数衰减加权，越接近转化的触点权重越高。',
    caveat: '半衰期是业务假设，必须做敏感性验证；半衰期越短越接近末次触点。',
    params: {
      lookback_days: { type: 'int', default: 30, min: 1, max: 365, label: '回看窗口（天）' },
      include_direct: { type: 'bool', default: true, label: '直接访问计入触点' },
      include_organic: { type: 'bool', default: true, label: '自然流量计入触点' },
      dedupe_same_session: { type: 'bool', default: true, label: '同会话同渠道去重' },
      half_life_hours: { type: 'number', default: 168, min: 1, max: 8760, label: '半衰期（小时）' },
    },
  },
];

export const MODEL_IDS = ['last_touch', 'linear', 'time_decay'];

export const REFUND_POLICIES = {
  clawback: { id: 'clawback', label: '反向冲减', description: '退款金额按原归因权重从各渠道扣回。' },
  exclude: { id: 'exclude', label: '整单剔除', description: '含退款的订单不参与归因，单独列出。' },
  ignore: { id: 'ignore', label: '按毛额', description: '忽略退款，仅用于与财务毛额对账。' },
};

const IDENTITY_KEYS = ['identity_id', 'user_id', 'device_id'];

export class AttributionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AttributionError';
    this.status = status;
  }
}

export function getModel(id, version) {
  const versions = MODEL_REGISTRY.filter((m) => m.id === id);
  if (versions.length === 0) throw new AttributionError(`未知模型: ${id}`);
  if (version) {
    const found = versions.find((m) => m.version === version);
    if (!found) throw new AttributionError(`模型 ${id} 不存在版本 ${version}`);
    return found;
  }
  return versions[versions.length - 1];
}

/** 供前端使用的模型目录（按 id 聚合版本）。 */
export function modelCatalog() {
  return MODEL_IDS.map((id) => {
    const versions = MODEL_REGISTRY.filter((m) => m.id === id);
    const latest = versions[versions.length - 1];
    return {
      id,
      label: latest.label,
      summary: latest.summary,
      caveat: latest.caveat,
      params: latest.params,
      versions: versions.map((v) => ({
        version: v.version,
        label: v.label,
        summary: v.summary,
        caveat: v.caveat,
        supersedes: v.supersedes || null,
        params: v.params,
      })),
      latest_version: latest.version,
    };
  });
}

export function normalizeParams(modelId, raw = {}, version) {
  const model = getModel(modelId, version);
  const out = {};
  for (const [key, spec] of Object.entries(model.params)) {
    let value = raw[key];
    if (value === undefined || value === null || value === '') value = spec.default;
    if (spec.type === 'bool') {
      if (typeof value === 'string') value = value === 'true' || value === '1';
      value = Boolean(value);
    } else if (spec.type === 'int' || spec.type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) throw new AttributionError(`参数 ${key} 必须是数字`);
      if (spec.type === 'int') value = Math.round(value);
      if (spec.min !== undefined && value < spec.min) value = spec.min;
      if (spec.max !== undefined && value > spec.max) value = spec.max;
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(value)) {
        throw new AttributionError(`参数 ${key} 只能取 ${spec.values.join(' / ')}`);
      }
    }
    out[key] = value;
  }
  return out;
}

export function normalizeRefundPolicy(id) {
  const key = id || 'clawback';
  if (!REFUND_POLICIES[key]) throw new AttributionError(`未知退款策略: ${id}`);
  return key;
}

/** 稳定序列化：对象键排序，确保同一输入得到同一指纹。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function fnv1a(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function hashPayload(payload) {
  return fnv1a(stableStringify(payload));
}

export function paramHash(modelId, version, params, refundPolicy) {
  return fnv1a(stableStringify({ modelId, version, params, refundPolicy }));
}

export function isOrganicChannel(channel) {
  return channel === 'organic_search' || channel === 'direct' || channel === 'referral';
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function round6(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
}

/**
 * 归并旅程。
 * @param {{events?: object[], conversions?: object[], identityLinks?: Record<string,string>}} input
 */
export function buildJourneys(input, options = {}) {
  const lateHours = options.lateHours ?? LATE_CONVERSION_HOURS;
  const anomalies = {
    duplicate_events: 0,
    duplicate_conversions: 0,
    missing_identity: 0,
    invalid_time: 0,
    unlinked_devices: 0,
    late_conversions: 0,
    raw_events: 0,
    raw_conversions: 0,
    deduped_events: 0,
    deduped_conversions: 0,
  };
  const duplicateSamples = [];
  const lateSamples = [];
  const deviceOwner = new Map();
  const linkedDevices = new Set(Object.keys(input.identityLinks || {}));
  const seenEvents = new Set();
  const seenConversions = new Set();
  const byIdentity = new Map();
  const convByIdentity = new Map();
  let firstEventTs = Infinity;
  let lastEventTs = 0;

  const resolve = (row) => {
    for (const key of IDENTITY_KEYS) {
      if (row[key]) {
        const raw = String(row[key]);
        return input.identityLinks?.[raw] || raw;
      }
    }
    return null;
  };

  for (const ev of input.events || []) {
    anomalies.raw_events++;
    const identity = resolve(ev);
    if (!identity) {
      anomalies.missing_identity++;
      continue;
    }
    const ts = toMs(ev.ts);
    if (ts === null) {
      anomalies.invalid_time++;
      continue;
    }
    const key = ev.event_id || `${identity}|${ts}|${ev.channel}|${ev.campaign || ''}|${ev.session_id || ''}`;
    if (seenEvents.has(key)) {
      anomalies.duplicate_events++;
      if (duplicateSamples.length < 25) {
        duplicateSamples.push({
          kind: 'event',
          key,
          channel: ev.channel || 'direct',
          campaign: ev.campaign || '(not set)',
          ts,
          identity,
        });
      }
      continue;
    }
    seenEvents.add(key);
    anomalies.deduped_events++;
    const device = ev.device_id || null;
    if (device) {
      const owner = deviceOwner.get(device);
      if (!owner) deviceOwner.set(device, identity);
      else if (owner !== identity) anomalies.unlinked_devices++;
    }
    firstEventTs = Math.min(firstEventTs, ts);
    lastEventTs = Math.max(lastEventTs, ts);
    let arr = byIdentity.get(identity);
    if (!arr) {
      arr = [];
      byIdentity.set(identity, arr);
    }
    arr.push({
      id: ev.event_id || key,
      identity,
      ts,
      channel: ev.channel || 'direct',
      campaign: ev.campaign || '(not set)',
      source: ev.source || '',
      session_id: ev.session_id || `${identity}:${Math.floor(ts / 1800000)}`,
      device_id: device,
      is_organic: isOrganicChannel(ev.channel),
    });
  }

  for (const cv of input.conversions || []) {
    anomalies.raw_conversions++;
    const identity = resolve(cv);
    if (!identity) {
      anomalies.missing_identity++;
      continue;
    }
    const ts = toMs(cv.ts);
    if (ts === null) {
      anomalies.invalid_time++;
      continue;
    }
    const key = cv.conversion_id || `${identity}|${ts}|${cv.order_id || ''}`;
    if (seenConversions.has(key)) {
      anomalies.duplicate_conversions++;
      if (duplicateSamples.length < 25) {
        duplicateSamples.push({ kind: 'conversion', key, ts, identity, value: round2(cv.value) });
      }
      continue;
    }
    seenConversions.add(key);
    anomalies.deduped_conversions++;
    const value = Number(cv.value) || 0;
    const refundAmount = Math.min(Math.max(Number(cv.refund_amount) || 0, 0), Math.max(value, 0));
    const receivedTs = toMs(cv.received_at);
    const lagHours = receivedTs === null ? 0 : Math.max(0, (receivedTs - ts) / 3600000);
    const isLate = lagHours > lateHours;
    if (isLate) {
      anomalies.late_conversions++;
      if (lateSamples.length < 25) {
        lateSamples.push({
          conversion_id: cv.conversion_id || key,
          identity,
          ts,
          ts_iso: new Date(ts).toISOString(),
          received_at: cv.received_at,
          lag_hours: Math.round(lagHours * 10) / 10,
          value: round2(value),
          device_id: cv.device_id || null,
        });
      }
    }
    let arr = convByIdentity.get(identity);
    if (!arr) {
      arr = [];
      convByIdentity.set(identity, arr);
    }
    arr.push({
      id: cv.conversion_id || key,
      identity,
      ts,
      value,
      currency: cv.currency || 'CNY',
      refund_amount: refundAmount,
      refunded: refundAmount > 0,
      refund_ts: cv.refund_ts ? toMs(cv.refund_ts) : null,
      order_id: cv.order_id || cv.conversion_id || key,
      device_id: cv.device_id || null,
      received_at: cv.received_at || null,
      is_late: isLate,
      arrival_lag_hours: Math.round(lagHours * 10) / 10,
    });
  }

  const journeys = [];
  for (const [identity, touches] of byIdentity) {
    touches.sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
    journeys.push({
      identity,
      touches,
      conversions: (convByIdentity.get(identity) || []).sort((a, b) => a.ts - b.ts),
      devices: [...new Set(touches.map((t) => t.device_id).filter(Boolean))].sort(),
    });
  }
  for (const [identity, convs] of convByIdentity) {
    if (byIdentity.has(identity)) continue;
    journeys.push({
      identity,
      touches: [],
      conversions: convs.sort((a, b) => a.ts - b.ts),
      devices: [],
    });
  }
  journeys.sort((a, b) => String(a.identity).localeCompare(String(b.identity)));

  return {
    journeys,
    anomalies: {
      ...anomalies,
      identities: journeys.length,
      device_count: deviceOwner.size,
      linked_device_count: [...deviceOwner.keys()].filter((d) => linkedDevices.has(d)).length,
      first_event_ts: Number.isFinite(firstEventTs) ? firstEventTs : null,
      last_event_ts: lastEventTs || null,
    },
    duplicateSamples,
    lateSamples,
  };
}

function windowTouches(touches, convTs, params) {
  const start = convTs - params.lookback_days * 86400000;
  const inWindow = [];
  const excluded = [];
  for (const t of touches) {
    if (t.ts > convTs) {
      excluded.push({ touch: t, reason: 'after_conversion' });
      continue;
    }
    if (t.ts < start) {
      excluded.push({ touch: t, reason: 'before_window' });
      continue;
    }
    if (!params.include_direct && t.channel === 'direct') {
      excluded.push({ touch: t, reason: 'direct_excluded' });
      continue;
    }
    if (!params.include_organic && t.is_organic) {
      excluded.push({ touch: t, reason: 'organic_excluded' });
      continue;
    }
    inWindow.push(t);
  }
  if (params.dedupe_same_session) {
    const kept = new Map();
    for (const t of inWindow) {
      const key = `${t.session_id}|${t.channel}`;
      const existing = kept.get(key);
      if (!existing) kept.set(key, t);
      else if (t.ts > existing.ts) kept.set(key, t);
    }
    return { touches: [...kept.values()].sort((a, b) => a.ts - b.ts), excluded };
  }
  return { touches: inWindow, excluded };
}

/**
 * 触点权重。返回与 touches 对齐的权重数组；权重为 0 的触点不获得信用。
 * 语义按 model.version 分派 —— 版本是结果的组成部分。
 */
export function touchWeights(model, params, touches, convTs) {
  if (touches.length === 0) return [];
  if (model.id === 'linear') return touches.map(() => 1);
  if (model.id === 'time_decay') {
    return touches.map((t) => {
      const ageHours = Math.max(0, (convTs - t.ts) / 3600000);
      return Math.pow(0.5, ageHours / Math.max(1, params.half_life_hours));
    });
  }
  if (model.id === 'last_touch') {
    const weights = touches.map(() => 0);
    let idx = touches.length - 1;
    if (model.version === '1.1.0' && params.direct_fallback) {
      while (idx > 0 && touches[idx].channel === 'direct') idx--;
    }
    weights[idx] = 1;
    return weights;
  }
  throw new AttributionError(`未实现的模型语义: ${model.id}@${model.version}`, 500);
}

function compressPath(channels) {
  const out = [];
  for (const c of channels) {
    if (!out.length || out[out.length - 1] !== c) out.push(c);
  }
  return out;
}

/**
 * 执行归因。
 * @param {{modelId:string, modelVersion?:string, params:object, journeys:object[], refundPolicy?:string}} args
 */
export function attribute({ modelId, modelVersion, params, journeys, refundPolicy = 'clawback' }) {
  const model = getModel(modelId, modelVersion);
  const policy = normalizeRefundPolicy(refundPolicy);
  const normalized = normalizeParams(modelId, params, model.version);

  const channels = new Map();
  const rows = [];
  const unattributed = {
    conversions: 0,
    gross_value: 0,
    net_value: 0,
    reasons: {
      no_touch: 0,
      no_touch_in_window: 0,
      direct_excluded_only: 0,
      organic_excluded_only: 0,
      zero_value: 0,
    },
    reason_value: {
      no_touch: 0,
      no_touch_in_window: 0,
      direct_excluded_only: 0,
      organic_excluded_only: 0,
      zero_value: 0,
    },
  };
  const refunds = {
    policy,
    refunded_orders: 0,
    refund_amount: 0,
    clawback: 0,
    fully_refunded_orders: 0,
    fully_refunded_value: 0,
    excluded_orders: 0,
    excluded_value: 0,
    late_refunds: 0,
  };
  const pathMap = new Map();
  let crossDeviceConversions = 0;
  let crossDeviceValue = 0;
  let postConversionTouchCount = 0;
  let lateConversionsIncluded = 0;
  let lateConversionValue = 0;

  const ensureChannel = (channel, campaign, organic) => {
    const key = `${channel}|${campaign}`;
    let row = channels.get(key);
    if (!row) {
      row = {
        channel,
        campaign,
        kind: organic ? 'organic' : 'paid',
        is_organic: organic,
        credit: 0,
        raw_credit: 0,
        refund_clawback: 0,
        attributed_conversions: 0,
        touch_count: 0,
      };
      channels.set(key, row);
    }
    return row;
  };

  for (const journey of journeys) {
    for (const conv of journey.conversions) {
      const gross = conv.value;
      const refund = conv.refund_amount;
      const { touches: inWindow, excluded } = windowTouches(journey.touches, conv.ts, normalized);
      postConversionTouchCount += excluded.filter((e) => e.reason === 'after_conversion').length;

      const base = {
        conversion_id: conv.id,
        order_id: conv.order_id,
        identity: conv.identity,
        ts: conv.ts,
        ts_iso: new Date(conv.ts).toISOString(),
        received_at: conv.received_at,
        arrival_lag_hours: conv.arrival_lag_hours,
        is_late: conv.is_late,
        gross_value: round2(gross),
        refund_value: round2(refund),
        net_value: round2(gross - refund),
        refund_policy: policy,
        devices: journey.devices,
        cross_device: journey.devices.length > 1,
        touch_count: inWindow.length,
        excluded_touches: excluded.length,
        status: 'attributed',
        reason: null,
        allocations: [],
      };

      if (conv.is_late) {
        lateConversionsIncluded++;
        lateConversionValue += Math.max(0, gross - refund);
      }
      if (journey.devices.length > 1) {
        crossDeviceConversions++;
        crossDeviceValue += Math.max(0, gross - refund);
      }

      if (policy === 'exclude' && refund > 0) {
        refunds.refunded_orders++;
        refunds.refund_amount += refund;
        refunds.excluded_orders++;
        refunds.excluded_value += gross;
        rows.push({ ...base, status: 'excluded_refund', reason: 'refund_policy_exclude' });
        continue;
      }

      const net = policy === 'ignore' ? gross : gross - refund;
      if (net <= 0) {
        if (refund > 0) {
          refunds.refunded_orders++;
          refunds.refund_amount += refund;
          refunds.fully_refunded_orders++;
          refunds.fully_refunded_value += gross;
          rows.push({ ...base, status: 'fully_refunded', reason: 'fully_refunded', net_value: 0 });
        } else {
          unattributed.conversions++;
          unattributed.reasons.zero_value++;
          unattributed.reason_value.zero_value += gross - refund;
          rows.push({ ...base, status: 'zero_value', reason: 'zero_value' });
        }
        continue;
      }

      if (inWindow.length === 0) {
        const reasons = new Set(excluded.filter((e) => e.reason !== 'after_conversion').map((e) => e.reason));
        let reason = 'no_touch';
        if (reasons.size === 1 && reasons.has('direct_excluded')) reason = 'direct_excluded_only';
        else if (reasons.size === 1 && reasons.has('organic_excluded')) reason = 'organic_excluded_only';
        else if (journey.touches.length > 0) reason = 'no_touch_in_window';
        unattributed.conversions++;
        unattributed.gross_value += gross;
        unattributed.net_value += net;
        unattributed.reasons[reason]++;
        unattributed.reason_value[reason] += net;
        rows.push({ ...base, status: 'unattributed', reason });
        continue;
      }

      const weights = touchWeights(model, normalized, inWindow, conv.ts);
      const weightSum = weights.reduce((a, b) => a + b, 0);
      if (!(weightSum > 0)) {
        unattributed.conversions++;
        unattributed.gross_value += gross;
        unattributed.net_value += net;
        unattributed.reasons.no_touch_in_window++;
        unattributed.reason_value.no_touch_in_window += net;
        rows.push({ ...base, status: 'unattributed', reason: 'zero_weight' });
        continue;
      }
      const allocations = [];
      inWindow.forEach((t, i) => {
        if (!(weights[i] > 0)) return;
        const share = weights[i] / weightSum;
        const credit = net * share;
        const row = ensureChannel(t.channel, t.campaign, t.is_organic);
        row.credit += credit;
        row.raw_credit += credit;
        row.attributed_conversions += share;
        if (policy === 'clawback' && refund > 0) row.refund_clawback += refund * share;
        allocations.push({
          touch_id: t.id,
          channel: t.channel,
          campaign: t.campaign,
          ts: t.ts,
          ts_iso: new Date(t.ts).toISOString(),
          device_id: t.device_id,
          session_id: t.session_id,
          weight: round6(share),
          credit: round2(credit),
        });
      });
      if (policy === 'clawback' && refund > 0) {
        refunds.refunded_orders++;
        refunds.refund_amount += refund;
        refunds.clawback += refund;
      }
      const perChannel = new Map();
      for (const t of inWindow) {
        const k = `${t.channel}|${t.campaign}`;
        perChannel.set(k, (perChannel.get(k) || 0) + 1);
      }
      for (const [k, n] of perChannel) {
        const [channel, campaign] = k.split('|');
        ensureChannel(channel, campaign, isOrganicChannel(channel)).touch_count += n;
      }

      const pathChannels = compressPath(inWindow.map((t) => t.channel));
      const pathKey = pathChannels.join(' > ');
      let path = pathMap.get(pathKey);
      if (!path) {
        path = {
          path: pathChannels,
          path_key: pathKey,
          attributed_conversions: 0,
          value: 0,
          touch_total: 0,
          cross_device: 0,
        };
        pathMap.set(pathKey, path);
      }
      path.attributed_conversions++;
      path.value += net;
      path.touch_total += inWindow.length;
      if (journey.devices.length > 1) path.cross_device++;

      rows.push({
        ...base,
        status: 'attributed',
        net_value: round2(net),
        allocations,
        primary_touch_id: allocations.reduce((a, b) => (b.credit > a.credit ? b : a), allocations[0]).touch_id,
      });
    }
  }

  const attributedTotal = [...channels.values()].reduce((a, r) => a + r.credit, 0);
  const touchTotal = [...channels.values()].reduce((a, r) => a + r.touch_count, 0);
  const channelRows = [...channels.values()]
    .map((r) => ({
      channel: r.channel,
      campaign: r.campaign,
      kind: r.kind,
      is_organic: r.is_organic,
      credit: round2(r.credit),
      raw_credit: round2(r.raw_credit),
      refund_clawback: round2(r.refund_clawback),
      attributed_conversions: round2(r.attributed_conversions),
      touch_count: r.touch_count,
      share: attributedTotal > 0 ? round6(r.credit / attributedTotal) : 0,
      touch_share: touchTotal > 0 ? round6(r.touch_count / touchTotal) : 0,
    }))
    .sort((a, b) => b.credit - a.credit || a.channel.localeCompare(b.channel));

  const paths = [...pathMap.values()]
    .map((p) => ({ ...p, value: round2(p.value) }))
    .sort((a, b) => b.value - a.value || b.attributed_conversions - a.attributed_conversions)
    .slice(0, 30)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const attributedValue = round2(attributedTotal);
  // 净额口径：全部未整单剔除的转化净额之和 = 已归因 + 无法归因（全额退款为 0）。
  const netTotal = round2(rows.reduce((a, r) => a + (r.status === 'excluded_refund' ? 0 : r.net_value), 0));
  const totals = {
    conversions: rows.length,
    attributed_conversions: rows.filter((r) => r.status === 'attributed').length,
    unattributed_conversions: rows.filter((r) => r.status === 'unattributed').length,
    excluded_conversions: rows.filter((r) => r.status === 'excluded_refund').length,
    gross_value: round2(rows.reduce((a, r) => a + r.gross_value, 0)),
    net_value: netTotal,
    attributed_value: attributedValue,
    refund_clawback: round2(refunds.clawback),
    refunded_value: round2(refunds.refund_amount),
    late_conversions: lateConversionsIncluded,
    late_conversion_value: round2(lateConversionValue),
    cross_device_conversions: crossDeviceConversions,
    cross_device_value: round2(crossDeviceValue),
    post_conversion_touches: postConversionTouchCount,
    unattributed_share: 0,
  };
  totals.unattributed_share = totals.net_value > 0 ? round6(unattributed.net_value / totals.net_value) : 0;
  for (const k of Object.keys(unattributed.reason_value)) unattributed.reason_value[k] = round2(unattributed.reason_value[k]);
  unattributed.net_value = round2(unattributed.net_value);
  unattributed.gross_value = round2(unattributed.gross_value);

  return {
    engine_version: ENGINE_VERSION,
    model: {
      id: model.id,
      version: model.version,
      label: model.label,
      summary: model.summary,
      caveat: model.caveat,
      supersedes: model.supersedes || null,
    },
    params: normalized,
    refund_policy: policy,
    channel_rows: channelRows,
    conversion_rows: rows,
    paths,
    totals,
    unattributed,
    refunds,
  };
}

/** 贡献迁移：两个固定结果逐渠道对比。 */
export function migrateContributions(oldResult, newResult) {
  const map = new Map();
  const ensure = (channel, campaign) => {
    const key = `${channel}|${campaign}`;
    let r = map.get(key);
    if (!r) {
      r = { channel, campaign, kind: 'paid', old_credit: 0, new_credit: 0, old_share: 0, new_share: 0 };
      map.set(key, r);
    }
    return r;
  };
  for (const r of oldResult.channel_rows) {
    const row = ensure(r.channel, r.campaign);
    row.old_credit = r.credit;
    row.old_share = r.share;
    row.kind = r.kind;
  }
  for (const r of newResult.channel_rows) {
    const row = ensure(r.channel, r.campaign);
    row.new_credit = r.credit;
    row.new_share = r.share;
    row.kind = r.kind || row.kind;
  }
  const rows = [...map.values()]
    .map((r) => ({
      ...r,
      delta_credit: round2(r.new_credit - r.old_credit),
      delta_share: round6(r.new_share - r.old_share),
    }))
    .sort((a, b) => Math.abs(b.delta_credit) - Math.abs(a.delta_credit));

  const changedConfig = {
    model_version: oldResult.model.version !== newResult.model.version,
    model: oldResult.model.id !== newResult.model.id,
    params: stableStringify(oldResult.params) !== stableStringify(newResult.params),
    refund_policy: oldResult.refund_policy !== newResult.refund_policy,
  };
  return {
    rows,
    changes: changedConfig,
    old: summarizeResult(oldResult),
    new: summarizeResult(newResult),
  };
}

export function summarizeResult(result) {
  return {
    model: result.model,
    params: result.params,
    refund_policy: result.refund_policy,
    totals: result.totals,
    unattributed: result.unattributed,
  };
}

/** 敏感性变体；保持稳定顺序，便于跨运行比较。 */
export function sensitivityVariants(modelId, version) {
  const model = getModel(modelId, version);
  const variants = [];
  const add = (label, params) => variants.push({ label, params: normalizeParams(modelId, params, model.version) });
  add('基线', {});
  for (const days of [7, 30, 90]) add(`回看窗口 ${days} 天`, { lookback_days: days });
  add('剔除直接访问', { include_direct: false });
  add('剔除自然流量', { include_organic: false });
  if (model.id === 'time_decay') {
    for (const half of [24, 168, 720]) {
      add(`半衰期 ${half} 小时`, { half_life_hours: half });
      add(`半衰期 ${half} 小时 · 剔除直访`, { half_life_hours: half, include_direct: false });
    }
  }
  if (model.id === 'last_touch' && model.version === '1.1.0') {
    add('关闭直接访问回退', { direct_fallback: false });
  }
  const seen = new Set();
  return variants.filter((v) => {
    const k = stableStringify(v.params);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 敏感性分析：同一快照下改变参数，观察份额区间与排名翻转。 */
export function sensitivity({ modelId, modelVersion, baseParams, journeys, refundPolicy }) {
  const model = getModel(modelId, modelVersion);
  const variants = sensitivityVariants(modelId, model.version);
  const runs = variants.map((v) => {
    const params = { ...normalizeParams(modelId, baseParams, model.version), ...v.params };
    const result = attribute({ modelId, modelVersion: model.version, params, journeys, refundPolicy });
    return { label: v.label, params, result };
  });
  // 每个变体都建立完整的渠道快照；变体中缺席的渠道按 0 计入，避免区间漏掉 0。
  const channelMap = new Map();
  for (const run of runs) {
    const present = new Set();
    for (const row of run.result.channel_rows) present.add(`${row.channel}|${row.campaign}`);
    for (const key of present) {
      if (!channelMap.has(key)) {
        const row = run.result.channel_rows.find((r) => `${r.channel}|${r.campaign}` === key);
        channelMap.set(key, {
          channel: row.channel,
          campaign: row.campaign,
          kind: row.kind,
          shares: [],
          credits: [],
          ranks: [],
          present: 0,
        });
      }
    }
  }
  for (const run of runs) {
    const byKey = new Map(run.result.channel_rows.map((r) => [`${r.channel}|${r.campaign}`, r]));
    const ranked = [...run.result.channel_rows].sort((a, b) => b.credit - a.credit);
    const rankByKey = new Map(ranked.map((r, i) => [`${r.channel}|${r.campaign}`, i + 1]));
    for (const [key, c] of channelMap) {
      const row = byKey.get(key);
      c.shares.push(row ? row.share : 0);
      c.credits.push(row ? row.credit : 0);
      if (row) { c.ranks.push(rankByKey.get(key)); c.present++; }
    }
  }
  const base = runs[0];
  const baseRanked = [...base.result.channel_rows].sort((a, b) => b.credit - a.credit);
  const baseByKey = new Map(baseRanked.map((r, i) => [`${r.channel}|${r.campaign}`, { row: r, rank: i + 1 }]));
  const channels = [...channelMap.values()]
    .map((c) => {
      const b = baseByKey.get(`${c.channel}|${c.campaign}`);
      const minShare = Math.min(...c.shares);
      const maxShare = Math.max(...c.shares);
      return {
        channel: c.channel,
        campaign: c.campaign,
        kind: c.kind,
        base_share: b ? b.row.share : 0,
        base_credit: b ? b.row.credit : 0,
        min_share: round6(minShare),
        max_share: round6(maxShare),
        share_range: round6(maxShare - minShare),
        min_credit: round2(Math.min(...c.credits)),
        max_credit: round2(Math.max(...c.credits)),
        best_rank: c.ranks.length ? Math.min(...c.ranks) : null,
        worst_rank: c.ranks.length ? Math.max(...c.ranks) : null,
        rank_flip: c.ranks.length ? Math.max(...c.ranks) > Math.min(...c.ranks) : false,
        base_rank: b ? b.rank : null,
        missing_in_variants: c.present < runs.length,
        present_in_variants: c.present,
      };
    })
    .sort((a, b) => b.base_credit - a.base_credit);

  const variantRows = runs.map((run) => {
    const obj = { __label: run.label, __attributed_value: run.result.totals.attributed_value };
    for (const row of run.result.channel_rows) obj[row.channel] = row.share;
    return obj;
  });

  return {
    model: { id: model.id, version: model.version, label: model.label },
    refund_policy: normalizeRefundPolicy(refundPolicy),
    variants: runs.map((r) => ({ label: r.label, params: r.params })),
    variant_rows: variantRows,
    channels,
    summary: {
      variant_count: variants.length,
      channels_with_rank_flip: channels.filter((c) => c.rank_flip).length,
      max_share_range: round6(channels.reduce((a, c) => Math.max(a, c.share_range), 0)),
    },
  };
}

/** 结果指纹：校验重算一致性（不含时间戳，只覆盖业务输出）。 */
export function resultHash(result) {
  return fnv1a(stableStringify({
    engine_version: result.engine_version,
    model: result.model,
    params: result.params,
    refund_policy: result.refund_policy,
    channel_rows: result.channel_rows,
    conversion_rows: result.conversion_rows,
    paths: result.paths,
    totals: result.totals,
    unattributed: result.unattributed,
    refunds: result.refunds,
  }));
}
