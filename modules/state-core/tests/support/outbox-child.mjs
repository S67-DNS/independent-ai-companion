// 故障注入子进程：一个**真的**独立的第二个（第三、第四个）进程。
//
// 为什么必须是真子进程而不是同进程里 try/catch 模拟：Outbox 的难点全都发生在「另一个
// 进程已经不在了」的瞬间——它写没写进 DB？它的发送到底开始没有？lease 算谁的？
// 同进程里的异常永远带走不了 OS 层面的进程死亡证据（pid 消失、写事务未提交即消失）。
// 所以这里用 SIGKILL 自杀：不给 finally、不给 ROLLBACK、不给 ack 任何机会。
//
// 用法（由 tests/21-outbox-crash.test.mjs / 22-outbox-recovery.test.mjs 驱动）：
//   node tests/support/outbox-child.mjs --mode crash --db <path> --crash-at <point> --lease-ms 60000
//   node tests/support/outbox-child.mjs --mode claim-only --db <path> --lease-ms 60000 --out <json>
//   node tests/support/outbox-child.mjs --mode claim-race --db <path> --start-at <epochMs> --out <json>
//
// crash points（与父进程的断言一一对应）：
//   claim-before                    claim 之前崩
//   claim-after                     claim 之后崩（未 sendStarted）
//   send-started-before             heartbeat 之后、markSendStarted 之前崩
//   send-started-after              markSendStarted 之后、provider.send 之前崩
//   after-provider-send-before-ack  provider 已接受、写 marker、ack 之前崩
//   before-ack                      落过 part 回执、ack 之前崩

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../../src/candidate/db.mjs';
import { createOutbox } from '../../src/candidate/delivery-outbox.mjs';
import { createMockProvider } from '../../src/candidate/delivery-provider.mjs';

const { values: argv } = parseArgs({
  options: {
    mode: { type: 'string', default: 'crash' },
    db: { type: 'string' },
    'crash-at': { type: 'string' },
    'lease-ms': { type: 'string', default: '60000' },
    'marker-dir': { type: 'string' },
    'start-at': { type: 'string' },
    'hold-until': { type: 'string' },
    'release-file': { type: 'string' },
    'hold-ms': { type: 'string', default: '1500' },
    out: { type: 'string' },
  },
  strict: false,
});

function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** 硬崩溃：写到 stdout 标记进度，然后 SIGKILL 自己。崩溃点之后的代码保证不会执行。 */
function hardCrash(label) {
  process.stdout.write(`CHILD-CRASH ${label}\n`);
  process.kill(process.pid, 'SIGKILL');
  // Windows 上进程终止可能有极短延迟；用同步忙等兜底，确保不会「崩了又继续跑」。
  sleepSync(10000);
  process.exit(137);
}

function openOutbox(dbPath, workerNonce) {
  const db = openDb(dbPath, { migrate: true });
  const outbox = createOutbox({
    db,
    leaseMs: Number(argv['lease-ms']),
    workerNonce,
  });
  return { db, outbox };
}

function writeReport(payload) {
  if (!argv.out) return;
  fs.writeFileSync(argv.out, JSON.stringify(payload, null, 2), 'utf8');
}

// ── 模式 1：claim-only（领取后用正常退出「死掉」，制造 lease 未过期的死 owner）────────
if (argv.mode === 'claim-only') {
  const { db, outbox } = openOutbox(argv.db, `child-${process.pid}`);
  const claimed = outbox.claim({ limit: 1 });
  writeReport({ pid: process.pid, nonce: `child-${process.pid}`, claimed });
  db.close();
  process.stdout.write(`CHILD-CLAIMED ${claimed.length}\n`);
  process.exit(0);
}

// ── 模式 1b：claim-hold（领住不放，进程仍然活着）────────────────────────────────
// 用来证明「活着的 owner + 未过期 lease」不可被任何人接管：这段时间里父进程无论怎么
// expireLeases / recoverOrphans / claim，都不该把这条投递抢走（抢走就有双发风险）。
if (argv.mode === 'claim-hold') {
  const { db, outbox } = openOutbox(argv.db, `child-${process.pid}`);
  const claimed = outbox.claim({ limit: 1 });
  writeReport({ pid: process.pid, nonce: `child-${process.pid}`, claimed, holding: true });
  process.stdout.write(`CHILD-HOLDING ${claimed.length}\n`);
  sleepSync(Number(argv['hold-ms'] ?? 1500));
  db.close();
  process.stdout.write('CHILD-RELEASED\n');
  process.exit(0);
}

// ── 模式 2：claim-race（多进程同时抢，验证同一条不会派给两个人）─────────────────────
// 每个进程在同一个起跑线之后**只 claim 一次**，然后保持存活到所有竞争者都抢完。
// 为什么必须保持存活：Outbox 的接管规则是「owner 进程已死或 lease 过期才可接管」，
// 如果子进程 claim 完就退出，后到的进程会依据「进程已死」合法接管同一条——那是正确的
// 恢复语义，不是重复派发。要测「并发 claim 的互斥性」，owner 必须在观察窗口内活着。
if (argv.mode === 'claim-race') {
  const startAt = Number(argv['start-at'] ?? 0);
  const releaseFile = argv['release-file'] ?? null;
  const safetyUntil = Number(argv['hold-until'] ?? startAt + 10000);
  // 等一个共同的起跑线：否则「先起的那一个」会把活全干完，测不到竞争。
  while (Date.now() < startAt) sleepSync(2);
  const { db, outbox } = openOutbox(argv.db, `racer-${process.pid}`);
  const claimed = outbox.claim({ limit: 1 }).map((job) => ({
    deliveryId: job.deliveryId, attemptId: job.attemptId, n: job.n, pid: process.pid,
  }));
  writeReport({ pid: process.pid, nonce: `racer-${process.pid}`, claimed });
  process.stdout.write(`CHILD-RACE ${claimed.length}\n`);
  // 由父进程在「三份报告都到齐」后放行：保证三个 owner 同时活着，
  // 观察窗口里不存在「进程已死 → 合法接管」这条恢复路径的干扰。
  while (Date.now() < safetyUntil) {
    if (releaseFile && fs.existsSync(releaseFile)) break;
    sleepSync(5);
  }
  db.close();
  process.exit(0);
}

// ── 模式 3：crash（按 crash point 执行后强杀）───────────────────────────────────────
if (argv.mode !== 'crash') {
  process.stderr.write(`未知 mode: ${argv.mode}\n`);
  process.exit(2);
}

const point = argv['crash-at'];
const knownPoints = new Set([
  'claim-before',
  'claim-after',
  'send-started-before',
  'send-started-after',
  'after-provider-send-before-ack',
  'before-ack',
]);
if (!knownPoints.has(point)) {
  process.stderr.write(`未知 crash point: ${point}\n`);
  process.exit(2);
}

const { db, outbox } = openOutbox(argv.db, `child-${process.pid}`);
// 父进程已先入队一条投递；这里模拟「真实 worker」按正确时序处理它，然后在指定点暴毙。
const provider = createMockProvider({ name: 'child-mock', reconcileSupport: 'none', behavior: 'ok' });

if (point === 'claim-before') hardCrash(point);

const jobs = outbox.claim({ limit: 1 });
if (jobs.length === 0) {
  process.stderr.write('子进程没有领到任何投递（父进程应先 enqueue）\n');
  process.exit(9);
}
const job = jobs[0];
process.stdout.write(`CHILD-JOB ${JSON.stringify({ deliveryId: job.deliveryId, attemptId: job.attemptId, n: job.n })}\n`);

if (point === 'claim-after') hardCrash(point);

if (point === 'send-started-before') {
  // 续租一次，证明「活着的时候确实在正常干活」，然后死掉
  outbox.heartbeat({ attemptId: job.attemptId });
  hardCrash(point);
}

outbox.markSendStarted({ attemptId: job.attemptId });
if (point === 'send-started-after') hardCrash(point);

// provider 接受 = 外部世界已经产生了副作用。marker 文件就是「上游账本」的替身：
// 父进程看不到子进程的内存，但能看到这个文件，从而知道消息确实已经被接受过。
const sent = await provider.send({ delivery: job, attempt: { attemptId: job.attemptId } });
if (!sent.ok) {
  process.stderr.write('provider 未接受\n');
  process.exit(10);
}
const markerDir = argv['marker-dir'];
if (markerDir) {
  const marker = path.join(markerDir, `accepted-${job.deliveryId}-${job.attemptId}.json`);
  fs.writeFileSync(marker, JSON.stringify({ deliveryId: job.deliveryId, attemptId: job.attemptId, receipt: sent.receipt }), 'utf8');
}
if (point === 'after-provider-send-before-ack') hardCrash(point);

outbox.recordPartReceipt({ attemptId: job.attemptId, partNo: 1, ok: true, receipt: sent.receipt });
if (point === 'before-ack') hardCrash(point);

outbox.ack({ attemptId: job.attemptId, receipt: sent.receipt });
db.close();
process.stdout.write(`CHILD-DONE ${job.deliveryId}\n`);
process.exit(0);
