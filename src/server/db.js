import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
export const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'attribution.sqlite3');

let db;

export function openDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer','analyst','admin')),
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'seed',
      hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      conversion_count INTEGER NOT NULL,
      identity_count INTEGER NOT NULL,
      date_from TEXT,
      date_to TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      snapshot_hash TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      param_hash TEXT NOT NULL,
      params TEXT NOT NULL,
      refund_policy TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      label TEXT NOT NULL,
      result TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      supersedes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runs_fingerprint ON runs(fingerprint);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}'
    );
  `);
  // 迁移：早期数据库缺列时补齐（保持向后兼容）。
  const cols = new Set(d.prepare('PRAGMA table_info(runs)').all().map((c) => c.name));
  if (!cols.has('supersedes')) d.exec('ALTER TABLE runs ADD COLUMN supersedes TEXT');
}

export function nowIso() {
  return new Date().toISOString();
}

export function audit({ userId, userName, action, objectType, objectId = null, detail = {} }) {
  openDb().prepare(
    'INSERT INTO audit_log (ts, user_id, user_name, action, object_type, object_id, detail) VALUES (?,?,?,?,?,?,?)'
  ).run(nowIso(), userId, userName, action, objectType, objectId, JSON.stringify(detail));
}

export function listAudit(limit = 200) {
  return openDb()
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(Number(limit))
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

export function resetDb() {
  const d = openDb();
  d.exec('DELETE FROM sessions; DELETE FROM runs; DELETE FROM snapshots; DELETE FROM audit_log; DELETE FROM users;');
}
