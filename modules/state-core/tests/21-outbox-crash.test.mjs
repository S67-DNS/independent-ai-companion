// 阶段 C-2：崩溃注入（真实子进程 + 真实 SIGKILL + 重新打开同一个 db 文件）。
//
// 每个用例的形状完全一样，只有崩溃点不同：
//   父进程先入队一条投递 → 关闭连接 → 起真实子进程执行并「暴毙」→ 父进程重新打开
//   同一个 db 文件（WAL 恢复）→ 用恢复流程收口 → 断言状态。
//
// 为什么不能用同进程 try/catch 模拟：崩溃测试要验证的是「进程消失后，磁盘上留下的状态
// 到底说明了什么」。try/catch 里异常被捕获就回滚了，那是完全不同的世界。
//
// 跑法：node --test tests/21-outbox-crash.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/candidate/db.mjs';
import { createOutbox, DELIVERY_STATE } from '../src/candidate/delivery-outbox.mjs';
import { createMockProvider } from '../src/candidate/delivery-provider.mjs';
import { REPO_ROOT, ensureDir, randomHex } from '../src/candidate/util.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'support', 'outbox-child.mjs');
const LEASE_MS = 60000;

/** 起子进程并等它退出。用 spawn（不是 fork）：要的就是一个独立 PID 的 OS 进程。 */
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

/**
 * 准备一个崩溃现场：父进程入队 → 关连接 → 子进程按 crash point 执行并强杀自己。
 * @param {string} crashPoint
 */
async function crashScene(crashPoint) {
  const dir = ensureDir(path.join(REPO_ROOT, 'data', `test-outbox-21-${crashPoint}-${process.pid}-${randomHex(4)}`));
  const dbPath = path.join(dir, 'outbox.sqlite3');
  const payload = { kind: 'text', text: `crash at ${crashPoint}` };

  const seedDb = openDb(dbPath, { migrate: true });
  const seedOutbox = createOutbox({ db: seedDb, leaseMs: LEASE_MS, workerNonce: 'parent-seed' });
  const enqueued = seedOutbox.enqueue({ channel: 'qq-group', target: 'group:9101', payload });
  seedDb.close();

  const childResult = await runChild([
    '--mode', 'crash',
    '--db', dbPath,
    '--crash-at', crashPoint,
    '--lease-ms', String(LEASE_MS),
    '--marker-dir', dir,
  ]);

  // 子进程死后重新打开**同一个 db 文件**：这一步同时验证了 WAL 的崩溃恢复
  const db = openDb(dbPath, { migrate: true });
  const outbox = createOutbox({ db, leaseMs: LEASE_MS, workerNonce: 'parent-recovery' });
  return { dir, dbPath, db, outbox, enqueued, payload, childResult };
}

function markers(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('accepted-'));
}

// ── 1. claim 之前崩：什么都没发生 ─────────────────────────────────────────────

test('crash at claim-before：投递仍在 pending，没有任何 attempt', async (t) => {
  const { db, outbox, enqueued, childResult } = await crashScene('claim-before');
  t.after(() => { try { db.close(); } catch { /* ignore */ } });

  assert.match(childResult.stdout, /CHILD-CRASH claim-before/, '子进程必须死在指定崩溃点');
  assert.notEqual(childResult.code, 0, '被 SIGKILL 的进程不应以 0 退出');

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.PENDING);
  assert.equal(snapshot.attemptCount, 0);
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.ownerPid, null);

  assert.deepEqual(await outbox.recoverOrphans(), [], '没有在途记录，恢复流程无事可做');

  const claimed = outbox.claim({ limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].n, 1, '从未被领取过，所以是第 1 次 attempt');
  assert.equal(claimed[0].deliveryId, enqueued.deliveryId);
});

// ── 2. claim 之后崩（未 sendStarted）─────────────────────────────────────────

test('crash at claim-after：死 owner 的 claim 被 recoverOrphans 收回 pending，换 attempt 重发', async (t) => {
  const { dir, db, outbox, enqueued, childResult } = await crashScene('claim-after');
  t.after(() => { try { db.close(); } catch { /* ignore */ } });

  assert.match(childResult.stdout, /CHILD-CRASH claim-after/);

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.CLAIMED);
  assert.equal(snapshot.attemptCount, 1);
  assert.equal(snapshot.ownerPid, childResult.pid, 'owner 必须记录死掉的子进程 pid');
  assert.equal(snapshot.attempts[0].sendStartedAtMs, null, '没发过就是没发过');
  assert.deepEqual(markers(dir), [], 'provider 绝不能被调用过');

  // lease 还没过期（60s）：expireLeases 按「时间」判断，此时不该动它
  assert.deepEqual(await outbox.expireLeases(), [], 'lease 未过期时 expireLeases 不得接管');
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.CLAIMED);

  // 唯一确凿的失效证据是「owner 进程已死」——由 recoverOrphans 使用
  const recovered = await outbox.recoverOrphans();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].started, false);
  assert.equal(recovered[0].decision, DELIVERY_STATE.PENDING);
  assert.equal(recovered[0].reason, 'owner-process-dead');

  const afterRecovery = outbox.get(enqueued.deliveryId);
  assert.equal(afterRecovery.state, DELIVERY_STATE.PENDING);
  assert.equal(afterRecovery.attempts[0].phase, 'failed');
  assert.equal(afterRecovery.attempts[0].outcome, 'abandoned');

  // 重新领取：deliveryId 不变，attempt 换新（n=2）
  const [retried] = outbox.claim({ limit: 1 });
  assert.equal(retried.deliveryId, enqueued.deliveryId);
  assert.equal(retried.n, 2);
  assert.notEqual(retried.attemptId, snapshot.attempts[0].attemptId);

  // 旧 attempt 的句柄彻底失效：死了的 worker 就算复活也不能写
  assert.throws(() => outbox.markSendStarted({ attemptId: snapshot.attempts[0].attemptId }),
    (error) => error.code === 'conflict');
});

// ── 3. sendStarted 之前崩（做过心跳）─────────────────────────────────────────

test('crash at send-started-before：续租过但未开始发送，仍是可安全重试的 pending', async (t) => {
  const { db, outbox, enqueued, childResult } = await crashScene('send-started-before');
  t.after(() => { try { db.close(); } catch { /* ignore */ } });

  assert.match(childResult.stdout, /CHILD-CRASH send-started-before/);
  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.CLAIMED);
  assert.equal(snapshot.attempts[0].sendStartedAtMs, null, '心跳不等于发送');

  const recovered = await outbox.recoverOrphans();
  assert.equal(recovered[0].decision, DELIVERY_STATE.PENDING);
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.PENDING);
});

// ── 4. sendStarted 之后、provider 调用之前崩 ─────────────────────────────────

test('crash at send-started-after：已过发送分界线 ⇒ unknown_after_send，永不自动重发', async (t) => {
  const { dir, db, outbox, enqueued, childResult } = await crashScene('send-started-after');
  t.after(() => { try { db.close(); } catch { /* ignore */ } });

  assert.match(childResult.stdout, /CHILD-CRASH send-started-after/);

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.SENDING, 'markSendStarted 之后状态就是 sending');
  assert.equal(typeof snapshot.attempts[0].sendStartedAtMs, 'number');
  assert.deepEqual(markers(dir), [], 'provider 还没来得及被调用');

  const recovered = await outbox.recoverOrphans({ provider: createMockProvider({ name: 'mock', reconcileSupport: 'none' }) });
  assert.equal(recovered[0].started, true);
  assert.equal(recovered[0].decision, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  const after = outbox.get(enqueued.deliveryId);
  assert.equal(after.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  assert.equal(after.sentAtMs, null, '没有证据就不能记为成功');
  assert.equal(after.resolution, 'unreconcilable');
  assert.equal(after.attempts[0].phase, 'unknown');
  assert.deepEqual(outbox.claim({ limit: 10 }), [], 'unknown 永不被自动重发');
});

// ── 5. provider 已接受、ack 之前崩（最危险：外部世界已经变了）──────────────────

test('crash at after-provider-send-before-ack：上游已接受但无回执 ⇒ 判 unknown，不得当成功、不得重发', async (t) => {
  const { dir, db, outbox, enqueued, childResult } = await crashScene('after-provider-send-before-ack');
  t.after(() => { try { db.close(); } catch { /* ignore */ } });

  assert.match(childResult.stdout, /CHILD-CRASH after-provider-send-before-ack/);
  assert.equal(markers(dir).length, 1, 'marker 文件证明上游确实接受过这条消息');

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.SENDING);
  assert.equal(typeof snapshot.attempts[0].sendStartedAtMs, 'number');
  assert.equal(snapshot.sentAtMs, null);

  // 不可对账 ⇒ 只能收口成 unknown
  const recovered = await outbox.recoverOrphans();
  assert.equal(recovered[0].decision, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  const after = outbox.get(enqueued.deliveryId);
  assert.equal(after.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  assert.notEqual(after.state, DELIVERY_STATE.SENT, '没有 ack 就不能当成功');
  assert.notEqual(after.state, DELIVERY_STATE.FAILED, '更不能当失败——那会导致重复投递');
  assert.equal(after.sentAtMs, null);
  assert.deepEqual(outbox.claim({ limit: 10 }), [], '不得自动重发');

  // 之后再怎么"过期"也不会变
  assert.deepEqual(await outbox.expireLeases(), []);
  assert.equal(outbox.get(enqueued.deliveryId).state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
});

// ── 6. 回执已落、ack 之前崩 ─────────────────────────────────────────────────

test('crash at before-ack：有 part 回执但没有 ack ⇒ 仍然只能判 unknown', async (t) => {
  const { dir, db, outbox, enqueued, childResult } = await crashScene('before-ack');
  t.after(() => { try { db.close(); } catch { /* ignore */ } });

  assert.match(childResult.stdout, /CHILD-CRASH before-ack/);
  assert.equal(markers(dir).length, 1);

  const snapshot = outbox.get(enqueued.deliveryId);
  assert.equal(snapshot.state, DELIVERY_STATE.SENDING);
  assert.equal(snapshot.receipts.length, 1, '分片回执已经落库');
  assert.equal(snapshot.receipts[0].ok, true);
  assert.equal(snapshot.sentAtMs, null);

  // 有回执 ≠ 成功：没有 ack 这一终结动作，就仍然没有「整条已送达」的证据
  const recovered = await outbox.recoverOrphans();
  assert.equal(recovered[0].decision, DELIVERY_STATE.UNKNOWN_AFTER_SEND);

  const after = outbox.get(enqueued.deliveryId);
  assert.equal(after.state, DELIVERY_STATE.UNKNOWN_AFTER_SEND);
  assert.equal(after.attempts[0].phase, 'unknown');
  assert.equal(outbox.list({ state: DELIVERY_STATE.SENT, limit: 10 }).length, 0);
});
