// 候选版本共享数据层：单一 SQLite（node:sqlite），显式迁移，显式事务。
//
// 为什么是 node:sqlite：项目 engines 已要求 node >= 22.13，本机是 24.x；
// 用内置模块可以满足「不引入没有必要的第三方运行时依赖」。
//
// 为什么所有写事务都 BEGIN IMMEDIATE：Writer Fence 与 Delivery Outbox 的正确性
// 依赖「先拿写锁、再 fresh read、再判断、再写」；DEFERRED 事务会先拿读锁，
// 两个进程都可能读到同一份旧状态，正是要避免的 race。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CandidateError, ERR } from './errors.mjs';
import { sha256Hex, nowMs, ensureDir } from './util.mjs';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function resolveMigrationsDir(explicit) {
  if (explicit) return explicit;
  if (process.env.OPENCORE_MIGRATIONS_DIR) return process.env.OPENCORE_MIGRATIONS_DIR;
  return MIGRATIONS_DIR;
}

const isBusy = (error) => {
  const text = `${error?.code ?? ''} ${error?.message ?? ''} ${error?.errstr ?? ''}`;
  return /SQLITE_BUSY|database is locked|database table is locked|SQLITE_LOCKED/i.test(text);
};

/**
 * 打开（必要时创建）候选数据库。
 * @param {string} dbPath
 * @param {{readOnly?: boolean, busyTimeoutMs?: number, migrationsDir?: string, migrate?: boolean}} [opts]
 */
export function openDb(dbPath, opts = {}) {
  const { readOnly = false, busyTimeoutMs = 8000, migrationsDir = null, migrate = true } = opts;
  if (!readOnly) ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath, { readOnly });
  try { db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)}`); } catch { /* ignore */ }
  if (!readOnly) {
    try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 只读镜像/无 WAL 权限时降级 */ }
    try { db.exec('PRAGMA synchronous = FULL'); } catch { /* ignore */ }
  }
  if (migrate && !readOnly) applyMigrations(db, migrationsDir);
  return db;
}

/** 顺序应用 migrations/*.sql，记录版本 + checksum。重复调用是幂等的、并发调用是安全的。 */
export function applyMigrations(db, migrationsDir = null) {
  const dir = resolveMigrationsDir(migrationsDir);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL, checksum TEXT NOT NULL)`);
  const files = fs.readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((a, b) => Number(a.slice(0, 3)) - Number(b.slice(0, 3)));
  for (const name of files) {
    const version = Number(name.slice(0, 3));
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const checksum = sha256Hex(sql);
    // 注意：不能在事务外「先读已应用版本再进事务」——多个进程同时首次打开同一个
    // 新库时会一起判定「未应用」，然后第二个进程 INSERT 主键冲突。正确做法是
    // 进写事务后再 fresh read 一次，让 SQLite 的写锁替我们串行化。
    tx(db, () => {
      const applied = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(version);
      if (applied) {
        if (String(applied.checksum) !== checksum) {
          throw new CandidateError(ERR.CONTRACT, `迁移 ${name} 的 checksum 与已应用版本不一致（拒绝对已上线 schema 静默改写）`, {
            version, applied: String(applied.checksum), current: checksum,
          });
        }
        return 'already-applied';
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at_ms, checksum) VALUES (?,?,?,?)')
        .run(version, name, nowMs(), checksum);
      return 'applied';
    }, { retries: 200 });
  }
  return files.length;
}

/**
 * BEGIN IMMEDIATE 事务。fn 接收 db；fn 抛错则 ROLLBACK 并原样抛出。
 * busy 时做有限重试（SQLite 自己的 busy_timeout 先等，这里兜底抖动）。
 */
export function tx(db, fn, { retries = 25, busyTimeoutMs = 8000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (isBusy(error) && attempt < retries) {
        attempt += 1;
        sleepSync(Math.min(200, 5 * attempt) + Math.floor(Math.random() * 10));
        continue;
      }
      throw new CandidateError(ERR.UPSTREAM, `无法获取写事务（SQLite busy）：${String(error?.message ?? error)}`);
    }
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }
}

/** busy 重试用的同步休眠（不引入 async 传染到事务体）。 */
function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 只读计数（诊断/报告用）。 */
export function tableCounts(db) {
  const out = {};
  for (const t of ['writer_claim', 'writer_audit', 'memory_registry', 'memory_reservation', 'memory_audit', 'delivery', 'delivery_attempt', 'delivery_part_receipt', 'preset_registry', 'session_binding']) {
    try { out[t] = Number(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c); } catch { out[t] = null; }
  }
  return out;
}

export { isBusy };
