// Writer Fence 多进程测试用的真实子进程。
//
// 为什么必须起子进程：Writer Fence 要解决的是「不同进程同时写同一个 Session」，
// 在同一个进程里造两个对象永远测不出 SQLite 行锁、pid 存活判断、以及
// 「进程被强杀后事务没提交」这几种情况。
//
// 用法：node tests/support/fence-child.mjs <mode> --db <path> --sid <id> [--ttl ms] [--hold ms] [--crash <point>]
// 输出：stdout 每行一个 JSON（父进程按行解析），stderr 放诊断。

import { openDb } from '../../src/candidate/db.mjs';
import { createWriterFence } from '../../src/candidate/writer-fence.mjs';
import { crashpoint } from './crashpoint.mjs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
};

const dbPath = opt('db');
const sid = opt('sid', 'session-child');
const ttl = Number(opt('ttl', '30000'));
const hold = Number(opt('hold', '0'));
const crashAt = opt('crash', null);
if (crashAt) process.env.OPENCORE_CRASH_AT = crashAt;

if (!mode || !dbPath) {
  console.error('usage: fence-child.mjs <mode> --db <path> --sid <id>');
  process.exit(2);
}

const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

function open() {
  return openDb(dbPath, { busyTimeoutMs: 2000 });
}

async function waitForStdinLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', (line) => { rl.close(); resolve(String(line).trim()); });
  });
}

async function main() {
  const db = open();
  const fence = createWriterFence({ db, defaultLeaseMs: ttl });

  if (mode === 'claim') {
    const res = fence.claim({ sessionId: sid, writerIdentity: 'child', ttlMs: ttl });
    out({ ok: true, ...res });
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    db.close();
    return;
  }

  if (mode === 'claim-and-hold') {
    try {
      const res = fence.claim({ sessionId: sid, writerIdentity: 'child', ttlMs: ttl });
      out({ ok: true, ...res });
    } catch (error) {
      out({ ok: false, code: error.code, message: error.message });
    }
    // 保持进程存活，直到父进程关闭 stdin 或 hold 到期。
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    else await new Promise((r) => process.stdin.on('end', r).resume());
    db.close();
    return;
  }

  if (mode === 'delayed-commit') {
    // 先按旧 revision 取得所有权，把 (runId, revision) 报给父进程；
    // 父进程在此期间让另一个 writer 接管（revision+1），再让本进程尝试提交。
    const res = fence.claim({ sessionId: sid, writerIdentity: 'child-old', ttlMs: ttl });
    out({ ok: true, phase: 'claimed', runId: res.runId, revision: res.revision });
    const line = await waitForStdinLine();
    if (line !== 'commit') { out({ ok: false, phase: 'aborted' }); db.close(); return; }
    try {
      const r = fence.withFence({ sessionId: sid, runId: res.runId, revision: res.revision }, (txdb) => {
        txdb.prepare('INSERT INTO session_event(session_id, run_id, revision, kind, payload, at_ms) VALUES (?,?,?,?,?,?)')
          .run(sid, res.runId, res.revision, 'stale-write', 'should-not-land', Date.now());
        return 'committed';
      });
      out({ ok: true, phase: 'commit', result: r });
    } catch (error) {
      out({ ok: false, phase: 'commit', code: error.code, message: error.message, detail: error.detail ?? null });
    }
    db.close();
    return;
  }

  if (mode === 'kill-in-tx') {
    const res = fence.claim({ sessionId: sid, writerIdentity: 'child-kill', ttlMs: ttl });
    out({ ok: true, phase: 'claimed', runId: res.runId, revision: res.revision });
    try {
      fence.withFence({ sessionId: sid, runId: res.runId, revision: res.revision }, (txdb) => {
        txdb.prepare('INSERT INTO session_event(session_id, run_id, revision, kind, payload, at_ms) VALUES (?,?,?,?,?,?)')
          .run(sid, res.runId, res.revision, 'will-rollback', 'must-not-survive', Date.now());
        crashpoint(crashAt || 'inside-tx');
        return 'unreachable';
      });
    } catch (error) {
      out({ ok: false, code: error.code, message: error.message });
    }
    db.close();
    return;
  }

  if (mode === 'stress-claim') {
    // 反复抢同一个 session：成功/失败都统计，用于锁竞争与不变量检查。
    let ok = 0; let busy = 0; let other = 0;
    const rounds = Number(opt('rounds', '20'));
    for (let i = 0; i < rounds; i += 1) {
      try {
        const res = fence.claim({ sessionId: sid, writerIdentity: 'stress', ttlMs: 200 });
        fence.release({ sessionId: sid, runId: res.runId, revision: res.revision });
        ok += 1;
      } catch (error) {
        if (error.code === 'writer-busy') busy += 1;
        else { other += 1; console.error('stress-other', error.code, error.message); }
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    out({ ok: true, phase: 'stress', succeeded: ok, busy, other });
    db.close();
    return;
  }

  out({ ok: false, phase: 'unknown-mode', mode });
  db.close();
}

main().then(() => {
  // 子进程的 stdin 是管道，句柄不关会让 Node 一直存活，父进程 waitExit 就会挂住。
  try { process.stdin.destroy(); } catch { /* ignore */ }
  process.exit(0);
}).catch((error) => {
  out({ ok: false, phase: 'fatal', code: error?.code, message: String(error?.message ?? error) });
  try { process.stdin.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
