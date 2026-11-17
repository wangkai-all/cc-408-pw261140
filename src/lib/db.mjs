import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, 'schema.sql');
const DEFAULT_DB = resolve(HERE, '../../var/events.db');

export function dbPath() {
  return process.env.EQS_DB ? resolve(process.env.EQS_DB) : DEFAULT_DB;
}

let cached = null;

export function openDb({ file = dbPath(), create = true } = {}) {
  if (cached && cached.file === file) return cached.db;
  const dir = dirname(file);
  if (create) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  cached = { file, db };
  return db;
}

export function closeDb() {
  if (cached) {
    cached.db.close();
    cached = null;
  }
}

/** Drop the store file (and WAL sidecars). Append-only triggers make row-level reset impossible. */
export function resetDatabaseFile(file = dbPath()) {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${file}${suffix}`, { force: true });
  }
}

export function tx(db, fn, mode = 'IMMEDIATE') {
  if (db.isTransaction) return fn();
  db.exec(`BEGIN ${mode}`);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function nextSequence(db) {
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES ('job_sequence', 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get();
  return row.value;
}

export function audit(db, { actor, action, entity, entityId = null, detail = null }) {
  db.prepare(
    'INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    new Date().toISOString(),
    actor,
    action,
    entity,
    entityId == null ? null : String(entityId),
    detail == null ? null : JSON.stringify(detail),
  );
}
