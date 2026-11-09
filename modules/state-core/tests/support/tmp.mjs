// 测试公共设施：临时目录、子进程、逐行 JSON 解析。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
export const CHILD_DIR = path.join(REPO, 'tests', 'support');

export function tempDir(tag) {
  const dir = path.join(REPO, 'data', `test-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 起一个真实子进程，返回 { child, next(), send(), waitExit(), stderr() }。 */
export function spawnChild(scriptRel, args = [], { env = {}, cwd = REPO } = {}) {
  const script = path.isAbsolute(scriptRel) ? scriptRel : path.join(CHILD_DIR, scriptRel);
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const queue = [];
  const waiters = [];
  let stderrText = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { value = { raw: line }; }
      if (waiters.length) waiters.shift().resolve(value);
      else queue.push(value);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrText += chunk; });

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  return {
    child,
    stderr: () => stderrText,
    send(line) { child.stdin.write(line + '\n'); },
    closeStdin() { try { child.stdin.end(); } catch { /* ignore */ } },
    next(timeoutMs = 10000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待子进程 JSON 超时（${timeoutMs}ms）；stderr=${stderrText.slice(-800)}`)), timeoutMs);
        waiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    waitExit(timeoutMs = 15000) {
      return Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`子进程退出超时；stderr=${stderrText.slice(-800)}`)), timeoutMs)),
      ]);
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* ignore */ } },
  };
}

export function parseArgs(map) {
  const out = [];
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === null) continue;
    out.push(`--${k}`, String(v));
  }
  return out;
}
