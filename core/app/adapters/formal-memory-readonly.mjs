import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function readMemoryDocs(dir) {
  const docs = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  return docs.map((name) => ({ name, bytes: fs.statSync(`${dir}\\${name}`).size, sha256: sha256(`${dir}\\${name}`) }));
}

export function inspectMemoryDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const counts = {};
    for (const table of tables) {
      try { counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM "${table.replace(/"/g, '""')}"`).get().c; }
      catch (error) { counts[table] = { error: String(error.message) }; }
    }
    return { dbPath, integrity, tables, counts };
  } finally { db.close(); }
}

export function proveReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('CREATE TABLE __must_not_exist (id INTEGER)');
    return { blocked: false, error: null };
  } catch (error) {
    return { blocked: true, error: String(error.message), code: error.code ?? null };
  } finally { db.close(); }
}

export function createReadOnlyMemoryApi({ backupDbPath, docsDir }) {
  return {
    mode: 'read-only',
    readDocs: () => readMemoryDocs(docsDir),
    inspect: () => inspectMemoryDb(backupDbPath),
    proveReadOnly: () => proveReadOnly(backupDbPath),
    write() { throw new Error('READ_ONLY: formal authority memory is not writable from staging'); },
    reserve() { throw new Error('READ_ONLY: formal memory CAS is not writable from staging'); },
  };
}
