// P1 出站 dispatcher：恢复（R1/R2）→ 开闸 → 消费 → L0 记账 → 状态查询。
//
// 设计依据（只读）：fixes/c-send-design/C-HARDENING.md §B / C-DESIGN.md §1。
// P1 边界：不接 MCP、不新增发送端点（测试模式除外）；Host 的两处 inline 回复改为 submit()。

import fs from 'node:fs';
import path from 'node:path';

import { isProcessAlive, PROCESS_IDENTITY } from '../core/src/candidate/util.mjs';

export const OUTBOUND_STATE = Object.freeze({
  BOOTING: 'booting',
  RECOVERING: 'recovering',
  READY: 'ready',
  DEGRADED: 'degraded',
  STOPPED: 'stopped',
});

const TERMINAL_INTENT = new Set(['sent', 'failed', 'unknown_after_send']);
const DEFAULT_TICK_MS = 5000;

function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** 单实例恢复锁：state/send-recovery.lock（O_EXCL + owner 三元组；owner 存活不接管）。 */
function acquireRecoveryLock(lockPath, owner) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const write = () => {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  try { write(); return { acquired: true, holder: owner }; } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let current = null;
  try { current = safeJson(fs.readFileSync(lockPath, 'utf8')); } catch { /* 半写/损坏 → 视为可接管 */ }
  if (!current) {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    try { write(); return { acquired: true, holder: owner, tookOver: 'corrupt' }; } catch { return { acquired: false, holder: null }; }
  }
  const samePid = Number(current.pid) === Number(owner.pid);
  const sameTicks = String(current.pidStartTicks ?? '') === String(owner.pidStartTicks ?? '');
  const sameNonce = String(current.nonce) === String(owner.nonce);
  if (samePid && sameTicks && sameNonce) {
    return { acquired: false, holder: current, reason: 'recovery-lock-held' };
  }
  // pid 复用防护：同 pid 但 pid_start_ticks 不同 ⇒ 旧进程已经死了，必须允许接管。
  // owner 三元组的用途就是“证明是同一个进程”，只比 pid 不够。
  if (samePid && !sameTicks) {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    try { write(); return { acquired: true, holder: owner, tookOver: 'pid-reuse' }; } catch { return { acquired: false, holder: null, reason: 'lock-write-failed' }; }
  }
  const alive = Number.isFinite(Number(current.pid)) && isProcessAlive({ pid: Number(current.pid), pidStartTicks: current.pidStartTicks });
  if (alive) return { acquired: false, holder: current, reason: 'recovery-lock-held' };
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  try { write(); return { acquired: true, holder: owner, tookOver: 'dead-owner' }; } catch { return { acquired: false, holder: null }; }
}

/**
 * @param {{service:object, provider:object|null, l0?:{record:(x:object)=>Promise<object>|object}|null,
 *   config?:object, logger?:object, now?:()=>number, stateDir:string, hostId?:string}} deps
 */
export function createSendDispatcher({ service, provider, l0 = null, config = {}, logger = console, now = Date.now, stateDir, hostId = 'host' }) {
  if (!service?.outbox || typeof service.dispatchOnce !== 'function') throw new Error('createSendDispatcher 需要 service（含 outbox/dispatchOnce）');
  if (!stateDir) throw new Error('createSendDispatcher 需要 stateDir');
  const core = config.core ?? {};
  const recoveryTimeoutMs = clampInt(core.recoveryTimeoutMs, 10000, 1000, 60000);
  const r1BudgetMs = clampInt(core.recoveryR1BudgetMs, 20000, 1000, 120000);
  const r1MaxRows = clampInt(core.recoveryR1MaxRows, 5000, 1, 100000);
  const replyWaitMs = clampInt(core.replyWaitMs, 8000, 100, 60000);
  const replyWaitMode = String(process.env.OPENCORE_REPLY_WAIT_MODE || core.replyWaitMode || 'bounded');
  const tickMs = clampInt(core.dispatchTickMs, DEFAULT_TICK_MS, 100, 120000);
  const maxAttempts = core.maxAttempts === undefined || core.maxAttempts === null ? null : Number(core.maxAttempts);
  const leaseMs = core.dispatchLeaseMs === undefined ? 30000 : Number(core.dispatchLeaseMs);

  const lockPath = path.join(stateDir, 'send-recovery.lock');
  const auditPath = path.join(stateDir, 'outbound-audit.jsonl');
  const nonce = `disp_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const owner = {
    pid: process.pid,
    pidStartTicks: PROCESS_IDENTITY.pidStartTicks,
    nonce,
    hostId,
    acquiredAtMs: now(),
  };

  let state = OUTBOUND_STATE.BOOTING;
  let reason = null;
  let degraded = false;
  let recovery = null;
  let lockInfo = null;
  let active = false;
  let timer = null;
  let ticking = false;
  let nudgePending = false;
  let idleTicks = 0;
  const counters = {
    sent: 0, unknown: 0, failed: 0, l0Written: 0, l0Skipped: 0,
    outboundBlocked: 0, dispatchErrors: 0, lateReconcileDiscarded: 0, dispatched: 0,
  };
  const l0Seen = new Set();

  const audit = (entry) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(auditPath, `${JSON.stringify({ atMs: now(), ...entry })}\n`);
    } catch { /* 审计写失败不阻断发送 */ }
  };
  const providerConfigured = () => Boolean(provider && (typeof provider.send === 'function'));

  /** 状态迁移审计：只写 intent/delivery/attempt/state/时间/messageId 有无，绝不写正文。 */
  function auditDelivery(event, deliveryId, { messageId = null } = {}) {
    const full = service.outbox.get(deliveryId);
    if (!full) return;
    const current = full.attempts?.find((a) => a.attemptId === full.currentAttemptId) ?? full.attempts?.[full.attempts.length - 1] ?? null;
    const hasMessageId = messageId != null;
    audit({
      event,
      intentId: full.intentId,
      deliveryId: full.deliveryId,
      attemptId: current?.attemptId ?? null,
      state: full.state,
      messageIdPresent: hasMessageId,
      ...(hasMessageId ? { messageId: String(messageId) } : {}),
    });
  }

  function auditRecoveryRows(rows = []) {
    for (const row of rows) {
      if (row?.state === 'unknown_after_send') auditDelivery('delivery-unknown', row.deliveryId);
      else if (row?.state === 'sent') auditDelivery('delivery-sent', row.deliveryId, { messageId: row.messageId ?? null });
    }
  }

  function broadcast() { /* 预留：P2 SSE/WS；P1 只读轮询 */ }

  /** R1：本地收口（分支 1 → pending，分支 3 → unknown）；不受 provider 影响；all-or-nothing 报告。 */
  async function runR1() {
    const startedAt = now();
    // 测试编排专用：给外部“真持锁进程”留出晚于 service 打开 DB、早于 R1 写锁的窗口。
    // 生产默认 0，不改变任何行为。
    const orchestrationDelay = Number(process.env.OPENCORE_TEST_R1_DELAY_MS) || 0;
    if (orchestrationDelay > 0) await sleep(orchestrationDelay);
    const claimedRows = service.outbox.list({ state: 'claimed', limit: 1000 });
    const sendingRows = service.outbox.list({ state: 'sending', limit: 1000 });
    const rows = claimedRows.concat(sendingRows);
    if (rows.length >= 1000 || rows.length > r1MaxRows) {
      return { status: 'failed', total: rows.length, processed: 0, processedBeforeFailure: 0, pending: 0, unknownInconsistent: 0, skippedLiveOwner: 0, failureReason: 'r1-too-many-rows', budgetExceeded: true, durMs: now() - startedAt };
    }
    const report = service.outbox.forceSettleForRecovery({ atMs: now(), branches: [1, 3] });
    auditRecoveryRows(report.rows);
    const durMs = now() - startedAt;
    const failed = Boolean(report.error) || durMs > r1BudgetMs;
    return {
      status: failed ? 'failed' : 'ok',
      total: rows.length,
      processed: report.counts.processed,
      processedBeforeFailure: failed ? report.counts.processed : 0,
      pending: report.counts.pending,
      unknownInconsistent: report.counts.unknownInconsistent,
      skippedLiveOwner: report.counts.skippedLiveOwner,
      discarded: report.counts.discarded,
      failureReason: report.error ? `r1-error:${report.error.message}` : (failed ? 'r1-budget-exceeded' : null),
      partialError: report.error ?? null,
      budgetExceeded: !report.error && failed,
      durMs,
    };
  }

  /** R2：对账收口（分支 2）。P1 OneBot reconcile_support=none ⇒ 直接 unknown；受 recoveryTimeoutMs 约束。 */
  async function runR2() {
    const startedAt = now();
    const rows = service.outbox.list({ state: 'claimed', limit: 500 }).concat(service.outbox.list({ state: 'sending', limit: 500 }));
    let timedOut = false;
    let providerUnavailable = 0;
    let reconciledSent = 0;
    let reconciledNotSent = 0;
    let reconciledUnknown = 0;
    // 有 query 能力且配置了 provider 的通道：逐条带超时对账；P1 生产 none，走 unknown。
    for (const row of rows) {
      if (now() - startedAt > recoveryTimeoutMs) { timedOut = true; break; }
      if (row.reconcileSupport !== 'query') continue;
      if (!provider || typeof provider.reconcile !== 'function') { providerUnavailable += 1; continue; }
      const full = service.outbox.get(row.deliveryId);
      const attempt = full?.current?.attemptId ? full.attempts?.find((a) => a.attemptId === full.current.attemptId) : null;
      if (!attempt || attempt.sendStartedAtMs === null) continue; // 属于 R1
      try {
        const outcome = await withTimeout(service.outbox.reconcile({ deliveryId: row.deliveryId, provider }), Math.max(500, recoveryTimeoutMs - (now() - startedAt)));
        if (outcome.changed) {
          if (outcome.state === 'sent') {
            reconciledSent += 1;
            auditDelivery('delivery-sent', row.deliveryId, { messageId: outcome.messageId ?? null });
          } else if (outcome.state === 'pending') reconciledNotSent += 1;
          else if (outcome.state === 'unknown_after_send') {
            reconciledUnknown += 1;
            auditDelivery('delivery-unknown', row.deliveryId);
          }
        }
      } catch { timedOut = true; }
    }
    // 剩余 started 证据的行统一收口为 unknown（forceSettle 只处理 branch 2）
    let settled;
    try {
      settled = service.outbox.forceSettleForRecovery({ atMs: now(), branches: [2] });
      auditRecoveryRows(settled.rows);
    } catch (error) {
      return { status: 'failed', processed: 0, unknown: 0, timeout: 0, providerUnavailable, reconciledSent, reconciledNotSent, failureReason: `r2-error:${String(error?.message ?? error)}` };
    }
    return {
      status: timedOut ? 'failed' : 'ok',
      processed: settled.counts.processed + reconciledSent + reconciledNotSent + reconciledUnknown,
      unknown: settled.counts.unknownStarted + reconciledUnknown,
      timeout: timedOut ? 1 : 0,
      providerUnavailable,
      reconciledSent,
      reconciledNotSent,
      reconciledUnknown,
      durMs: now() - startedAt,
      failureReason: timedOut ? 'r2-timeout' : null,
    };
  }

  async function recover() {
    state = OUTBOUND_STATE.RECOVERING;
    const lock = acquireRecoveryLock(lockPath, owner);
    lockInfo = { path: lockPath, ...lock, holderPid: lock.holder?.pid ?? null, acquiredAtMs: owner.acquiredAtMs };
    if (!lock.acquired) {
      state = OUTBOUND_STATE.DEGRADED;
      reason = 'recovery-lock-held';
      recovery = { r1: null, r2: null, openedAt: null, blockedBy: 'lock', lock: lockInfo };
      audit({ event: 'recovery-lock-held', holderPid: lock.holder?.pid ?? null });
      return recovery;
    }
    audit({ event: 'recovery-lock-acquired', holderPid: owner.pid });
    let r1;
    try {
      r1 = await runR1();
    } catch (error) {
      r1 = { status: 'failed', total: 0, processed: 0, processedBeforeFailure: 0, pending: 0, unknownInconsistent: 0, skippedLiveOwner: 0, failureReason: `r1-error:${String(error?.message ?? error)}` };
    }
    audit({ event: 'recovery-r1', status: r1.status, processed: r1.processed, pending: r1.pending, unknownInconsistent: r1.unknownInconsistent, failureReason: r1.failureReason });
    if (r1.status !== 'ok') {
      state = OUTBOUND_STATE.DEGRADED;
      reason = r1.failureReason || 'r1-failed';
      recovery = { r1, r2: null, openedAt: null, blockedBy: 'r1', lock: lockInfo };
      audit({ event: 'recovery-r1-failed', reason });
      return recovery;
    }
    let r2;
    try {
      r2 = await runR2();
    } catch (error) {
      r2 = { status: 'failed', processed: 0, unknown: 0, timeout: 0, providerUnavailable: 0, reconciledSent: 0, reconciledNotSent: 0, failureReason: `r2-error:${String(error?.message ?? error)}` };
    }
    audit({ event: 'recovery-r2', status: r2.status, unknown: r2.unknown, timeout: r2.timeout, providerUnavailable: r2.providerUnavailable });
    recovery = { r1, r2, openedAt: null, blockedBy: null, lock: lockInfo };
    if (!providerConfigured()) {
      state = OUTBOUND_STATE.DEGRADED;
      reason = 'provider-unavailable';
      recovery.blockedBy = 'provider';
      return recovery;
    }
    state = OUTBOUND_STATE.READY;
    reason = null;
    degraded = Boolean(r2 && r2.status !== 'ok');
    if (degraded) reason = r2.failureReason || 'r2-reconcile-timeout';
    recovery.openedAt = now();
    audit({ event: 'recovery-open', degraded, reason });
    return recovery;
  }

  function open() {
    if (state !== OUTBOUND_STATE.READY) return false;
    active = true;
    schedule(0);
    return true;
  }

  function close() {
    active = false;
    if (timer) { clearTimeout(timer); timer = null; }
    state = OUTBOUND_STATE.STOPPED;
  }

  function schedule(delayMs) {
    if (!active) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tick().finally(() => {
        if (!active) return;
        const delay = idleTicks > 0 ? Math.min(tickMs * Math.min(2 ** idleTicks, 6), 30000) : tickMs;
        schedule(nudgePending ? 0 : delay);
      });
    }, Math.max(0, Number(delayMs) || 0));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function nudge() {
    if (!active) return;
    nudgePending = true;
    if (timer) { clearTimeout(timer); timer = null; }
    schedule(0);
  }

  async function tick() {
    if (!active || ticking) return;
    if (state !== OUTBOUND_STATE.READY) return;
    ticking = true;
    nudgePending = false;
    try {
      const batch = await service.dispatchOnce({ provider, limit: 5, maxAttempts: maxAttempts });
      counters.dispatched += Number(batch.claimed) || 0;
      if (!batch || !Array.isArray(batch.results) || batch.results.length === 0) { idleTicks += 1; return; }
      idleTicks = 0;
      for (const result of batch.results) {
        if (result.state === 'sent') {
          counters.sent += 1;
          const messageId = (result.receipts ?? []).find((r) => r?.ok && r?.receipt?.messageId != null)?.receipt?.messageId ?? null;
          auditDelivery('delivery-sent', result.deliveryId, { messageId });
          await recordL0(result);
        } else if (result.state === 'unknown_after_send') {
          counters.unknown += 1;
          auditDelivery('delivery-unknown', result.deliveryId);
          l0Seen.delete(result.deliveryId);
        } else if (result.state === 'failed') {
          counters.failed += 1;
        }
      }
    } catch (error) {
      counters.dispatchErrors += 1;
      idleTicks = Math.min(idleTicks + 1, 5);
      audit({ event: 'dispatch-error', error: String(error?.message ?? error) });
      logger?.warn?.(`[send-dispatcher] dispatch error: ${String(error?.message ?? error)}`);
    } finally {
      ticking = false;
    }
  }

  async function recordL0(result) {
    if (!l0 || typeof l0.record !== 'function') { counters.l0Skipped += 1; return; }
    const delivery = service.outbox.get(result.deliveryId);
    if (!delivery) { counters.l0Skipped += 1; return; }
    const receipts = Array.isArray(result.receipts) ? result.receipts : [];
    const messageIds = receipts.filter((r) => r.ok === true && r.receipt && r.receipt.messageId != null)
      .map((r) => String(r.receipt.messageId));
    if (messageIds.length === 0) { counters.l0Skipped += 1; return; }
    for (const messageId of messageIds) {
      const dedupeKey = `${delivery.target}|${messageId}`;
      if (l0Seen.has(dedupeKey)) continue;
      try {
        const text = typeof delivery.payload?.text === 'string' ? delivery.payload.text : '';
        const outcome = await l0.record({ key: delivery.target, text, messageId, atMs: delivery.sentAtMs ?? now() });
        if (outcome && outcome.ok === false) { counters.l0Skipped += 1; continue; }
        l0Seen.add(dedupeKey);
        counters.l0Written += 1;
      } catch {
        counters.l0Skipped += 1;
      }
    }
  }

  function messageIdOf(intent) {
    for (const delivery of intent.deliveries ?? []) {
      for (const receipt of delivery.receipts ?? []) {
        if (receipt?.ok === true && receipt.receipt && receipt.receipt.messageId != null) return String(receipt.receipt.messageId);
      }
    }
    return null;
  }

  /** Host 内部回复/（P2）MCP 意图统一入口：入队 + bounded wait。 */
  async function submit({ key, text, intentId, tool = 'send_message', source = 'host', fingerprint = null, reconcileSupport = 'none', wait = true, timeoutMs = replyWaitMs } = {}) {
    if (state !== OUTBOUND_STATE.READY) {
      counters.outboundBlocked += 1;
      audit({ event: 'outbound-blocked', source, reason: reason ?? state });
      return { accepted: false, state: 'blocked', reason: reason ?? state, intentId: intentId ?? null, deliveryId: null, messageId: null, messageMayHaveBeenSent: false };
    }
    let enqueued;
    try {
      enqueued = service.enqueueReply({ channel: 'qq', target: String(key), text: String(text), reconcileSupport, intentId, tool, source, fingerprint });
    } catch (error) {
      counters.dispatchErrors += 1;
      return { accepted: false, state: 'failed', code: error?.code ?? null, reason: String(error?.message ?? error), intentId: intentId ?? null, deliveryId: null, messageId: null, messageMayHaveBeenSent: false };
    }
    if (enqueued.deduped) {
      const existing = service.outbox.findIntent(enqueued.intentId);
      return { accepted: true, deduped: true, ...toOutbox(enqueued.intentId, existing, 0, false) };
    }
    nudge();
    const startedAt = now();
    if (!wait) {
      const intent = service.outbox.findIntent(enqueued.intentId);
      return { accepted: true, deduped: false, ...toOutbox(enqueued.intentId, intent, 0, false) };
    }
    const effectiveMode = replyWaitMode === 'sync' ? 'sync' : 'bounded';
    const budget = effectiveMode === 'sync' ? Math.max(replyWaitMs, Number(core.replyWaitSyncMs) || 240000) : Number(timeoutMs) || replyWaitMs;
    while (now() - startedAt < budget) {
      const intent = service.outbox.findIntent(enqueued.intentId);
      if (intent && TERMINAL_INTENT.has(intent.state)) {
        return { accepted: true, deduped: false, ...toOutbox(enqueued.intentId, intent, now() - startedAt, false) };
      }
      await sleep(100);
    }
    const intent = service.outbox.findIntent(enqueued.intentId);
    return { accepted: true, deduped: false, ...toOutbox(enqueued.intentId, intent, now() - startedAt, true) };
  }

  function toOutbox(intentId, intent, waitedMs, timedOut) {
    const stateValue = intent?.state ?? 'accepted';
    const messageId = messageIdOf(intent ?? { deliveries: [] });
    const base = {
      intentId, deliveryId: intent?.deliveryIds?.[0] ?? null,
      state: stateValue,
      messageId: stateValue === 'sent' ? messageId : undefined,
      waitedMs: Math.max(0, Number(waitedMs) || 0),
      timedOut: Boolean(timedOut),
      messageMayHaveBeenSent: stateValue === 'unknown_after_send',
    };
    if (timedOut) base.note = 'queued, not delivered yet';
    return base;
  }

  function status() {
    return {
      state,
      reason,
      degraded,
      providerConfigured: providerConfigured(),
      replyWaitMode,
      recovery,
      lock: lockInfo ? { holderPid: lockInfo.holderPid, acquiredAtMs: lockInfo.acquiredAtMs, acquired: lockInfo.acquired } : null,
      queue: {
        pending: service.outbox.list({ state: 'pending', limit: 500 }).length,
        unknown: service.outbox.list({ state: 'unknown_after_send', limit: 500 }).length,
      },
      counters: { ...counters, lateReconcileDiscarded: Number(service.outbox.stats?.().lateSettleDiscarded ?? 0) },
    };
  }

  function queryIntent(intentId) {
    const intent = service.outbox.findIntent(intentId);
    if (!intent) return null;
    const messageId = messageIdOf(intent);
    return { ...toOutbox(intent.intentId, intent, 0, false), deliveryId: intent.deliveryIds[0] ?? null, messageId: messageId ?? undefined, settledAtMs: intent.settledAtMs, lastError: intent.lastError };
  }

  function stop() {
    active = false;
    if (timer) { clearTimeout(timer); timer = null; }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    audit({ event: 'recovery-lock-released', holderPid: owner.pid });
    state = OUTBOUND_STATE.STOPPED;
  }

  return {
    recover, open, close: stop, nudge, submit, status, queryIntent, stop,
    get state() { return state; },
    get reason() { return reason; },
    get counters() { return { ...counters }; },
    config: { recoveryTimeoutMs, r1BudgetMs, r1MaxRows, replyWaitMs, replyWaitMode, tickMs, maxAttempts },
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`timeout:${ms}`)), ms); if (typeof t.unref === 'function') t.unref(); }),
  ]);
}
