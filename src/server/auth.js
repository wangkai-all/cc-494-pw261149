import { randomUUID, timingSafeEqual } from 'node:crypto';
import { openDb, nowIso, audit } from './db.js';

export const ROLES = {
  viewer: {
    id: 'viewer',
    label: '查看者',
    canExport: [],
    canRun: false,
    canUpload: false,
    description: '可查看全部结果与数据质量，不可导出、不可新建运行。',
  },
  analyst: {
    id: 'analyst',
    label: '分析师',
    canExport: ['csv'],
    canRun: true,
    canUpload: true,
    description: '可新建快照与运行、导出 CSV；JSON 与审计导出需要管理员。',
  },
  admin: {
    id: 'admin',
    label: '管理员',
    canExport: ['csv', 'json', 'audit'],
    canRun: true,
    canUpload: true,
    description: '全部权限，包含 JSON / 审计日志导出与版本发布。',
  },
};

export const DEMO_USERS = [
  { id: 'u_admin', name: '林岚', role: 'admin', title: '归因平台负责人' },
  { id: 'u_analyst', name: '周迅', role: 'analyst', title: '增长分析师' },
  { id: 'u_viewer', name: '陈默', role: 'viewer', title: '市场总监' },
];

const SESSION_TTL_MS = 12 * 3600 * 1000;
const COOKIE = 'attr_session';

export function seedUsers() {
  const db = openDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO users (id, name, role, title, created_at) VALUES (?,?,?,?,?)');
  for (const u of DEMO_USERS) insert.run(u.id, u.name, u.role, u.title, nowIso());
}

export function listUsers() {
  return openDb().prepare('SELECT id, name, role, title FROM users ORDER BY role DESC').all();
}

export function userById(id) {
  return openDb().prepare('SELECT id, name, role, title FROM users WHERE id = ?').get(id) || null;
}

export function createSession(userId) {
  const db = openDb();
  const user = userById(userId);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 401;
    throw err;
  }
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    id,
    userId,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString()
  );
  return { id, user, expires_at: new Date(now + SESSION_TTL_MS).toISOString() };
}

export function destroySession(sessionId) {
  if (!sessionId) return;
  openDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function resolveSession(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const sessionId = decodeURIComponent(match[1]);
  const db = openDb();
  const row = db
    .prepare('SELECT s.id, s.expires_at, u.id AS user_id, u.name, u.role, u.title FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .get(sessionId);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    destroySession(sessionId);
    return null;
  }
  return {
    sessionId: row.id,
    user: { id: row.user_id, name: row.name, role: row.role, title: row.title },
    role: ROLES[row.role],
  };
}

export function sessionCookie(sessionId) {
  return `${COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 恒定时间比较，避免 token 侧信道（用于未来扩展的 API key）。 */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireSession(ctx) {
  if (!ctx || !ctx.user) {
    const err = new Error('未登录');
    err.status = 401;
    throw err;
  }
  return ctx;
}

function capabilityAllowed(ctx, capability) {
  return capability === 'export_csv'
    ? ctx.role.canExport.includes('csv')
    : capability === 'export_json'
      ? ctx.role.canExport.includes('json')
      : capability === 'export_audit'
        ? ctx.role.canExport.includes('audit')
        : capability === 'run'
          ? ctx.role.canRun
          : capability === 'upload'
            ? ctx.role.canUpload
            : false;
}

/** 断言已登录且具备能力；否则抛出 401 / 403。 */
export function requireRole(ctx, capability) {
  requireSession(ctx);
  if (!capabilityAllowed(ctx, capability)) {
    const err = new Error('当前角色无此操作权限');
    err.status = 403;
    throw err;
  }
}

export function logAction(ctx, action, objectType, objectId, detail) {
  audit({
    userId: ctx.user.id,
    userName: ctx.user.name,
    action,
    objectType,
    objectId,
    detail,
  });
}

export function permissionMatrix() {
  return Object.values(ROLES).map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
    can_export_csv: r.canExport.includes('csv'),
    can_export_json: r.canExport.includes('json'),
    can_export_audit: r.canExport.includes('audit'),
    can_run: r.canRun,
    can_upload: r.canUpload,
  }));
}

export const SESSION_COOKIE_NAME = COOKIE;
