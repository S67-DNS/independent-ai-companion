// 阶段 C-1：Outbox 基本语义（单进程、真 SQLite 文件）。
//
// 这个文件只测「状态机本身」：入队/领取/发送分界线/回执/ack/fail/续租/幂等/对账能力。
// 崩溃与多进程的部分在 21 / 22 里用真子进程测——这里不模拟进程死亡。
//
// 跑法：node --test tests/20-outbox.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openDb } from '../src/candidate/db.mjs';
import { createOutbox, DELIVERY_STATE, RECONCILE_SUPPORT } from '../src/candidate/delivery-outbox.mjs';
import { createMockProvider } from '../src/candidate/delivery-provider.mjs';
import { ERR } from '../src/candidate/errors.mjs';
import { REPO_ROOT, ensureDir, randomHex } from '../src/candidate/util.mjs';

// ── 每个测试用例独立临时目录 + 独立 db 文件（不碰真实数据库）─────────────────────
let caseSeq = 0;
function makeEnv(t, overrides = {}) {
  caseSeq += 1;
  const dir = ensureDir(path.join(REPO_ROOT, 'data', `test-outbox-20-${process.pid}-${caseSeq}-${randomHex(4)}`));
  const dbPath = path.join(dir, 'outbox.sqlite3');
  const db = openDb(dbPath, { migrate: true });
  const outbox = createOutbox({ db, now: Date.now, leaseMs: 60000, workerNonce: `test-20-${caseSeq}`, ...overrides });
  t.after(() => { try { db.close(); } catch { /* 已关闭 */ } });
  return { dir, dbPath, db, outbox };
}

/** 可控假时钟：lease 过期必须能瞬间发生，不能靠真实 sleep 把测试拖慢。 */
function makeClock(start = 1_800_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => { current += ms; return current; },
    peek: () => current,
  };
}

const basePayload = { kind: 'text', text: '在吗' };

// ── 1. 正常链路 ───────────────────────────────────────────────────────────────

test('正常链路：enqueue → claim → markSendStarted → ack，deliveryId 稳定、attemptId 独立', async (t) => {
  const { outbox, dbPath } = makeEnv(t);

  const enqueued = outbox.enqueue({ channel: 'qq-group', target: 'group:1001', payload: basePayload });
  assert.equal(enqueued.deduped, false);
  assert.match(enqueued.deliveryId, /^dlv_/, 'deliveryId 必须是 dlv_ 前缀的稳定 id');
  assert.equal(enqueued.state, DELIVERY_STATE.PENDING);

  const claimed = outbox.claim({ limit: 1 });
  assert.equal(claimed.length, 1);
  const job = claimed[0];
  assert.equal(job.deliveryId, enqueued.deliveryId, 'claim 不换 deliveryId');
  assert.match(job.attemptId, /^att_/, 'attemptId 必须是 att_ 前缀的独立 id');
  assert.equal(job.n, 1);
  assert.deepEqual(job.payload, basePayload, 'payload 要能原样取回');
  assert.equal(outbox.get(job.deliveryId).state, DELIVERY_STATE.CLAIMED);

  // 关键不变量：markSendStarted 之前，DB 里不能有任何「已经发出去」的痕迹
  const before = outbox.get(job.deliveryId);
  assert.equal(before.attempts[0].sendStartedAtMs, null);

  const started = outbox.markSendStarted({ attemptId: job.attemptId });
  assert.equal(started.state, DELIVERY_STATE.SENDING);
  assert.equal(typeof started.sendStartedAtMs, 'number');

  // 分界线必须已经落盘：用**另一条连接**重新打开同一个文件读取，证明它不是内存状态
  const secondConnection = openDb(dbPath, { migrate: false });
  try {
    const persisted = secondConnection.prepare('SELECT state, current_attempt_id FROM delivery WHERE delivery_id = ?').get(job.deliveryId);
    const persistedAttempt = secondConnection.prepare('SELECT send_started_at_ms FROM delivery_attempt WHERE attempt_id = ?').get(job.attemptId);
    assert.equal(persisted.state, DELIVERY_STATE.SENDING);
    assert.equal(persisted.current_attempt_id, job.attemptId);
    assert.equal(Number(persistedAttempt.send_started_at_ms), started.sendStartedAtMs, 'send_started 必须是真落盘的时间戳');
  } finally {
    secondConnection.close();
  }

  const reopened = outbox.get(job.deliveryId);
  assert.equal(reopened.state, DELIVERY_STATE.SENDING);
  assert.equal(reopened.attempts[0].sendStartedAtMs, started.sendStartedAtMs);

  // 分界线落库之后才允许调用 provider（顺序本身就是语义）
  const provider = createMockProvider({ name: 'mock', reconcileSupport: 'none', behavior: 'ok' });
  const sent = await provider.send({ delivery: job, attempt: { attemptId: job.attemptId } });
  assert.equal(sent.ok, true);

  const ack = outbox.ack({ attemptId: job.attemptId, receipt: sent.receipt });
  assert.equal(ack.state, DELIVERY_STATE.SENT);
  assert.equal(ack.partsTotal, 1);
  // 单分片、没落 part 回执时 ack 直接代表整条成功，所以 okCount 是 0（没有分片回执可数）而不是 1
  assert.equal(ack.okCount, 0);

  const final = outbox.get(job.deliveryId);
  assert.equal(final.state, DELIVERY_STATE.SENT);
  assert.equal(typeof final.sentAtMs, 'number');
  assert.equal(final.attempts.length, 1);
  assert.equal(final.attempts[0].phase, 'ack_received');
  assert.equal(final.ownerNonce, null, '完成后必须清空 owner，不再持有 lease');
  assert.equal(final.leaseExpiresAtMs, null);

  // 已完成的投递不会再被领取
  assert.deepEqual(outbox.claim({ limit: 10 }), []);
});

// ── 2. 幂等键 ─────────────────────────────────────────────────────────────────

test('幂等键：(channel,target,key) 重复入队去重；不同 key / 无 key 会产生新行', async (t) => {
  const { outbox } = makeEnv(t);

  const first = outbox.enqueue({
    channel: 'qq-group', target: 'group:1001', payload: basePayload, idempotencyKey: 'dedupe-1',
  });
  assert.equal(first.deduped, false);

  const second = outbox.enqueue({
    channel: 'qq-group', target: 'group:1001', payload: { kind: 'text', text: '我改主意了' }, idempotencyKey: 'dedupe-1',
  });
  assert.equal(second.deduped, true, '同幂等键必须被判为重复');
  assert.equal(second.deliveryId, first.deliveryId, '重复入队必须返回同一个 deliveryId');
  assert.equal(outbox.list({ limit: 100 }).length, 1, '重复入队不得新增行');
  // 去重不覆盖原内容：先入队的 payload 才是权威的那一份
  assert.deepEqual(outbox.get(first.deliveryId).payload, basePayload);

  const otherKey = outbox.enqueue({ channel: 'qq-group', target: 'group:1001', payload: basePayload, idempotencyKey: 'dedupe-2' });
  assert.equal(otherKey.deduped, false);
  assert.notEqual(otherKey.deliveryId, first.deliveryId);

  // 幂等键的作用域是 (channel,target)：同名 key 换 target 就是另一件事
  const otherTarget = outbox.enqueue({ channel: 'qq-group', target: 'group:2002', payload: basePayload, idempotencyKey: 'dedupe-1' });
  assert.equal(otherTarget.deduped, false);
  assert.notEqual(otherTarget.deliveryId, first.deliveryId);

  // 完全没有幂等键时，两次入队就是两条（调用方要幂等必须自己给键）
  const noKey1 = outbox.enqueue({ channel: 'qq-group', target: 'group:1001', payload: basePayload });
  const noKey2 = outbox.enqueue({ channel: 'qq-group', target: 'group:1001', payload: basePayload });
  assert.equal(noKey1.deduped, false);
  assert.equal(noKey2.deduped, false);
  assert.notEqual(noKey1.deliveryId, noKey2.deliveryId);
  assert.equal(outbox.list({ limit: 100 }).length, 5);
});

// ── 3. 分片 / partial ────────────────────────────────────────────────────────

test('分片：全部 ok ⇒ sent；部分 ok ⇒ partial；回执逐片落库', async (t) => {
  const { outbox } = makeEnv(t);

  // 3 个分片，全部成功
  const full = outbox.enqueue({ channel: 'qq-group', target: 'group:3003', payload: { parts: 3 }, partsTotal: 3 });
  const [fullJob] = outbox.claim({ limit: 1 });
  assert.equal(fullJob.deliveryId, full.deliveryId);
  assert.equal(fullJob.partsTotal, 3);
  outbox.markSendStarted({ attemptId: fullJob.attemptId });
  for (const partNo of [1, 2, 3]) {
    outbox.recordPartReceipt({ attemptId: fullJob.attemptId, partNo, ok: true, receipt: { partNo } });
  }
  const fullAck = outbox.ack({ attemptId: fullJob.attemptId, receipt: { parts: 3 } });
  assert.equal(fullAck.state, DELIVERY_STATE.SENT);
  assert.equal(fullAck.okCount, 3);
  assert.equal(outbox.get(full.deliveryId).receipts.length, 3);

  // 再做一条：第 3 片失败 ⇒ partial
  const partial = outbox.enqueue({ channel: 'qq-group', target: 'group:3003', payload: { parts: 3 }, partsTotal: 3 });
  const [partialJob] = outbox.claim({ limit: 1 });
  outbox.markSendStarted({ attemptId: partialJob.attemptId });
  outbox.recordPartReceipt({ attemptId: partialJob.attemptId, partNo: 1, ok: true });
  outbox.recordPartReceipt({ attemptId: partialJob.attemptId, partNo: 2, ok: true });
  outbox.recordPartReceipt({ attemptId: partialJob.attemptId, partNo: 3, ok: false, receipt: { error: 'too-large' } });
  const partialAck = outbox.ack({ attemptId: partialJob.attemptId });
  assert.equal(partialAck.state, DELIVERY_STATE.PARTIAL);
  assert.equal(partialAck.okCount, 2);
  assert.equal(partialAck.partsTotal, 3);

  const partialSnapshot = outbox.get(partial.deliveryId);
  assert.equal(partialSnapshot.state, DELIVERY_STATE.PARTIAL);
  assert.equal(partialSnapshot.sentAtMs, null, 'partial 不是完全成功，不能记 sent_at');
  assert.deepEqual(partialSnapshot.receipts.map((r) => [r.partNo, r.ok]), [[1, true], [2, true], [3, false]]);
  // partial 也是终态：不会再被领取
  assert.deepEqual(outbox.claim({ limit: 10 }), []);

  // provider 的 partial 行为可以直接驱动出同样的 partial 收口
  const provider = createMockProvider({ name: 'mock', behavior: 'partial', failFromPart: 3 });
  const third = outbox.enqueue({ channel: 'qq-group', target: 'group:3003', payload: { parts: 3 }, partsTotal: 3 });
  const [thirdJob] = outbox.claim({ limit: 1 });
  outbox.markSendStarted({ attemptId: thirdJob.attemptId });
  for (const partNo of [1, 2, 3]) {
    const result = await provider.send({ delivery: thirdJob, attempt: { attemptId: thirdJob.attemptId }, part: { partNo } });
    outbox.recordPartReceipt({ attemptId: thirdJob.attemptId, partNo, ok: result.ok, receipt: result.receipt });
  }
  assert.equal(outbox.ack({ attemptId: thirdJob.attemptId }).state, DELIVERY_STATE.PARTIAL);
  assert.equal(outbox.get(third.deliveryId).state, DELIVERY_STATE.PARTIAL);
});

// ── 4. 失败：可重试 / 不可重试 ────────────────────────────────────────────────

test('fail(retryable) 回 pending 并换新 attempt；fail(!retryable) 进 failed 终态', async (t) => {
  const { outbox } = makeEnv(t);

  const enqueued = outbox.enqueue({ channel: 'qq-group', target: 'group:4004', payload: basePayload });
  const [first] = outbox.claim({ limit: 1 });
  outbox.markSendStarted({ attemptId: first.attemptId });

  // provider 抛错（可重试）⇒ 回 pending
  const failingProvider = createMockProvider({ name: 'mock', behavior: 'throw', retryableThrown: true });
  await assert.rejects(() => failingProvider.send({ delivery: first, attempt: { attemptId: first.attemptId } }),
    (error) => error.retryable === true && error.ambiguous === false);

  const failedOnce = outbox.fail({ attemptId: first.attemptId, error: 'connect ECONNREFUSED', retryable: true });
  assert.equal(failedOnce.state, DELIVERY_STATE.PENDING);

  const afterFail = outbox.get(enqueued.deliveryId);
  assert.equal(afterFail.state, DELIVERY_STATE.PENDING);
  assert.equal(afterFail.ownerNonce, null);
  assert.equal(afterFail.leaseExpiresAtMs, null);
  assert.equal(afterFail.attemptCount, 1);
  assert.equal(afterFail.attempts[0].phase, 'failed');
  assert.equal(afterFail.attempts[0].outcome, 'retryable');

  // 重试：同一个 deliveryId，新的 attempt
  const [second] = outbox.claim({ limit: 1 });
  assert.equal(second.deliveryId, enqueued.deliveryId);
  assert.equal(second.n, 2);
  assert.notEqual(second.attemptId, first.attemptId);
  outbox.markSendStarted({ attemptId: second.attemptId });
  assert.equal(outbox.ack({ attemptId: second.attemptId }).state, DELIVERY_STATE.SENT);
  assert.equal(outbox.get(enqueued.deliveryId).attempts.length, 2);

  // 不可重试 ⇒ failed（终态，不再被领取）
  const terminal = outbox.enqueue({ channel: 'qq-group', target: 'group:4004', payload: { text: 'bad' } });
  const [badJob] = outbox.claim({ limit: 1 });
  outbox.markSendStarted({ attemptId: badJob.attemptId });
  const terminalResult = outbox.fail({ attemptId: badJob.attemptId, error: '400 invalid payload', retryable: false });
  assert.equal(terminalResult.state, DELIVERY_STATE.FAILED);
  const terminalSnapshot = outbox.get(terminal.deliveryId);
  assert.equal(terminalSnapshot.state, DELIVERY_STATE.FAILED);
  assert.equal(terminalSnapshot.resolution, 'terminal');
  assert.equal(terminalSnapshot.attempts[0].outcome, 'terminal');
  assert.deepEqual(outbox.claim({ limit: 10 }), []);

  // 失败之后旧 attempt 的句柄一律失效
  assert.throws(() => outbox.fail({ attemptId: badJob.attemptId, error: 'again', retryable: true }),
    (error) => error.code === ERR.CONFLICT);
});

// ── 5. 不可对账 ──────────────────────────────────────────────────────────────

test('reconcile_support=none 时 reconcile() 抛 DELIVERY_NOT_RECONCILABLE', async (t) => {
  const { outbox } = makeEnv(t);
  const enqueued = outbox.enqueue({ channel: 'qq-group', target: 'group:5005', payload: basePayload });
  const [job] = outbox.claim({ limit: 1 });
  outbox.markSendStarted({ attemptId: job.attemptId });

  // 默认 reconcile_support=none
  assert.equal(outbox.get(enqueued.deliveryId).reconcileSupport, RECONCILE_SUPPORT.NONE);

  const claimingProvider = createMockProvider({ name: 'mock', reconcileSupport: 'query' });
  await assert.rejects(
    () => outbox.reconcile({ attemptId: job.attemptId, provider: claimingProvider }),
    (error) => error.code === ERR.DELIVERY_NOT_RECONCILABLE,
    '即使 provider 自称支持对账，delivery 声明 none 就必须拒绝',
  );

  // provider 也声明 none 时同样拒绝
  const noneProvider = createMockProvider({ name: 'mock', reconcileSupport: 'none' });
  await assert.rejects(
    () => outbox.reconcile({ attemptId: job.attemptId, provider: noneProvider }),
    (error) => error.code === ERR.DELIVERY_NOT_RECONCILABLE,
  );

  // 提示：this.delivery 仍处于 sending，交给 expireLeases/recoverOrphans 收口（见测试 22）
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.SENDING);
});

// ── 6. lease / 续租 ──────────────────────────────────────────────────────────

test('lease：owner 续租成功；非 owner 续租失败；过期后回 pending 并可重新领取', async (t) => {
  const clock = makeClock();
  const { outbox, db } = makeEnv(t, { now: clock.now, workerNonce: 'owner-a' });

  const enqueued = outbox.enqueue({ channel: 'qq-group', target: 'group:6006', payload: basePayload });
  const [job] = outbox.claim({ limit: 1, leaseMs: 10000 });
  assert.equal(job.leaseExpiresAtMs, clock.peek() + 10000);

  // owner 在租期内续租：过期时间往后推
  clock.advance(4000);
  const beat = outbox.heartbeat({ attemptId: job.attemptId, leaseMs: 10000 });
  assert.equal(beat.leaseExpiresAtMs, clock.peek() + 10000);
  assert.equal(outbox.get(enqueued.deliveryId).leaseExpiresAtMs, beat.leaseExpiresAtMs);

  // 另一个 worker（同一个 db、同进程、不同 nonce）续租会被拒
  const other = createOutbox({ db, now: clock.now, leaseMs: 60000, workerNonce: 'owner-b' });
  assert.throws(() => other.heartbeat({ attemptId: job.attemptId }),
    (error) => error.code === ERR.DELIVERY_LEASE_LOST,
    '非 owner 续租必须 DELIVERY_LEASE_LOST');

  // 自己的 lease 过期之后也不允许续租：此时接管权已经归恢复流程
  clock.advance(10001);
  assert.throws(() => outbox.heartbeat({ attemptId: job.attemptId }),
    (error) => error.code === ERR.DELIVERY_LEASE_LOST,
    '过期 lease 不能被续租复活');

  // 过期且未 send_started ⇒ 回到 pending（可安全重试）
  const settled = await outbox.expireLeases();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].decision, DELIVERY_STATE.PENDING);
  assert.equal(settled[0].started, false);

  const after = outbox.get(enqueued.deliveryId);
  assert.equal(after.state, DELIVERY_STATE.PENDING);
  assert.equal(after.attempts[0].outcome, 'abandoned');

  // 重新领取：deliveryId 不变，attempt 换新
  const reclaimed = outbox.claim({ limit: 1 });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].deliveryId, enqueued.deliveryId);
  assert.equal(reclaimed[0].n, 2);
  assert.notEqual(reclaimed[0].attemptId, job.attemptId);
});

// ── 7. unknown_after_send ────────────────────────────────────────────────────

test('unknown_after_send：有明确原因、永不自动重发、不降级已知结果', async (t) => {
  const clock = makeClock();
  const { outbox } = makeEnv(t, { now: clock.now, workerNonce: 'worker-u' });

  const enqueued = outbox.enqueue({ channel: 'qq-group', target: 'group:7007', payload: basePayload, idempotent: false });
  const [job] = outbox.claim({ limit: 1, leaseMs: 5000 });

  // 没过 send_started 就不许标 unknown（否则本可安全重试的消息会被永久挂起）
  assert.throws(() => outbox.markUnknownAfterSend({ attemptId: job.attemptId, reason: 'nope' }),
    (error) => error.code === ERR.CONTRACT,
    '未 send_started 的 attempt 不允许进入 unknown_after_send');

  // 按正确时序继续：先落发送分界线，再模拟 ack-lost
  outbox.markSendStarted({ attemptId: job.attemptId });
  const provider = createMockProvider({ name: 'mock', behavior: 'ack-lost' });
  await assert.rejects(() => provider.send({ delivery: job, attempt: { attemptId: job.attemptId } }),
    (error) => error.ambiguous === true);
  const marked = outbox.markUnknownAfterSend({ attemptId: job.attemptId, reason: 'ack-lost: response dropped' });
  assert.equal(marked.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  assert.equal(snapshot.resolution, 'unreconcilable', 'none 通道的 unknown 必须标成不可对账');
  assert.equal(snapshot.lastError, 'ack-lost: response dropped');
  assert.equal(snapshot.sentAtMs, null, 'unknown 不能记成功时间');
  assert.equal(snapshot.attempts[0].phase, 'unknown');

  // 时间过去多久都不会自己重发
  clock.advance(10 * 60_000);
  assert.deepEqual(await outbox.expireLeases(), [], 'unknown 不在 expireLeases 的处理范围内');
  assert.deepEqual(outbox.claim({ limit: 10 }), []);
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
});

// ── 8. get / list ────────────────────────────────────────────────────────────

test('get / list 只读视图：未知 id 返回 null，list 按状态过滤', async (t) => {
  const { outbox } = makeEnv(t);
  assert.equal(outbox.get('dlv_does_not_exist'), null);

  outbox.enqueue({ channel: 'qq-group', target: 'group:8008', payload: { text: 'a' } });
  outbox.enqueue({ channel: 'qq-group', target: 'group:8008', payload: { text: 'b' } });
  outbox.claim({ limit: 1 });

  assert.equal(outbox.list({ limit: 10 }).length, 2);
  assert.equal(outbox.list({ state: DELIVERY_STATE.PENDING }).length, 1);
  assert.equal(outbox.list({ state: DELIVERY_STATE.CLAIMED }).length, 1);
  assert.equal(outbox.list({ state: DELIVERY_STATE.SENT }).length, 0);

  // claim 返回的上下文必须包含发送所需的一切
  const [pending] = outbox.list({ state: DELIVERY_STATE.PENDING });
  const [claimedJob] = outbox.claim({ limit: 1 });
  assert.equal(claimedJob.channel, pending.channel);
  assert.equal(claimedJob.target, pending.target);
  assert.ok(claimedJob.deliveryId && claimedJob.attemptId);
  assert.ok(Number.isInteger(claimedJob.leaseExpiresAtMs));
});

// ── 9. manual 是自动路径禁区 ────────────────────────────────────────────────

test('manual：任何自动路径都不得把人工裁定改走（claim / expireLeases / recoverOrphans / fail / ack）', async (t) => {
  const clock = makeClock();
  const { outbox, db } = makeEnv(t, { now: clock.now, workerNonce: 'worker-m' });

  const enqueued = outbox.enqueue({ channel: 'qq-group', target: 'group:9009', payload: basePayload });
  const [job] = outbox.claim({ limit: 1, leaseMs: 1000 });
  outbox.markSendStarted({ attemptId: job.attemptId });

  // 模拟人工裁定：直接改库（真实系统里这是运维/人工工具的动作，不属于本模块的自动路径）
  db.prepare(`UPDATE delivery SET state = 'manual', resolution = 'operator: stop sending' WHERE delivery_id = ?`)
    .run(enqueued.deliveryId);

  clock.advance(24 * 3600_000); // lease 早过期了，但 manual 不是「在途」，不该被任何恢复流程处理
  assert.deepEqual(await outbox.expireLeases(), [], 'expireLeases 不得处理 manual');
  assert.deepEqual(await outbox.recoverOrphans(), [], 'recoverOrphans 不得处理 manual');
  assert.deepEqual(outbox.claim({ limit: 10 }), [], 'manual 不得被重新领取');
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.MANUAL);
  assert.equal(outbox.get(enqueued.deliveryId).resolution, 'operator: stop sending');

  // 旧 attempt 也不能用 fail/ack 把它改走
  assert.throws(() => outbox.fail({ attemptId: job.attemptId, error: 'x', retryable: true }),
    (error) => error.code === ERR.CONFLICT);
  assert.throws(() => outbox.ack({ attemptId: job.attemptId }),
    (error) => error.code === ERR.CONFLICT);
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.MANUAL);
});

// ── 10. 参数校验 / fail-closed ──────────────────────────────────────────────

test('参数校验：不可 JSON 序列化的 payload、非法 reconcileSupport / partsTotal 一律拒绝', (t) => {
  const { outbox } = makeEnv(t);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;

  assert.throws(() => outbox.enqueue({ channel: 'qq-group', target: 'g', payload: cyclic }),
    (error) => error.code === ERR.INVALID_ARGUMENT);
  assert.throws(() => outbox.enqueue({ channel: 'qq-group', payload: basePayload }),
    (error) => error.code === ERR.INVALID_ARGUMENT);
  assert.throws(() => outbox.enqueue({ channel: 'qq-group', target: 'g', payload: basePayload, reconcileSupport: 'maybe' }),
    (error) => error.code === ERR.INVALID_ARGUMENT);
  assert.throws(() => outbox.enqueue({ channel: 'qq-group', target: 'g', payload: basePayload, partsTotal: 0 }),
    (error) => error.code === ERR.INVALID_ARGUMENT);
  assert.equal(outbox.list({ limit: 10 }).length, 0, '任何非法入队都不得留下半条记录');
});
