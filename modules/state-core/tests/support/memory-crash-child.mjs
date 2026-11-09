// 跨介质崩溃窗口测试用的真实子进程。
//
// 它在 hooks.beforeRegistryCommit（writeFileAtomic 已完成、memory_registry 尚未提交）处
// 直接 SIGKILL 自己，用来证明「先落盘、后落库」留下的中间状态会被 reconcile() 判成
// drift 并继续 fail-closed，而不是被当成已提交。
//
// 只通过环境变量接收参数、只打印/写 marker 文件，不联网、不碰其他目录。

import fs from 'node:fs';
import { openDb } from '../../src/candidate/db.mjs';
import { createMemoryStore } from '../../src/candidate/memory-provenance.mjs';

const env = process.env;
const root = env.MEMORY_CRASH_ROOT;
const dbPath = env.MEMORY_CRASH_DB;
const relPath = env.MEMORY_CRASH_REL;
const reservationId = env.MEMORY_CRASH_RESERVATION;
const expectedHash = env.MEMORY_CRASH_EXPECTED_HASH;
const writerIdentity = env.MEMORY_CRASH_WRITER ?? 'authority';
const content = Buffer.from(env.MEMORY_CRASH_CONTENT_B64 ?? '', 'base64').toString('utf8');
const marker = env.MEMORY_CRASH_MARKER;
const mode = env.MEMORY_CRASH_MODE ?? 'kill';

if (!root || !dbPath || !relPath || !reservationId || !expectedHash || !marker) {
  process.stderr.write('missing env for crash child\n');
  process.exit(64);
}

const db = openDb(dbPath, { migrate: false });
const store = createMemoryStore({
  root,
  db,
  hooks: {
    beforeRegistryCommit: () => {
      fs.writeFileSync(marker, JSON.stringify({
        mode,
        pid: process.pid,
        atMs: Date.now(),
        relPath,
        reservationId,
      }), 'utf8');
      if (mode === 'kill') {
        // Windows 上 libuv 的 SIGKILL 走 TerminateProcess，子进程不会执行后续任何代码，
        // 数据库连接也不会正常关闭 —— 这正是要复现的「跨介质崩溃」。
        process.kill(process.pid, 'SIGKILL');
        // 兜底：如果信号没有立刻生效，也不要继续提交 registry。
        process.exit(137);
      }
      throw new Error('crash-hook-boom');
    },
  },
});

store.write({ relPath, content, writerIdentity, reservationId, expectedHash });
// 走到这里说明崩溃注入点没有生效，测试应判失败。
process.stderr.write('crash hook did not fire\n');
process.exit(65);
