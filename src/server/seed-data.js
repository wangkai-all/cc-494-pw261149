/**
 * 确定性种子数据。
 *
 * 刻意注入的数据质量问题（用于验证）：
 *  - 跨设备身份：同一 identity 下 2 台设备（部分事件仅带 device_id，需身份链接表）
 *  - 自然流量：organic_search / direct / referral 混合
 *  - 退款：部分退款 + 全额退款
 *  - 窗口边缘：仅有 45 天前触点的旅程（30 天窗口下无法归因）
 *  - 重复事件 / 重复转化
 *  - 迟到转化：received_at 晚于转化时间 30–80 小时
 *  - 无触点转化
 */
import { hashPayload } from '../lib/attribution.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400000;
const HOUR = 3600000;
export const SEED_END = Date.UTC(2026, 10, 15, 23, 59, 0); // 2026-11-15
export const SEED_START = SEED_END - 120 * DAY;

const PAID_CHANNELS = [
  { channel: 'paid_search', campaigns: ['品牌词', '品类词', '竞品词'], weight: 0.26 },
  { channel: 'paid_social', campaigns: ['信息流-拉新', '短视频-种草'], weight: 0.24 },
  { channel: 'display', campaigns: ['开屏-品牌', '联盟-Banner'], weight: 0.12 },
  { channel: 'affiliate', campaigns: ['返利网', '比价站'], weight: 0.08 },
  { channel: 'email', campaigns: ['会员唤醒', '购物车挽回'], weight: 0.1 },
];
const ORGANIC_CHANNELS = [
  { channel: 'organic_search', campaigns: ['(organic)'], weight: 0.1 },
  { channel: 'direct', campaigns: ['(direct)'], weight: 0.08 },
  { channel: 'referral', campaigns: ['(referral)'], weight: 0.02 },
];

function pickChannel(rnd) {
  const r = rnd();
  let acc = 0;
  for (const c of PAID_CHANNELS) {
    acc += c.weight;
    if (r < acc) return { channel: c.channel, campaign: c.campaigns[Math.floor(rnd() * c.campaigns.length)] };
  }
  for (const c of ORGANIC_CHANNELS) {
    acc += c.weight;
    if (r < acc) return { channel: c.channel, campaign: c.campaigns[0] };
  }
  return { channel: 'direct', campaign: '(direct)' };
}

export function buildSeedDataset() {
  const rnd = mulberry32(20261118);
  const events = [];
  const conversions = [];
  const identityLinks = {};
  let eventSeq = 0;
  let convSeq = 0;

  const addEvent = (row) => {
    events.push({ event_id: `ev_${String(++eventSeq).padStart(5, '0')}`, ...row });
  };

  const profiles = [
    ['paid_search', 'brand'],
    ['paid_social', 'social'],
    ['display', 'awareness'],
    ['organic_search', 'organic'],
    ['email', 'crm'],
  ];

  const userCount = 260;
  for (let u = 0; u < userCount; u++) {
    const identity = `id_${String(u).padStart(4, '0')}`;
    const userId = `u_${String(u).padStart(4, '0')}`;
    const crossDevice = rnd() < 0.34;
    const desktop = `dev_desk_${String(u).padStart(4, '0')}`;
    const mobile = `dev_mob_${String(u).padStart(4, '0')}`;
    const devices = crossDevice ? [desktop, mobile] : [rnd() < 0.6 ? mobile : desktop];
    for (const d of devices) identityLinks[d] = identity;

    const entry = pickChannel(rnd);
    const firstTs = SEED_START + Math.floor(rnd() * 100 * DAY);
    const touchCount = 1 + Math.floor(rnd() * 6);
    const journeyTouches = [];
    let ts = firstTs;

    const entryCampaign = entry.campaign === '(organic)' && entry.channel === 'organic_search' ? '(organic)' : entry.campaign;
    const firstDevice = devices[0];
    // 首触点：部分用户只带 device_id（需要身份链接），部分带 identity。
    const firstEvent = {
      ts,
      identity_id: rnd() < 0.4 ? null : identity,
      user_id: null,
      device_id: firstDevice,
      channel: entry.channel,
      campaign: entryCampaign,
      source: entry.channel,
      session_id: `s_${u}_0`,
    };
    if (!firstEvent.identity_id) delete firstEvent.identity_id;
    addEvent(firstEvent);
    journeyTouches.push({ ts, ...entry, device: firstDevice });

    for (let i = 1; i < touchCount; i++) {
      ts += Math.floor((2 + rnd() * 96) * HOUR);
      if (ts > SEED_END) break;
      const c = pickChannel(rnd);
      const device = devices[Math.floor(rnd() * devices.length)];
      addEvent({
        ts,
        identity_id: crossDevice || rnd() < 0.5 ? identity : undefined,
        device_id: device,
        channel: c.channel,
        campaign: c.campaign,
        source: c.channel,
        session_id: `s_${u}_${i}`,
      });
      journeyTouches.push({ ts, ...c, device });
    }

    // 重复事件注入：2% 的用户复制一条事件（同 event_id）
    if (rnd() < 0.05 && events.length > 3) {
      const dup = events[Math.max(0, events.length - 1 - Math.floor(rnd() * 4))];
      events.push({ ...dup });
    }

    // 转化
    const convert = rnd() < 0.56;
    if (!convert) continue;
    const lastTs = journeyTouches[journeyTouches.length - 1].ts;
    let convTs = lastTs + Math.floor((0.2 + rnd() * 30) * HOUR);
    if (convTs > SEED_END) convTs = SEED_END - Math.floor(rnd() * HOUR);

    const value = Math.round((180 + rnd() * 4200) * 100) / 100;
    const refunded = rnd() < 0.09;
    const fullRefund = refunded && rnd() < 0.35;
    const late = rnd() < 0.11;
    const receivedAt = late ? new Date(convTs + Math.floor((30 + rnd() * 50) * HOUR)).toISOString() : new Date(convTs + 5 * 60000).toISOString();

    conversions.push({
      conversion_id: `cv_${String(++convSeq).padStart(5, '0')}`,
      identity_id: identity,
      device_id: devices[devices.length - 1],
      ts: new Date(convTs).toISOString(),
      received_at: receivedAt,
      value,
      currency: 'CNY',
      order_id: `ord_${String(convSeq).padStart(5, '0')}`,
      refund_amount: refunded ? (fullRefund ? value : Math.round(value * (0.15 + rnd() * 0.4) * 100) / 100) : 0,
      refund_ts: refunded ? new Date(convTs + 5 * DAY).toISOString() : null,
    });

    // 转化后的触点（自然回访，用于检测迟到/窗口边界）
    if (rnd() < 0.12) {
      const postTs = convTs + Math.floor((1 + rnd() * 6) * DAY);
      if (postTs < SEED_END) {
        addEvent({
          ts: postTs,
          identity_id: identity,
          device_id: devices[devices.length - 1],
          channel: 'direct',
          campaign: '(direct)',
          source: 'direct',
          session_id: `s_${u}_post`,
        });
      }
    }
  }

  // 无触点转化（广告屏蔽 / 线下 / 归因断链）。
  for (let i = 0; i < 14; i++) {
    const convTs = SEED_START + Math.floor(rnd() * 110 * DAY);
    const identity = `id_guest_${String(i).padStart(3, '0')}`;
    conversions.push({
      conversion_id: `cv_${String(++convSeq).padStart(5, '0')}`,
      identity_id: identity,
      device_id: null,
      ts: new Date(convTs).toISOString(),
      received_at: new Date(convTs + 4 * 60000).toISOString(),
      value: Math.round((300 + rnd() * 2600) * 100) / 100,
      currency: 'CNY',
      order_id: `ord_${String(convSeq).padStart(5, '0')}`,
      refund_amount: 0,
      refund_ts: null,
    });
  }

  // 窗口边缘旅程：只有 45–70 天前的触点，转化近期发生。
  for (let i = 0; i < 12; i++) {
    const identity = `id_stale_${String(i).padStart(3, '0')}`;
    const convTs = SEED_END - Math.floor((2 + rnd() * 18) * DAY);
    const touchTs = convTs - Math.floor((45 + rnd() * 25) * DAY);
    addEvent({
      ts: touchTs,
      identity_id: identity,
      device_id: `dev_stale_${i}`,
      channel: 'display',
      campaign: '开屏-品牌',
      source: 'display',
      session_id: `s_stale_${i}`,
    });
    conversions.push({
      conversion_id: `cv_${String(++convSeq).padStart(5, '0')}`,
      identity_id: identity,
      device_id: `dev_stale_${i}`,
      ts: new Date(convTs).toISOString(),
      received_at: new Date(convTs + 2 * 60000).toISOString(),
      value: Math.round((400 + rnd() * 1800) * 100) / 100,
      currency: 'CNY',
      order_id: `ord_${String(convSeq).padStart(5, '0')}`,
      refund_amount: 0,
      refund_ts: null,
    });
  }

  // 重复转化注入
  if (conversions.length > 10) {
    conversions.push({ ...conversions[3] });
    conversions.push({ ...conversions[17] });
  }

  // 脏数据：缺身份、坏时间戳。
  addEvent({ ts: SEED_END - 10 * DAY, channel: 'paid_search', campaign: '品牌词', source: 'paid_search', session_id: 's_bad_1' });
  addEvent({ ts: 'not-a-date', identity_id: 'id_0001', channel: 'paid_search', campaign: '品牌词', session_id: 's_bad_2' });
  addEvent({ ts: SEED_END - 20 * DAY, identity_id: 'id_0002', channel: 'paid_social', campaign: '信息流-拉新', session_id: 's_bad_3', event_id: 'ev_bad_3' });
  events.push({ event_id: 'ev_bad_3', ts: SEED_END - 20 * DAY, identity_id: 'id_0002', channel: 'paid_social', campaign: '信息流-拉新', session_id: 's_bad_3' });

  events.sort((a, b) => {
    const ta = typeof a.ts === 'number' ? a.ts : Date.parse(a.ts);
    const tb = typeof b.ts === 'number' ? b.ts : Date.parse(b.ts);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
  conversions.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const payload = {
    version: 1,
    name: '2026 Q4 全渠道归因',
    description: '确定性种子数据：含跨设备、自然流量、退款、窗口边缘、重复与迟到事件。',
    events,
    conversions,
    identityLinks,
  };
  return payload;
}

export function snapshotMeta(payload) {
  const tsList = [
    ...payload.events.map((e) => (typeof e.ts === 'number' ? e.ts : Date.parse(e.ts))),
    ...payload.conversions.map((c) => (typeof c.ts === 'number' ? c.ts : Date.parse(c.ts))),
  ].filter((t) => Number.isFinite(t));
  return {
    hash: hashPayload(payload),
    event_count: payload.events.length,
    conversion_count: payload.conversions.length,
    identity_count: new Set(payload.conversions.map((c) => c.identity_id).filter(Boolean)).size,
    date_from: tsList.length ? new Date(Math.min(...tsList)).toISOString() : null,
    date_to: tsList.length ? new Date(Math.max(...tsList)).toISOString() : null,
  };
}
