// 记忆测试的公共夹具：所有测试都必须在 data/test-memory-* 下跑，绝不碰真实 ~/.dsh/memory。
// 每个测试文件各自创建一个（或多个）沙箱，跑完删除；设置 OPENCORE_KEEP_TEST_DATA=1 可保留证据。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomHex } from '../../src/candidate/util.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SUPPORT_DIR = path.join(REPO_ROOT, 'tests', 'support');
export const DATA_DIR = path.join(REPO_ROOT, 'data');

export function createSandbox(label) {
  const dir = path.join(DATA_DIR, `test-memory-${label}-${randomHex(6)}`);
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  return {
    dir,
    memoryDir,
    dbPath: path.join(dir, 'memory.sqlite'),
    abs: (relPath) => path.join(memoryDir, ...String(relPath).split('/')),
    dispose() {
      if (process.env.OPENCORE_KEEP_TEST_DATA) return;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedMemory(memoryDir, relPath, content) {
  const absPath = path.join(memoryDir, ...String(relPath).split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

export function auditRows(db, { path: relPath, kind } = {}) {
  const filters = [];
  const params = [];
  if (relPath !== undefined) {
    filters.push('path = ?');
    params.push(relPath);
  }
  if (kind !== undefined) {
    filters.push('kind = ?');
    params.push(kind);
  }
  const sql = `SELECT * FROM memory_audit${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY id`;
  return db.prepare(sql).all(...params);
}

export function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
}

/** 起一个真实子进程；返回 { child, done }，done 在 exit 时 resolve。 */
export function spawnChild(scriptPath, extraEnv = {}, { timeoutMs = 60000 } = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...extraEnv },
    // 不捕获 stdout/stderr：避免受限环境下 piped stdio 的问题，子进程需要回传就写文件。
    stdio: 'ignore',
    windowsHide: true,
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`子进程超时（${timeoutMs}ms）：${scriptPath}`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return { child, done };
}

export function runChild(scriptPath, extraEnv = {}, options = {}) {
  return spawnChild(scriptPath, extraEnv, options).done;
}

export async function waitForFile(absPath, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(absPath)) {
    if (Date.now() > deadline) throw new Error(`等待文件超时：${absPath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
