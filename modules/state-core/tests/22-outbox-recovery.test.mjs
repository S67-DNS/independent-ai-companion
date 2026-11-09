// 阶段 C-3：恢复语义 / 多进程竞争 / 对账（真子进程）。
//
// 这个文件回答三个问题：
//   1. 旧 worker 死了，谁能接管、什么时候才能接管？（lease 未过期 vs 进程已死）
//   2. 多个进程同时抢同一条投递，会不会派给两个人？（真并发写 BEGIN IMMEDIATE）
//   3. 对账能把 unknown 收口到什么程度？不可对账时必须付出什么代价？
//
// 跑法：node --test tests/22-outbox-recovery.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/candidate/db.mjs';
import { createOutbox, DELIVERY_STATE, RECONCILE_SUPPORT } from '../src/candidate/delivery-outbox.mjs';
import { createMockProvider, createRecordingProvider } from '../src/candidate/delivery-provider.mjs';
import { ERR } from '../src/candidate/errors.mjs';
import { REPO_ROOT, ensureDir, randomHex } from '../src/candidate/util.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'support', 'outbox-child.mjs');
const LEASE_MS = 60000;

// ── 基础设施 ─────────────────────────────────────────────────────────────────

function makeScene(prefix) {
  const dir = ensureDir(path.join(REPO_ROOT, 'data', `test-outbox-22-${prefix}-${process.pid}-${randomHex(4)}`));
  return { dir, dbPath: path.join(dir, 'outbox.sqlite3') };
}

/** 父进程先落几条投递，然后关掉连接（把 db 文件交给子进程/后续连接）。 */
function seedDeliveries(dbPath, items) {
  const db = openDb(dbPath, { migrate: true });
  try {
    const outbox = createOutbox({ db, leaseMs: LEASE_MS, workerNonce: 'parent-seed' });
    return items.map((item) => outbox.enqueue(item));
  } finally {
    db.close();
  }
}

/** 起子进程并等它退出（spawn 而不是 fork：要真 PID 的独立 OS 进程）。 */
function runChild(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      reject(new Error(`子进程超时未退出（${timeoutMs}ms）：${stdout} ${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, pid: child.pid }); });
  });
}

/** 起一个不等待退出的子进程（用于「它活着的时候别人不能接管」这类观察）。 */
function spawnChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { state.stdout += chunk; });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout: state.stdout, stderr: state.stderr, pid: child.pid }));
  });
  return { child, exited, state };
}

async function waitForFile(file, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function makeClock(start = 1_800_000_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; return current; }, peek: () => current };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── 1. 旧 Worker 恢复（lease 未过期但进程已死）────────────────────────────────

test('旧 Worker 恢复：lease 未过期但进程已死 ⇒ 只有进程死亡能当接管证据，且全程只发一次', async (t) => {
  const { dir, dbPath } = makeScene('stale-worker');
  const [enqueued] = seedDeliveries(dbPath, [{
    channel: 'qq-group', target: 'group:2201', payload: { text: '旧 worker 领了但死了' },
  }]);

  // 子进程领取后正常退出（不是崩溃）：lease 记录还活着，进程已经没了
  const claimFile = path.join(dir, 'claim.json');
  const childResult = await runChild(['--mode', 'claim-only', '--db', dbPath, '--lease-ms', String(LEASE_MS), '--out', claimFile]);
  assert.equal(childResult.code, 0, `claim-only 子进程应正常退出：${childResult.stderr}`);
  const claimInfo = readJson(claimFile);
  assert.equal(claimInfo.claimed.length, 1);
  assert.equal(claimInfo.claimed[0].deliveryId, enqueued.deliveryId);

  const db = openDb(dbPath, { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, leaseMs: LEASE_MS, workerNonce: 'parent-recovery' });

  // lease 是「时间」维度的判据：时间没到，expireLeases 不该动它
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.CLAIMED);
  assert.deepEqual(await outbox.expireLeases(), [], 'lease 未过期时 expireLeases 不得接管（哪怕进程已死）');
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.CLAIMED);

  // 「进程已死」是另一条独立证据：recoverOrphans 用它接管
  const recovered = await outbox.recoverOrphans();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].decision, DELIVERY_STATE.PENDING);
  assert.equal(recovered[0].reason, 'owner-process-dead');

  const afterRecovery = outbox.get(enqueued.deliveryId);
  assert.equal(afterRecovery.state, DELIVERY_STATE.PENDING);
  assert.equal(afterRecovery.attempts[0].sendStartedAtMs, null, '旧 attempt 从未开始发送');
  assert.equal(afterRecovery.attemptCount, 1);

  // 接管后重发：deliveryId 不变，新 attempt；用 recording provider 数调用次数
  const provider = createRecordingProvider({ name: 'mock', behavior: 'ok' });
  const [retryJob] = outbox.claim({ limit: 1 });
  assert.equal(retryJob.deliveryId, enqueued.deliveryId);
  assert.equal(retryJob.n, 2);
  outbox.markSendStarted({ attemptId: retryJob.attemptId });
  const sent = await provider.send({ delivery: retryJob, attempt: { attemptId: retryJob.attemptId } });
  assert.equal(sent.ok, true);
  outbox.ack({ attemptId: retryJob.attemptId, receipt: sent.receipt });

  // 关键断言：不会双发——只有一次真正的发送，旧 attempt 没有 send_started
  assert.equal(provider.sendCount, 1, '整个生命周期只允许一次真正的发送');
  const finalSnapshot = outbox.get(enqueued.deliveryId);
  assert.equal(finalSnapshot.state, DELIVERY_STATE.SENT);
  assert.equal(finalSnapshot.attempts.length, 2);
  assert.equal(finalSnapshot.attempts.filter((attempt) => attempt.sendStartedAtMs !== null).length, 1);
  assert.equal(finalSnapshot.attempts.filter((attempt) => attempt.phase === 'ack_received').length, 1);
});

// ── 2. 活着的 owner 不能被抢（防双发的最直接证据）─────────────────────────────

test('活着的 owner + 未过期 lease：expireLeases / recoverOrphans / claim 全部不得接管', async (t) => {
  const { dir, dbPath } = makeScene('live-owner');
  const [enqueued] = seedDeliveries(dbPath, [{
    channel: 'qq-group', target: 'group:2202', payload: { text: '活着的 worker 正在处理' },
  }]);

  const claimFile = path.join(dir, 'hold.json');
  const runner = spawnChild(['--mode', 'claim-hold', '--db', dbPath, '--lease-ms', String(LEASE_MS), '--hold-ms', '1600', '--out', claimFile]);
  t.after(() => { try { runner.child.kill('SIGKILL'); } catch { /* 已退出 */ } });

  assert.equal(await waitForFile(claimFile), true, '子进程必须先把 claim 落盘再进入持有期');
  const holding = readJson(claimFile);
  assert.equal(holding.claimed.length, 1);
  assert.equal(holding.claimed[0].deliveryId, enqueued.deliveryId);

  const db = openDb(dbPath, { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, leaseMs: LEASE_MS, workerNonce: 'parent-intruder' });

  // owner 还活着、lease 还没到期：所有自动路径都必须空手而归
  assert.deepEqual(await outbox.expireLeases(), [], 'lease 未过期，没有接管依据');
  assert.deepEqual(await outbox.recoverOrphans(), [], '进程活着，没有接管依据');
  assert.deepEqual(outbox.claim({ limit: 10 }), [], '活人手里的投递不得被重发');
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.CLAIMED);
  assert.equal(outbox.get(enqueued.deliveryId).attemptCount, 1);

  // 子进程释放（正常退出）之后，才轮得到接管
  const exited = await runner.exited;
  assert.equal(exited.code, 0, `claim-hold 子进程应正常退出：${exited.stderr}`);
  const recovered = await outbox.recoverOrphans();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].decision, DELIVERY_STATE.PENDING);
});

// ── 3. lease 过期（时间维度）接管 ────────────────────────────────────────────

test('lease 过期：expireLeases 把未 send_started 的 claim 收回 pending 并换 attempt', async (t) => {
  const { dir, dbPath } = makeScene('lease-expired');
  const [enqueued] = seedDeliveries(dbPath, [{
    channel: 'qq-group', target: 'group:2203', payload: { text: '过期 lease' },
  }]);

  const claimFile = path.join(dir, 'claim.json');
  await runChild(['--mode', 'claim-only', '--db', dbPath, '--lease-ms', String(LEASE_MS), '--out', claimFile]);

  // 假时钟放到 lease 之后：只靠时间就该接管
  const clock = makeClock(Date.now() + LEASE_MS + 60000);
  const db = openDb(dbPath, { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, now: clock.now, leaseMs: LEASE_MS, workerNonce: 'parent-clock' });

  const settled = await outbox.expireLeases();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].started, false);
  assert.equal(settled[0].decision, DELIVERY_STATE.PENDING);

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.PENDING);
  const [job] = outbox.claim({ limit: 1 });
  assert.equal(job.deliveryId, enqueued.deliveryId);
  assert.equal(job.n, 2);
});

// ── 4. 多进程竞争 ───────────────────────────────────────────────────────────

test('多进程竞争：3 个子进程同时 claim，同一条投递绝不会被两个进程领到', async (t) => {
  const { dir, dbPath } = makeScene('race');
  const targets = ['group:2301', 'group:2302', 'group:2303', 'group:2304'];
  const seeded = seedDeliveries(dbPath, targets.map((target, index) => ({
    channel: 'qq-group',
    target,
    payload: { text: `race #${index + 1}` },
    idempotencyKey: `race-${index + 1}`,
  })));
  assert.equal(seeded.length, 4);

  const startAt = Date.now() + 600;
  const releaseFile = path.join(dir, 'release.race');
  const outFiles = [0, 1, 2].map((index) => path.join(dir, `race-${index}.json`));
  // 每个子进程在同一个起跑线之后只 claim 一次，然后等父进程统一放行才退出：
  // 这样三个 owner 一定是同时活着的，观察窗口里不会混进「owner 已死 → 合法接管」
  // 这条恢复路径（那会把「并发互斥」的验证掩盖掉）。
  const runners = outFiles.map((outFile) => spawnChild([
    '--mode', 'claim-race',
    '--db', dbPath,
    '--start-at', String(startAt),
    '--hold-until', String(startAt + 15000),
    '--release-file', releaseFile,
    '--lease-ms', String(LEASE_MS),
    '--out', outFile,
  ]));
  t.after(() => { for (const runner of runners) { try { runner.child.kill('SIGKILL'); } catch { /* 已退出 */ } } });

  for (const outFile of outFiles) {
    assert.equal(await waitForFile(outFile, 15000), true, `竞争进程必须先把 claim 报告落盘：${outFile}`);
  }
  fs.writeFileSync(releaseFile, 'go', 'utf8');
  const childResults = await Promise.all(runners.map((runner) => runner.exited));

  for (const result of childResults) {
    assert.equal(result.code, 0, `竞态子进程应正常退出：${result.stderr}`);
    assert.match(result.stdout, /CHILD-RACE/);
  }

  const claims = childResults.flatMap((result, index) => readJson(outFiles[index]).claimed);
  const deliveryIds = claims.map((claim) => claim.deliveryId);
  const uniqueDeliveryIds = new Set(deliveryIds);
  const racerPids = new Set(claims.map((claim) => claim.pid));

  // 把实际竞争分布打出来：证明「3 个进程真的同时在抢」，而不是一个进程干完收工
  t.diagnostic(`3 个竞争进程的领取分布：${JSON.stringify(claims.map((claim) => ({ pid: claim.pid, deliveryId: claim.deliveryId })))}`);

  // 核心断言 1：3 个进程各自只领到 1 条，总数不多不少
  assert.equal(claims.length, 3, `3 个单发进程应该领到 3 条，实际：${JSON.stringify(deliveryIds)}`);
  assert.equal(racerPids.size, 3, '三个进程都必须真的参与竞争（各自领到一条）');
  // 核心断言 2：没有任何 delivery 被领取两次
  assert.equal(uniqueDeliveryIds.size, 3, `出现重复领取：${JSON.stringify(deliveryIds)}`);
  // 核心断言 3：每一次领取都产生且只产生 1 个 attempt
  assert.equal(new Set(claims.map((claim) => claim.attemptId)).size, 3, '每个 claim 必须是不同的 attempt');
  assert.ok(claims.every((claim) => claim.n === 1), '第一次领取的 n 必须是 1');

  // 用 DB 里的 delivery_attempt 计数交叉验证（不只看子进程自报）
  const db = openDb(dbPath, { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, leaseMs: LEASE_MS, workerNonce: 'parent-verify' });
  const attemptTotal = Number(db.prepare('SELECT COUNT(*) AS c FROM delivery_attempt').get().c);
  assert.equal(attemptTotal, 3, 'delivery_attempt 总行数必须等于成功领取次数');
  const claimedIds = new Set(deliveryIds);

  for (const item of seeded) {
    const snapshot = outbox.get(item.deliveryId);
    assert.equal(snapshot.attemptCount, claimedIds.has(item.deliveryId) ? 1 : 0);
    assert.equal(snapshot.attempts.length, claimedIds.has(item.deliveryId) ? 1 : 0);
    if (claimedIds.has(item.deliveryId)) {
      assert.equal(snapshot.state, DELIVERY_STATE.CLAIMED);
      assert.equal(snapshot.attempts[0].n, 1);
      assert.ok(targets.includes(snapshot.target));
    } else {
      // 没被领到的那条必须还是干净的 pending（不能出现「领了一半」的脏状态）
      assert.equal(snapshot.state, DELIVERY_STATE.PENDING);
      assert.equal(snapshot.currentAttemptId, null);
    }
  }
});

// ── 5. 对账：sent / not-sent / unknown 三种结局 ──────────────────────────────

test('对账：provider 答 sent ⇒ sent；答 not-sent ⇒ 回 pending 可重试；答 unknown/抛错 ⇒ 保持 unknown', async (t) => {
  const clock = makeClock();
  const { dir } = makeScene('reconcile');
  const dbPath = path.join(dir, 'outbox.sqlite3');
  const db = openDb(dbPath, { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, now: clock.now, leaseMs: LEASE_MS, workerNonce: 'parent-reconcile' });

  /** 造一条「已开始发送但结果不可知」的可对账投递。 */
  function makeUnknown(target) {
    const enqueued = outbox.enqueue({
      channel: 'qq-group', target, payload: { text: `reconcile ${target}` },
      reconcileSupport: RECONCILE_SUPPORT.QUERY, idempotencyKey: `recon-${target}`,
    });
    const [job] = outbox.claim({ limit: 1 });
    assert.equal(job.deliveryId, enqueued.deliveryId);
    outbox.markSendStarted({ attemptId: job.attemptId });
    outbox.markUnknownAfterSend({ attemptId: job.attemptId, reason: 'crash-after-send' });
    assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
    return { enqueued, job };
  }

  // ── sent ──
  const sentCase = makeUnknown('group:2401');
  const sentProvider = createMockProvider({ name: 'mock', reconcileSupport: 'query', reconcileAnswer: 'sent' });
  const sentResult = await outbox.reconcile({ attemptId: sentCase.job.attemptId, provider: sentProvider });
  assert.equal(sentResult.reconciled, 'sent');
  assert.equal(sentResult.state, DELIVERY_STATE.SENT);
  const sentSnapshot = outbox.get(sentCase.enqueued.deliveryId);
  assert.equal(sentSnapshot.state, DELIVERY_STATE.SENT);
  assert.equal(typeof sentSnapshot.sentAtMs, 'number');
  assert.equal(sentSnapshot.resolution, 'reconciled-sent');
  assert.equal(sentSnapshot.attempts[0].phase, 'ack_received');
  assert.equal(sentSnapshot.attempts[0].outcome, 'reconciled-sent');
  assert.equal(sentProvider.reconcileCalls.length, 1);

  // ── not-sent ──
  const notSentCase = makeUnknown('group:2402');
  const notSentProvider = createMockProvider({ name: 'mock', reconcileSupport: 'query', reconcileAnswer: 'not-sent' });
  const notSentResult = await outbox.reconcile({ attemptId: notSentCase.job.attemptId, provider: notSentProvider });
  assert.equal(notSentResult.reconciled, 'not-sent');
  assert.equal(notSentResult.state, DELIVERY_STATE.PENDING);
  const notSentSnapshot = outbox.get(notSentCase.enqueued.deliveryId);
  assert.equal(notSentSnapshot.state, DELIVERY_STATE.PENDING, '确定没发出去 ⇒ 可以安全重试');
  assert.equal(notSentSnapshot.attempts[0].outcome, 'reconciled-not-sent');
  assert.equal(notSentSnapshot.ownerNonce, null);

  // 重试：deliveryId 不变、attempt 换新
  const retried = outbox.claim({ limit: 10 });
  const retriedJob = retried.find((job) => job.deliveryId === notSentCase.enqueued.deliveryId);
  assert.ok(retriedJob, 'not-sent 的投递必须可以被重新领取');
  assert.equal(retriedJob.n, 2);
  // 把这条重试真的发成功，清空 pending 队列，避免污染后面的用例
  outbox.markSendStarted({ attemptId: retriedJob.attemptId });
  assert.equal(outbox.ack({ attemptId: retriedJob.attemptId }).state, DELIVERY_STATE.SENT);

  // ── unknown ──
  const unknownCase = makeUnknown('group:2403');
  const unknownProvider = createMockProvider({ name: 'mock', reconcileSupport: 'query', reconcileAnswer: 'unknown' });
  const unknownResult = await outbox.reconcile({ attemptId: unknownCase.job.attemptId, provider: unknownProvider });
  assert.equal(unknownResult.reconciled, 'unknown');
  assert.equal(unknownResult.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  assert.equal(outbox.get(unknownCase.enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  // ── 对账本身抛错 ⇒ fail-closed 仍然是 unknown ──
  const throwingCase = makeUnknown('group:2404');
  const throwingProvider = createMockProvider({
    name: 'mock',
    reconcileSupport: 'query',
    reconcileAnswer: () => { throw new Error('reconcile endpoint down'); },
  });
  const throwingResult = await outbox.reconcile({ attemptId: throwingCase.job.attemptId, provider: throwingProvider });
  assert.equal(throwingResult.reconciled, 'unknown', '对账失败不得被当成 sent 或 not-sent');
  assert.equal(outbox.get(throwingCase.enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  // 已经 sent 的投递不再接受对账
  await assert.rejects(
    () => outbox.reconcile({ attemptId: sentCase.job.attemptId, provider: sentProvider }),
    (error) => error.code === ERR.CONFLICT,
  );
});

// ── 6. 恢复期对账（recoverOrphans/expireLeases 直接带 provider）────────────────

test('恢复期对账：expireLeases({provider}) 按 provider 答案把 sending 收口成 sent / pending', async (t) => {
  const clock = makeClock();
  const { dir } = makeScene('settle-reconcile');
  const db = openDb(path.join(dir, 'outbox.sqlite3'), { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, now: clock.now, leaseMs: 1000, workerNonce: 'parent-settle' });

  const mk = (target) => {
    const enqueued = outbox.enqueue({
      channel: 'qq-group', target, payload: { text: target },
      reconcileSupport: RECONCILE_SUPPORT.QUERY, idempotencyKey: `settle-${target}`,
    });
    const [job] = outbox.claim({ limit: 1, leaseMs: 1000 });
    assert.equal(job.deliveryId, enqueued.deliveryId);
    outbox.markSendStarted({ attemptId: job.attemptId });
    return enqueued;
  };

  const sentDelivery = mk('group:2601');
  const notSentDelivery = mk('group:2602');

  // 断开 provider 前先确认：没有 provider 时恢复流程只能产出 unknown
  clock.advance(5000);
  const withoutProvider = await outbox.expireLeases();
  assert.equal(withoutProvider.length, 2);
  assert.ok(withoutProvider.every((item) => item.decision === DELIVERY_STATE.UNKNOWN_AFTER_SEND));
  assert.equal(outbox.get(sentDelivery.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  // 用同一批 unknown 记录模拟「人工/启动时触发的对账恢复」：对账在事务外调用，再落库
  const provider = createMockProvider({
    name: 'settle-mock',
    reconcileSupport: 'query',
    reconcileAnswer: ({ delivery }) => (delivery.target === 'group:2601' ? 'sent' : 'not-sent'),
  });
  const reconciledSent = await outbox.reconcile({ deliveryId: sentDelivery.deliveryId, provider });
  assert.equal(reconciledSent.reconciled, 'sent');
  assert.equal(reconciledSent.state, DELIVERY_STATE.SENT);

  const reconciledNotSent = await outbox.reconcile({ deliveryId: notSentDelivery.deliveryId, provider });
  assert.equal(reconciledNotSent.reconciled, 'not-sent');
  assert.equal(reconciledNotSent.state, DELIVERY_STATE.PENDING);

  assert.equal(outbox.get(sentDelivery.deliveryId).sentAtMs !== null, true);
  assert.equal(outbox.get(notSentDelivery.deliveryId).state, DELIVERY_STATE.PENDING);
  assert.equal(provider.reconcileCalls.length, 2);

  // 把 not-sent 那条的 retry 发完，清空 pending 队列，避免干扰下一条
  const retried = outbox.claim({ limit: 1 });
  assert.equal(retried[0].deliveryId, notSentDelivery.deliveryId);
  assert.equal(retried[0].n, 2);
  outbox.markSendStarted({ attemptId: retried[0].attemptId });
  assert.equal(outbox.ack({ attemptId: retried[0].attemptId }).state, DELIVERY_STATE.SENT);

  // 另一条路径：租约过期的 sending 记录，直接让 expireLeases 带 provider 对账
  const inline = mk('group:2603');
  clock.advance(5000);
  const inlineProvider = createMockProvider({ name: 'inline-mock', reconcileSupport: 'query', reconcileAnswer: 'sent' });
  const inlineSettled = await outbox.expireLeases({ provider: inlineProvider });
  const inlineResult = inlineSettled.find((item) => item.deliveryId === inline.deliveryId);
  assert.ok(inlineResult, '过期的 sending 记录必须被扫到');
  assert.equal(inlineResult.reconciled, 'sent');
  assert.equal(inlineResult.decision, DELIVERY_STATE.SENT);
  assert.equal(outbox.get(inline.deliveryId).state, DELIVERY_STATE.SENT);
  assert.equal(inlineProvider.reconcileCalls.length, 1, '对账只在事务外调用一次');
});

// ── 7. 不可对账且非幂等 ⇒ 永久 unknown ───────────────────────────────────────

test('不可对账且非幂等：unknown 就是终点，expireLeases 永不改回 pending', async (t) => {
  const clock = makeClock();
  const { dir } = makeScene('no-reconcile');
  const db = openDb(path.join(dir, 'outbox.sqlite3'), { migrate: true });
  t.after(() => { try { db.close(); } catch { /* ignore */ } });
  const outbox = createOutbox({ db, now: clock.now, leaseMs: 1000, workerNonce: 'parent-final' });

  const enqueued = outbox.enqueue({
    channel: 'qq-group',
    target: 'group:2501',
    payload: { text: '不可对账且非幂等' },
    reconcileSupport: RECONCILE_SUPPORT.NONE,
    idempotent: false,
  });
  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.reconcileSupport, RECONCILE_SUPPORT.NONE);
  assert.equal(snapshot.idempotent, false);

  const [job] = outbox.claim({ limit: 1, leaseMs: 1000 });
  outbox.markSendStarted({ attemptId: job.attemptId });

  // lease 过期 + 已 send_started + 不可对账 ⇒ 只能 unknown
  clock.advance(5000);
  const firstSweep = await outbox.expireLeases();
  assert.equal(firstSweep.length, 1);
  assert.equal(firstSweep[0].started, true);
  assert.equal(firstSweep[0].decision, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  const afterFirst = outbox.get(enqueued.deliveryId);
  assert.equal(afterFirst.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  assert.equal(afterFirst.resolution, 'unreconcilable');
  assert.equal(afterFirst.sentAtMs, null);
  assert.equal(afterFirst.attempts[0].phase, 'unknown');

  // 关键断言：再扫多少遍都不许把它改回 pending（改回去就等于自动重发）
  for (const advanceMs of [60_000, 3_600_000, 86_400_000]) {
    clock.advance(advanceMs);
    assert.deepEqual(await outbox.expireLeases(), []);
    assert.deepEqual(await outbox.recoverOrphans(), []);
    assert.deepEqual(outbox.claim({ limit: 10 }), []);
    assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  }

  // 也不接受对账
  const queryProvider = createMockProvider({ name: 'mock', reconcileSupport: 'query', reconcileAnswer: 'not-sent' });
  await assert.rejects(
    () => outbox.reconcile({ attemptId: job.attemptId, provider: queryProvider }),
    (error) => error.code === ERR.DELIVERY_NOT_RECONCILABLE,
    '声明 none 的通道即使 provider 会答也不能去问',
  );
  assert.equal(queryProvider.reconcileCalls.length, 0, '被拒绝的对账不得真的调用 provider');
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
});
