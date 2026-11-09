// 持久投递 Outbox（candidate）。
//
// 目的：把「要发一条消息」这件事**先落盘**，再由任意进程领取执行。进程在任何时刻被
// 强杀，重启后都能从 DB 里回答两个问题：这条消息发出去了吗？还能再发吗？
//
// ── 状态机（唯一权威是 DB 行；内存里不缓存任何判定）────────────────────────────
//
//   enqueue（幂等键去重）
//        │
//        ▼
//    pending ──claim──▶ claimed ──markSendStarted──▶ sending ──ack(全部 part ok)──▶ sent
//       ▲                 │                            │  └──ack(部分 part ok)────▶ partial
//       │                 │                            ├──fail(retryable)─────────▶ pending
//       │                 │                            ├──fail(!retryable)────────▶ failed
//       │                 │                            └─markUnknownAfterSend─────▶ unknown_after_send
//       │                 │
//       └─expireLeases / recoverOrphans（未 send_started 的过期/死主 claim）──┘
//                         │
//        claimed/sending 且已 send_started：
//             ├─ 不可对账（reconcile_support='none'）──────────▶ unknown_after_send
//             ├─ 可对账，provider 答 'sent' ──────────────────▶ sent
//             ├─ 可对账，provider 答 'not-sent' ──────────────▶ pending（确定没发出去，重试安全）
//             └─ 可对账，provider 答 'unknown'/抛错 ──────────▶ unknown_after_send
//
//    manual：只由人工裁定写入；本模块的自动路径既不读它，也不会把它改走。
//
// ── 关键不变量（每一条都有对应的测试在盯）──────────────────────────────────────
//   1. `markSendStarted` 必须在真正调用 provider **之前** 落库。它是「可能已发出」与
//      「肯定没发出」的唯一分界线：没有这条记录，崩溃后只能二选一——盲目重发（可能
//      重复）或永久卡死。有了它，已开始的发送一律 fail-closed 到 unknown。
//   2. 重试只换 attempt（att_...），`delivery_id` 永远不变。稳定 id 是对外幂等和人工
//      排查的基础；每次重试用独立 attempt 记录「这一次到底做了什么」。
//   3. 进入 `unknown_after_send` 后**永不自动重发**。只有 provider 明确回答 'not-sent'
//      （确定没送达）或人工裁定（manual）才允许放行。
//   4. 所有状态迁移都在 `tx()`（BEGIN IMMEDIATE）里做 fresh read 再判定。lease 是否过期、
//      owner 是否还活着，只能拿 DB 里的当前值判断——内存里的副本在另一个进程死后就是假的。
//   5. 自动路径不碰 manual。
//
// 为什么 owner 用 (pid, pid_start_ticks, nonce) 三元组：pid 会被系统复用，同 pid 不足以
// 证明是同一个进程；nonce 用来在同 pid 内区分不同 worker（比如同进程里两个 Outbox 实例）。
// 只有「owner 进程已死」或「lease 过期」才能成为接管别人的依据。

import { CandidateError, ERR } from './errors.mjs';
import { tx } from './db.mjs';
import { PROCESS_IDENTITY, isProcessAlive, randomHex, sha256Hex } from './util.mjs';

/** delivery.state 的完整取值集合。 */
export const DELIVERY_STATE = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  SENDING: 'sending',
  SENT: 'sent',
  PARTIAL: 'partial',
  UNKNOWN_AFTER_SEND: 'unknown_after_send',
  FAILED: 'failed',
  MANUAL: 'manual',
});

/** 对账能力声明：query = 可以按业务键问上游；none = 问不了，只能接受 unknown。 */
export const RECONCILE_SUPPORT = Object.freeze({ QUERY: 'query', NONE: 'none' });

/** 「有人正在处理」的两个状态：只有这两个状态允许续租/ack/fail。 */
const IN_FLIGHT = new Set([DELIVERY_STATE.CLAIMED, DELIVERY_STATE.SENDING]);
/** 终态：自动路径不再改它（sent/partial/failed 是已确定的结局，manual 是人工裁定）。 */
const TERMINAL = new Set([DELIVERY_STATE.SENT, DELIVERY_STATE.PARTIAL, DELIVERY_STATE.FAILED, DELIVERY_STATE.MANUAL]);

const DEFAULT_LEASE_MS = 30000;
const MAX_LIMIT = 1000;

// ── 小工具 ────────────────────────────────────────────────────────────────────

function invalid(message, detail) {
  return new CandidateError(ERR.INVALID_ARGUMENT, message, detail);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`enqueue 的 ${field} 必须是非空字符串`, { field, got: value === null ? 'null' : typeof value });
  }
  return value;
}

function normLease(value, field = 'leaseMs') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw invalid(`${field} 必须是正数`, { [field]: value });
  return Math.floor(n);
}

function normLimit(value) {
  if (value === undefined || value === null) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw invalid(`limit 必须是 1..${MAX_LIMIT} 的整数`, { limit: value });
  return n;
}

function decodeJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(String(text));
  } catch {
    return String(text); // 库里存了非 JSON（历史数据/人工改过）：原样返回，不抛错也不猜
  }
}

function encodeJson(value, field) {
  if (value === undefined) throw invalid(`${field} 不能是 undefined`);
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw invalid(`${field} 必须可 JSON 序列化`, { reason: String(error?.message ?? error) });
  }
  if (typeof text !== 'string') throw invalid(`${field} 必须可 JSON 序列化（得到 ${typeof text}）`);
  return text;
}

/** provider 的对账回答归一化：任何不是明确 'sent'/'not-sent' 的东西都 fail-closed 成 unknown。 */
function normalizeReconcileAnswer(answer) {
  const text = typeof answer === 'string' ? answer.trim().toLowerCase().replace(/_/g, '-') : '';
  if (text === 'sent' || text === 'delivered') return 'sent';
  if (text === 'not-sent' || text === 'notsent' || text === 'undelivered') return 'not-sent';
  return 'unknown';
}

// ── 行读取 / 视图映射（每次调用都 fresh read，绝不缓存）─────────────────────────

function readDeliveryRow(db, deliveryId) {
  return db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(deliveryId) ?? null;
}

function readAttemptRow(db, attemptId) {
  return db.prepare('SELECT * FROM delivery_attempt WHERE attempt_id = ?').get(attemptId) ?? null;
}

function readReceiptRows(db, attemptId) {
  return db.prepare('SELECT part_no, ok, receipt, at_ms FROM delivery_part_receipt WHERE attempt_id = ? ORDER BY part_no ASC').all(attemptId);
}

function mapDelivery(row) {
  return {
    deliveryId: row.delivery_id,
    intentId: row.intent_id ?? null,
    channel: row.channel,
    target: row.target,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    idempotent: Number(row.idempotent) === 1,
    reconcileSupport: row.reconcile_support,
    payload: decodeJson(row.payload),
    payloadText: row.payload,
    partsTotal: Number(row.parts_total),
    state: row.state,
    attemptCount: Number(row.attempt_count),
    currentAttemptId: row.current_attempt_id,
    ownerPid: row.owner_pid === null ? null : Number(row.owner_pid),
    ownerPidStartTicks: row.owner_pid_start_ticks,
    ownerNonce: row.owner_nonce,
    leaseExpiresAtMs: row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    sentAtMs: row.sent_at_ms === null ? null : Number(row.sent_at_ms),
    lastError: row.last_error,
    resolution: row.resolution,
    settlementEpoch: Number(row.settlement_epoch ?? 0),
  };
}

function mapAttempt(row) {
  return {
    attemptId: row.attempt_id,
    deliveryId: row.delivery_id,
    n: Number(row.n),
    claimedAtMs: Number(row.claimed_at_ms),
    sendStartedAtMs: row.send_started_at_ms === null ? null : Number(row.send_started_at_ms),
    endedAtMs: row.ended_at_ms === null ? null : Number(row.ended_at_ms),
    phase: row.phase,
    outcome: row.outcome,
    ownerNonce: row.owner_nonce,
    detail: decodeJson(row.detail),
  };
}

function mapReceipt(row) {
  return { partNo: Number(row.part_no), ok: Number(row.ok) === 1, receipt: decodeJson(row.receipt), atMs: Number(row.at_ms) };
}

/** 该行记录的 owner 是否还是「一个活着的、我们记录的那个进程」。 */
function ownerAlive(row) {
  const pid = row.owner_pid === null || row.owner_pid === undefined ? null : Number(row.owner_pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // 同 pid：必须 pid_start_ticks 也一致才认为是我方进程（防 pid 复用）
  if (pid === PROCESS_IDENTITY.pid) return String(row.owner_pid_start_ticks ?? '') === PROCESS_IDENTITY.pidStartTicks;
  return isProcessAlive({ pid, pidStartTicks: row.owner_pid_start_ticks });
}

/** lease 是否已过期；没有 lease 记录的在途行一律视为已过期（无主可接管）。 */
function leaseExpiredAt(row, atMs) {
  if (row.lease_expires_at_ms === null || row.lease_expires_at_ms === undefined) return true;
  return Number(row.lease_expires_at_ms) <= atMs;
}

// ── 用到的 SQL 片段（集中放，避免各处手写漏列）─────────────────────────────────

const SQL_INSERT_DELIVERY = `INSERT INTO delivery(
  delivery_id, channel, target, session_id, idempotency_key, idempotent,
  reconcile_support, payload, parts_total, state, attempt_count,
  current_attempt_id, owner_pid, owner_pid_start_ticks, owner_nonce,
  lease_expires_at_ms, created_at_ms, updated_at_ms, sent_at_ms, last_error, resolution, intent_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?)`;

const SQL_INSERT_ATTEMPT = `INSERT INTO delivery_attempt(
  attempt_id, delivery_id, n, claimed_at_ms, send_started_at_ms, ended_at_ms, phase, outcome, owner_nonce, detail
) VALUES (?, ?, ?, ?, NULL, NULL, 'claimed', NULL, ?, NULL)`;

const SQL_BACK_TO_PENDING = `UPDATE delivery SET
  state = 'pending', owner_pid = NULL, owner_pid_start_ticks = NULL, owner_nonce = NULL,
  lease_expires_at_ms = NULL, updated_at_ms = ?, last_error = ?,
  settlement_epoch = settlement_epoch + 1
  WHERE delivery_id = ?`;

const SQL_TO_UNKNOWN = `UPDATE delivery SET
  state = 'unknown_after_send', resolution = ?, owner_pid = NULL, owner_pid_start_ticks = NULL,
  owner_nonce = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?, last_error = ?,
  settlement_epoch = settlement_epoch + 1
  WHERE delivery_id = ?`;

const SQL_TO_SENT = `UPDATE delivery SET
  state = 'sent', sent_at_ms = ?, resolution = ?, owner_pid = NULL, owner_pid_start_ticks = NULL,
  owner_nonce = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?, last_error = NULL,
  settlement_epoch = settlement_epoch + 1
  WHERE delivery_id = ?`;

const SQL_END_ATTEMPT = `UPDATE delivery_attempt SET phase = ?, outcome = ?, ended_at_ms = ?, detail = ?
  WHERE attempt_id = ?`;

/**
 * 创建 Outbox。
 * @param {{db: object, now?: () => number, leaseMs?: number, workerNonce?: string|null}} opts
 */
export function createOutbox({ db, now = Date.now, leaseMs = DEFAULT_LEASE_MS, workerNonce = null } = {}) {
  if (!db || typeof db.prepare !== 'function') throw invalid('createOutbox 需要 db（openDb 的返回值）');
  if (typeof now !== 'function') throw invalid('createOutbox 的 now 必须是函数（测试里可注入假时钟）');

  const baseLeaseMs = normLease(leaseMs);
  let lateSettleDiscarded = 0;
  const identity = Object.freeze({
    pid: PROCESS_IDENTITY.pid,
    pidStartTicks: PROCESS_IDENTITY.pidStartTicks,
    // 每个 Outbox 实例一个 nonce：同进程里两个 worker 也必须互相认成「别人」
    nonce: workerNonce === null || workerNonce === undefined ? `wkr_${PROCESS_IDENTITY.pid}_${randomHex(6)}` : String(workerNonce),
  });
  const at = () => Number(now());

  // ── 事务内守卫 ──────────────────────────────────────────────────────────────

  /** fresh read attempt + delivery，并校验 attempt 仍是该 delivery 的当前 attempt。 */
  function requireAttemptInTx(attemptId) {
    if (typeof attemptId !== 'string' || attemptId.length === 0) throw invalid('需要 attemptId');
    const attempt = readAttemptRow(db, attemptId);
    if (!attempt) throw new CandidateError(ERR.NOT_FOUND, `attempt 不存在：${attemptId}`);
    const delivery = readDeliveryRow(db, attempt.delivery_id);
    if (!delivery) throw new CandidateError(ERR.INTERNAL, `attempt 指向的 delivery 不存在：${attemptId}`);
    if (delivery.current_attempt_id !== attemptId) {
      // 换过 attempt 之后，旧 attempt 手里的句柄一律失效：它写下的任何东西都属于上一世。
      throw new CandidateError(ERR.CONFLICT, `attempt ${attemptId} 已不是当前 attempt（当前 ${delivery.current_attempt_id}）`, {
        attemptId,
        currentAttemptId: delivery.current_attempt_id,
        deliveryId: delivery.delivery_id,
      });
    }
    return { attempt, delivery };
  }

  /**
   * 「我仍持有这条 delivery 的合法租约」的完整校验：
   * 当前 attempt + 在途状态 + owner_nonce 是我 + lease 未过期。任何一条不满足都拒绝写。
   */
  function requireOwnedInTx(attemptId, atMs) {
    const ctx = requireAttemptInTx(attemptId);
    const { delivery } = ctx;
    if (!IN_FLIGHT.has(delivery.state)) {
      throw new CandidateError(ERR.CONFLICT, `delivery ${delivery.delivery_id} 当前状态为 ${delivery.state}，不接受该操作`, {
        deliveryId: delivery.delivery_id,
        state: delivery.state,
      });
    }
    if (String(delivery.owner_nonce ?? '') !== identity.nonce) {
      throw new CandidateError(ERR.DELIVERY_LEASE_LOST, `不是当前 owner（owner_nonce=${delivery.owner_nonce}，本实例 ${identity.nonce}）`, {
        deliveryId: delivery.delivery_id,
        attemptId,
        ownerNonce: delivery.owner_nonce,
      });
    }
    if (leaseExpiredAt(delivery, atMs)) {
      throw new CandidateError(ERR.DELIVERY_LEASE_LOST, 'lease 已过期，必须先由恢复流程收口再操作', {
        deliveryId: delivery.delivery_id,
        attemptId,
        leaseExpiresAtMs: delivery.lease_expires_at_ms,
        nowMs: atMs,
      });
    }
    return ctx;
  }

  // ── 事务内状态写入（收口动作的唯一实现，避免多条路径各写一套）────────────────

  /** 同步意图状态：同一 intentId 的只读查询必须能看到最终状态（accepted → sent/unknown/failed）。 */
  function syncIntent(row, state, atMs, { messageIds = null, error = null } = {}) {
    if (!row || !row.intent_id) return;
    db.prepare(`UPDATE delivery_intent SET
      state = ?, updated_at_ms = ?,
      settled_at_ms = CASE WHEN ? IN ('sent','failed','unknown_after_send') THEN ? ELSE settled_at_ms END,
      last_error = ?,
      message_ids = CASE WHEN ? IS NULL THEN message_ids ELSE ? END
      WHERE intent_id = ?`).run(
      state, atMs, state, atMs, error,
      messageIds === null ? null : JSON.stringify(messageIds),
      messageIds === null ? null : JSON.stringify(messageIds),
      row.intent_id,
    );
  }

  function writeBackToPending(row, atMs, reason, attemptOutcome) {
    db.prepare(SQL_BACK_TO_PENDING).run(atMs, reason, row.delivery_id);
    if (row.current_attempt_id) {
      db.prepare(SQL_END_ATTEMPT).run('failed', attemptOutcome, atMs, reason, row.current_attempt_id);
    }
    return DELIVERY_STATE.PENDING;
  }

  function writeUnknown(row, atMs, reason, attemptOutcome = 'unknown', resolution = null) {
    const res = resolution ?? (row.reconcile_support === RECONCILE_SUPPORT.QUERY ? 'awaiting-reconcile' : 'unreconcilable');
    db.prepare(SQL_TO_UNKNOWN).run(res, atMs, reason, row.delivery_id);
    syncIntent(row, 'unknown_after_send', atMs, { error: reason });
    if (row.current_attempt_id) {
      db.prepare(SQL_END_ATTEMPT).run('unknown', attemptOutcome, atMs, reason, row.current_attempt_id);
    }
    return DELIVERY_STATE.UNKNOWN_AFTER_SEND;
  }

  function writeSent(row, atMs, reason, attemptOutcome) {
    const res = attemptOutcome === 'reconciled-sent' ? 'reconciled-sent' : 'ack';
    db.prepare(SQL_TO_SENT).run(atMs, res, atMs, row.delivery_id);
    syncIntent(row, 'sent', atMs);
    if (row.current_attempt_id) {
      db.prepare(SQL_END_ATTEMPT).run('ack_received', attemptOutcome, atMs, reason, row.current_attempt_id);
    }
    return DELIVERY_STATE.SENT;
  }

  /**
   * 恢复流程的收口动作（在独立事务里 fresh read 后再写）。
   * 之所以要二次 fresh read：候选行的判断是在事务外做的，另一个进程可能已经抢先处理过。
   * @returns {{changed: boolean, state: string|null, reason: string}}
   */
  function applySettlement({ deliveryId, attemptId, decision, atMs, reason, attemptOutcome, expectedEpoch = null, resolution = null }) {
    return tx(db, () => {
      const row = readDeliveryRow(db, deliveryId);
      if (!row) return { changed: false, state: null, reason: 'missing' };
      if (attemptId && String(row.current_attempt_id ?? '') !== String(attemptId)) {
        return { changed: false, state: row.state, reason: 'stale-attempt' };
      }
      if (TERMINAL.has(row.state)) return { changed: false, state: row.state, reason: 'terminal' };
      const currentEpoch = Number(row.settlement_epoch ?? 0);
      if (expectedEpoch !== null && expectedEpoch !== undefined && Number(expectedEpoch) !== currentEpoch) {
        return { changed: false, state: row.state, reason: 'stale-epoch', currentEpoch, currentState: row.state };
      }

      if (decision === 'pending') {
        if (row.state === DELIVERY_STATE.PENDING) return { changed: false, state: row.state, reason: 'already-pending' };
        if (!IN_FLIGHT.has(row.state) && row.state !== DELIVERY_STATE.UNKNOWN_AFTER_SEND) {
          return { changed: false, state: row.state, reason: 'not-in-flight' };
        }
        return { changed: true, state: writeBackToPending(row, atMs, reason, attemptOutcome), reason, currentEpoch };
      }
      if (decision === 'unknown') {
        if (row.state === DELIVERY_STATE.UNKNOWN_AFTER_SEND) return { changed: false, state: row.state, reason: 'already-unknown' };
        if (!IN_FLIGHT.has(row.state)) return { changed: false, state: row.state, reason: 'not-in-flight' };
        return { changed: true, state: writeUnknown(row, atMs, reason, attemptOutcome, resolution), reason, currentEpoch };
      }
      if (decision === 'sent') {
        if (row.state === DELIVERY_STATE.SENT) return { changed: false, state: row.state, reason: 'already-sent' };
        if (!IN_FLIGHT.has(row.state) && row.state !== DELIVERY_STATE.UNKNOWN_AFTER_SEND) {
          return { changed: false, state: row.state, reason: 'not-in-flight' };
        }
        return { changed: true, state: writeSent(row, atMs, reason, attemptOutcome), reason, currentEpoch };
      }
      throw new CandidateError(ERR.INTERNAL, `未知的收口决策：${decision}`);
    });
  }

  /**
   * 恢复分支判定（C1–C5 四重判据 + 三分支；见 C-HARDENING §B.1）。
   * 返回 {branch:1|2|3, reason} 或 {skip:true, reason:'owner-alive'}。
   */
  function recoveryBranchFor(row, attempt, atMs) {
    const live = ownerAlive(row) && !leaseExpiredAt(row, atMs);
    if (live) return { skip: true, reason: 'owner-alive' };
    if (!attempt) return { branch: 3, reason: 'attempt-missing' };
    const attempts = db.prepare('SELECT * FROM delivery_attempt WHERE delivery_id = ?').all(row.delivery_id);
    if (Number(row.attempt_count) !== attempts.length) return { branch: 3, reason: 'attempt-count-mismatch' };
    if (String(attempt.delivery_id) !== String(row.delivery_id)) return { branch: 3, reason: 'attempt-delivery-mismatch' };
    if (Number(attempt.n) !== Number(row.attempt_count)) return { branch: 3, reason: 'attempt-n-mismatch' };
    const anyStarted = attempts.some((a) => a.send_started_at_ms !== null);
    if (attempt.send_started_at_ms !== null) return { branch: 2, reason: 'send-started' };
    if (row.state === DELIVERY_STATE.SENDING) return { branch: 3, reason: 'sending-without-started' };
    if (row.state !== DELIVERY_STATE.CLAIMED) return { branch: 3, reason: 'unexpected-state' };
    if (String(attempt.phase) !== 'claimed') return { branch: 3, reason: 'phase-contradiction' };
    const receiptCount = Number(db.prepare('SELECT COUNT(*) AS c FROM delivery_part_receipt WHERE attempt_id = ?').get(attempt.attempt_id)?.c ?? 0);
    if (receiptCount > 0) return { branch: 3, reason: 'receipt-without-started' };
    if (anyStarted) return { branch: 3, reason: 'other-attempt-started' };
    return { branch: 1, reason: 'not-started' };
  }

  /** 恢复收口（R1+R2 共用）：按三分支 CAS 落库；每行 settlement_epoch+1。 */
  function forceSettleForRecovery({ atMs = at(), branches = null } = {}) {
    const rows = db.prepare('SELECT * FROM delivery WHERE state IN (?, ?)').all(DELIVERY_STATE.CLAIMED, DELIVERY_STATE.SENDING);
    const allowed = Array.isArray(branches) ? new Set(branches.map(Number)) : null;
    const report = {
      rows: [],
      error: null,
      counts: { processed: 0, pending: 0, unknownStarted: 0, unknownInconsistent: 0, skippedLiveOwner: 0, discarded: 0, filtered: 0 },
    };
    for (const row of rows) {
      const attempt = row.current_attempt_id ? readAttemptRow(db, row.current_attempt_id) : null;
      const decision = recoveryBranchFor(row, attempt, atMs);
      const entry = { deliveryId: row.delivery_id, branch: decision.branch ?? null, reason: decision.reason };
      if (allowed && !decision.skip && !allowed.has(Number(decision.branch))) {
        report.counts.filtered += 1;
        continue;
      }
      if (decision.skip) {
        report.counts.skippedLiveOwner += 1;
        report.rows.push(entry);
        continue;
      }
      let applied;
      try {
        applied = applySettlement({
          deliveryId: row.delivery_id,
          attemptId: row.current_attempt_id,
          decision: decision.branch === 1 ? 'pending' : 'unknown',
          expectedEpoch: Number(row.settlement_epoch ?? 0),
          atMs,
          reason: decision.reason,
          attemptOutcome: decision.branch === 1 ? 'abandoned' : 'unknown',
          resolution: decision.branch === 3 ? 'recovery-inconsistent' : null,
        });
      } catch (error) {
        // 中途失败：已结算行保留结果，未处理行保持原状；R1 报告必须 failed，
        // 由 dispatcher 把 blockedBy='r1'、新意图 503 一并落状态。
        report.error = { deliveryId: row.delivery_id, message: String(error?.message ?? error) };
        report.rows.push({ ...entry, error: report.error.message });
        break;
      }
      entry.settled = applied.changed;
      entry.state = applied.state;
      if (!applied.changed) { report.counts.discarded += 1; report.rows.push(entry); continue; }
      report.counts.processed += 1;
      if (decision.branch === 1) report.counts.pending += 1;
      else if (decision.branch === 2) report.counts.unknownStarted += 1;
      else report.counts.unknownInconsistent += 1;
      report.rows.push(entry);
    }
    return report;
  }

  /** 应用层友好查询：任意 target 上是否已有该 idempotency_key（不承担并发安全，仅供 409 文案）。 */
  function findByIdempotencyKey(idempotencyKey) {
    const key = String(idempotencyKey ?? '');
    if (!key) return null;
    const row = db.prepare('SELECT * FROM delivery WHERE idempotency_key = ? ORDER BY created_at_ms ASC LIMIT 1').get(key);
    return row ? mapDelivery(row) : null;
  }

  /** 只读意图查询（含投递与回执元数据），供 /api/outbound/intent 使用。 */
  function findIntent(intentId) {
    const id = String(intentId ?? '');
    if (!id) return null;
    const intent = db.prepare('SELECT * FROM delivery_intent WHERE intent_id = ?').get(id);
    if (!intent) return null;
    const ids = decodeJson(intent.delivery_ids) ?? [];
    const deliveries = ids.map((deliveryId) => {
      const row = readDeliveryRow(db, deliveryId);
      if (!row) return null;
      const attempts = db.prepare('SELECT * FROM delivery_attempt WHERE delivery_id = ? ORDER BY n ASC').all(row.delivery_id).map(mapAttempt);
      const receipts = row.current_attempt_id
        ? readReceiptRows(db, row.current_attempt_id).map(mapReceipt)
        : [];
      return { ...mapDelivery(row), attempts, receipts };
    }).filter(Boolean);
    return {
      intentId: intent.intent_id,
      channel: intent.channel,
      target: intent.target,
      tool: intent.tool,
      source: intent.source,
      state: intent.state,
      deliveryIds: ids,
      messageIds: decodeJson(intent.message_ids) ?? [],
      createdAtMs: Number(intent.created_at_ms),
      updatedAtMs: Number(intent.updated_at_ms),
      settledAtMs: intent.settled_at_ms === null ? null : Number(intent.settled_at_ms),
      lastError: intent.last_error,
      deliveries,
    };
  }

  /**
   * claim 事务内的「先收口再派发」。
   *
   * 为什么 claim 里必须做这件事：如果只挑 pending，那些「owner 已死但 lease 还没到期」的
   * 记录会永远悬着；如果连过期的 claimed 也直接抢，就可能对一条已经开始的发送再发一次。
   * 所以这里的规则是硬编码的：没 send_started → 回 pending 可重试；已 send_started →
   * 进 unknown（claim 没有 provider，不能对账，宁可标 unknown 也绝不重发）。
   * @returns {number} 被收口的行数
   */
  function settleAbandonedInFlight(atMs) {
    const rows = db.prepare(`SELECT * FROM delivery WHERE state IN (?, ?)`).all(DELIVERY_STATE.CLAIMED, DELIVERY_STATE.SENDING);
    let settled = 0;
    for (const row of rows) {
      const abandoned = leaseExpiredAt(row, atMs) || !ownerAlive(row);
      if (!abandoned) continue;
      const attempt = row.current_attempt_id ? readAttemptRow(db, row.current_attempt_id) : null;
      if (attempt && attempt.send_started_at_ms !== null) {
        writeUnknown(row, atMs, 'lease-lost-during-send', 'unknown');
      } else {
        writeBackToPending(row, atMs, 'abandoned-before-send', 'abandoned');
      }
      settled += 1;
    }
    return settled;
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  /**
   * 入队（P1：必须携带 intentId；意图全局唯一由 delivery_intent 主键保证）。
   * 幂等语义：
   *   - 同 intentId + 同指纹 ⇒ 返回 deduped（不新增行、不再发送）；
   *   - 同 intentId + 不同指纹 ⇒ ERR.CONFLICT（intent-conflict）；
   *   - 旧式 (channel,target,idempotency_key) 唯一索引仍作为第二道兜底。
   */
  function enqueue(input = {}) {
    const channel = requireNonEmptyString(input.channel, 'channel');
    const target = requireNonEmptyString(input.target, 'target');
    const intentId = requireNonEmptyString(input.intentId, 'intentId');
    if (!Object.prototype.hasOwnProperty.call(input, 'payload')) throw invalid('enqueue 需要 payload');
    const payloadText = encodeJson(input.payload, 'payload');

    const reconcileSupport = input.reconcileSupport ?? RECONCILE_SUPPORT.NONE;
    if (!Object.values(RECONCILE_SUPPORT).includes(reconcileSupport)) {
      throw invalid(`reconcileSupport 只能是 ${Object.values(RECONCILE_SUPPORT).join(' | ')}`, { reconcileSupport });
    }
    const partsTotalRaw = input.partsTotal ?? 1;
    const partsTotal = Number(partsTotalRaw);
    if (!Number.isInteger(partsTotal) || partsTotal < 1) throw invalid('partsTotal 必须是 >= 1 的整数', { partsTotal: partsTotalRaw });

    const idemKey = input.idempotencyKey === null || input.idempotencyKey === undefined
      ? intentId
      : requireNonEmptyString(input.idempotencyKey, 'idempotencyKey');
    const idempotent = input.idempotent === null || input.idempotent === undefined ? true : Boolean(input.idempotent);
    const sessionId = input.sessionId === null || input.sessionId === undefined ? null : String(input.sessionId);
    const requestedId = input.deliveryId === null || input.deliveryId === undefined
      ? null
      : requireNonEmptyString(input.deliveryId, 'deliveryId');
    const tool = String(input.tool ?? 'send_message').slice(0, 40);
    const source = String(input.source ?? 'host').slice(0, 40);
    const fingerprint = String(input.fingerprint ?? sha256Hex(`${channel}|${target}|${tool}|${payloadText}`));
    const atMs = at();

    const insert = () => tx(db, () => {
      // ① 意图行：主键唯一 = 全局唯一性的串行化点（不是先查后插）
      const existingIntent = db.prepare('SELECT * FROM delivery_intent WHERE intent_id = ?').get(intentId);
      if (existingIntent) {
        if (String(existingIntent.fingerprint) !== fingerprint) {
          throw new CandidateError(ERR.CONFLICT, `intentId 已被不同请求占用：${intentId}`, {
            intentId, conflict: 'intent-conflict',
          });
        }
        const ids = decodeJson(existingIntent.delivery_ids) ?? [];
        return { deduped: true, intentId, deliveryId: ids[0] ?? null, deliveryIds: ids, state: existingIntent.state, reason: 'intent' };
      }
      db.prepare(`INSERT INTO delivery_intent(
        intent_id, channel, target, tool, source, fingerprint, state,
        delivery_ids, message_ids, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', '[]', '[]', ?, ?)`)
        .run(intentId, channel, target, tool, source, fingerprint, atMs, atMs);

      if (requestedId) {
        const existing = readDeliveryRow(db, requestedId);
        if (existing) return { deduped: true, intentId, deliveryId: existing.delivery_id, deliveryIds: [existing.delivery_id], state: existing.state, reason: 'delivery-id' };
      }
      if (idemKey !== null) {
        const existing = db.prepare(`SELECT delivery_id, state FROM delivery
          WHERE channel = ? AND target = ? AND idempotency_key = ?`).get(channel, target, idemKey);
        if (existing) {
          db.prepare('UPDATE delivery_intent SET delivery_ids = ?, updated_at_ms = ? WHERE intent_id = ?')
            .run(JSON.stringify([existing.delivery_id]), atMs, intentId);
          return { deduped: true, intentId, deliveryId: existing.delivery_id, deliveryIds: [existing.delivery_id], state: existing.state, reason: 'idempotency-key' };
        }
      }
      const deliveryId = requestedId ?? `dlv_${atMs.toString(36)}_${randomHex(6)}`;
      db.prepare(SQL_INSERT_DELIVERY).run(
        deliveryId, channel, target, sessionId, idemKey, idempotent ? 1 : 0,
        reconcileSupport, payloadText, partsTotal, DELIVERY_STATE.PENDING, atMs, atMs, intentId,
      );
      db.prepare('UPDATE delivery_intent SET delivery_ids = ?, updated_at_ms = ? WHERE intent_id = ?')
        .run(JSON.stringify([deliveryId]), atMs, intentId);
      return { deduped: false, intentId, deliveryId, deliveryIds: [deliveryId], state: DELIVERY_STATE.PENDING, createdAtMs: atMs };
    });

    try {
      return insert();
    } catch (error) {
      // 唯一索引撞车（理论上 BEGIN IMMEDIATE 已排除，但绝不把重复入队变成报错）
      const msg = String(error?.message ?? '');
      if (/UNIQUE|constraint/i.test(msg)) {
        if (error?.code === ERR.CONFLICT || /intent_id/i.test(msg)) {
          const intentRow = db.prepare('SELECT * FROM delivery_intent WHERE intent_id = ?').get(intentId);
          if (intentRow && String(intentRow.fingerprint) === fingerprint) {
            const ids = decodeJson(intentRow.delivery_ids) ?? [];
            return { deduped: true, intentId, deliveryId: ids[0] ?? null, deliveryIds: ids, state: intentRow.state, reason: 'unique-race' };
          }
          throw new CandidateError(ERR.CONFLICT, `intentId 并发冲突：${intentId}`, { intentId, conflict: 'intent-conflict' });
        }
        if (idemKey !== null) {
          const existing = db.prepare(`SELECT delivery_id, state, intent_id FROM delivery
            WHERE channel = ? AND target = ? AND idempotency_key = ?`).get(channel, target, idemKey);
          if (existing) {
            return { deduped: true, intentId: existing.intent_id ?? intentId, deliveryId: existing.delivery_id, deliveryIds: [existing.delivery_id], state: existing.state, reason: 'unique-race' };
          }
        }
      }
      throw error;
    }
  }

  /**
   * 领取可发送的投递。整个动作在一个写事务里：先收口无主在途行，再挑 pending。
   * 返回的每一项都是「这一次尝试」的完整上下文，调用方拿到后必须立刻 markSendStarted。
   */
  function claim(options = {}) {
    const limit = normLimit(options.limit);
    const lease = normLease(options.leaseMs ?? baseLeaseMs, 'leaseMs');
    const atMs = at();
    return tx(db, () => {
      settleAbandonedInFlight(atMs);
      const onlyId = options.deliveryId === null || options.deliveryId === undefined ? null : String(options.deliveryId);
      const rows = onlyId !== null
        ? db.prepare(`SELECT * FROM delivery WHERE state = ? AND delivery_id = ? LIMIT ?`).all(DELIVERY_STATE.PENDING, onlyId, limit)
        : db.prepare(`SELECT * FROM delivery WHERE state = ? ORDER BY created_at_ms ASC, rowid ASC LIMIT ?`).all(DELIVERY_STATE.PENDING, limit);
      const claimed = [];
      for (const row of rows) {
        const n = Number(row.attempt_count) + 1;
        const attemptId = `att_${atMs.toString(36)}_${randomHex(6)}`;
        const leaseExpiresAtMs = atMs + lease;
        const updated = db.prepare(`UPDATE delivery SET
          state = ?, attempt_count = ?, current_attempt_id = ?,
          owner_pid = ?, owner_pid_start_ticks = ?, owner_nonce = ?,
          lease_expires_at_ms = ?, updated_at_ms = ?, settlement_epoch = settlement_epoch + 1
          WHERE delivery_id = ? AND state = ?`).run(
          DELIVERY_STATE.CLAIMED, n, attemptId,
          identity.pid, identity.pidStartTicks, identity.nonce,
          leaseExpiresAtMs, atMs, row.delivery_id, DELIVERY_STATE.PENDING,
        );
        if (Number(updated.changes) !== 1) continue; // 理论上不可能：写事务内状态不会被别人改
        db.prepare(SQL_INSERT_ATTEMPT).run(attemptId, row.delivery_id, n, atMs, identity.nonce);
        claimed.push({
          deliveryId: row.delivery_id,
          attemptId,
          n,
          channel: row.channel,
          target: row.target,
          sessionId: row.session_id,
          payload: decodeJson(row.payload),
          partsTotal: Number(row.parts_total),
          reconcileSupport: row.reconcile_support,
          idempotent: Number(row.idempotent) === 1,
          claimedAtMs: atMs,
          leaseExpiresAtMs,
          ownerNonce: identity.nonce,
        });
      }
      return claimed;
    });
  }

  /**
   * **发送前**的持久化分界线。返回值里的 sendStartedAtMs 就是「从这一毫秒起，这条消息
   * 可能已经到达上游」的证据。调用方必须先拿到它，再调用 provider.send()。
   */
  function markSendStarted({ attemptId } = {}) {
    const atMs = at();
    return tx(db, () => {
      const { attempt, delivery } = requireOwnedInTx(attemptId, atMs);
      if (attempt.send_started_at_ms !== null) {
        // 重入是幂等的：时间戳认第一次，绝不因为重复调用把分界线往后挪
        return {
          attemptId, deliveryId: delivery.delivery_id, state: delivery.state,
          sendStartedAtMs: Number(attempt.send_started_at_ms), alreadyStarted: true,
        };
      }
      db.prepare(`UPDATE delivery_attempt SET send_started_at_ms = ?, phase = 'send_started' WHERE attempt_id = ?`).run(atMs, attemptId);
      db.prepare(`UPDATE delivery SET state = ?, updated_at_ms = ?, settlement_epoch = settlement_epoch + 1 WHERE delivery_id = ?`).run(DELIVERY_STATE.SENDING, atMs, delivery.delivery_id);
      return { attemptId, deliveryId: delivery.delivery_id, state: DELIVERY_STATE.SENDING, sendStartedAtMs: atMs, alreadyStarted: false };
    });
  }

  /** 记录一个分片的回执。必须在 markSendStarted 之后（回执只能来自已经开始的发送）。 */
  function recordPartReceipt({ attemptId, partNo, ok, receipt } = {}) {
    const atMs = at();
    const part = Number(partNo);
    if (!Number.isInteger(part) || part < 1) throw invalid('partNo 必须是 >= 1 的整数', { partNo });
    if (typeof ok !== 'boolean') throw invalid('ok 必须是布尔值', { ok: typeof ok });
    return tx(db, () => {
      const { attempt, delivery } = requireOwnedInTx(attemptId, atMs);
      if (attempt.send_started_at_ms === null) {
        throw new CandidateError(ERR.CONTRACT, 'recordPartReceipt 之前必须先 markSendStarted（回执只能来自已经开始的发送）', { attemptId });
      }
      const partsTotal = Number(delivery.parts_total);
      if (part > partsTotal) throw invalid(`partNo 超出 partsTotal（${part} > ${partsTotal}）`, { partNo: part, partsTotal });
      const receiptText = receipt === undefined || receipt === null ? null : encodeJson(receipt, 'receipt');
      db.prepare(`INSERT INTO delivery_part_receipt(attempt_id, part_no, ok, receipt, at_ms) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, part_no) DO UPDATE SET ok = excluded.ok, receipt = excluded.receipt, at_ms = excluded.at_ms`)
        .run(attemptId, part, ok ? 1 : 0, receiptText, atMs);
      const counted = Number(db.prepare('SELECT COUNT(*) AS c FROM delivery_part_receipt WHERE attempt_id = ?').get(attemptId).c);
      return { attemptId, partNo: part, ok, partsRecorded: counted, partsTotal };
    });
  }

  /**
   * 成功回执。全部 part ok ⇒ sent；否则 ⇒ partial。
   * 注意：单分片且没有任何 part 回执时，ack 本身就代表「这整条已被接受」⇒ sent。
   * 也允许对 unknown_after_send 做「迟到 ack」：那是确凿的成功证据，只会让状态更确定，
   * 不会导致重发（这正是我们想要的收口方向）。
   */
  function ack({ attemptId, receipt } = {}) {
    const atMs = at();
    return tx(db, () => {
      const attempt = readAttemptRow(db, attemptId);
      if (!attempt) throw new CandidateError(ERR.NOT_FOUND, `attempt 不存在：${attemptId}`);
      const delivery = readDeliveryRow(db, attempt.delivery_id);
      if (!delivery) throw new CandidateError(ERR.INTERNAL, `attempt 指向的 delivery 不存在：${attemptId}`);
      if (delivery.current_attempt_id !== attemptId) {
        throw new CandidateError(ERR.CONFLICT, `attempt ${attemptId} 已不是当前 attempt`, { deliveryId: delivery.delivery_id, attemptId });
      }
      const lateAck = delivery.state === DELIVERY_STATE.UNKNOWN_AFTER_SEND;
      if (!lateAck) requireOwnedInTx(attemptId, atMs); // 正常路径：必须仍持有 lease

      const partsTotal = Number(delivery.parts_total);
      const receipts = readReceiptRows(db, attemptId);
      const okCount = receipts.filter((row) => Number(row.ok) === 1).length;
      // 只有一个分片且没落过 part 回执：ack 直接代表整条发送成功。
      const outcome = (partsTotal === 1 && receipts.length === 0) || okCount === partsTotal
        ? DELIVERY_STATE.SENT
        : DELIVERY_STATE.PARTIAL;
      const receiptText = receipt === undefined || receipt === null ? null : encodeJson(receipt, 'receipt');

      db.prepare(`UPDATE delivery SET
        state = ?, sent_at_ms = ?, resolution = ?, owner_pid = NULL, owner_pid_start_ticks = NULL,
        owner_nonce = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?, last_error = NULL,
        settlement_epoch = settlement_epoch + 1
        WHERE delivery_id = ?`).run(
        outcome, outcome === DELIVERY_STATE.SENT ? atMs : null, lateAck ? 'late-ack' : 'ack',
        atMs, delivery.delivery_id,
      );
      db.prepare(SQL_END_ATTEMPT).run('ack_received', outcome, atMs, receiptText, attemptId);
      if (outcome === DELIVERY_STATE.SENT) {
        const ids = receipts.filter((r) => r.ok === true && r.receipt && r.receipt.messageId != null)
          .map((r) => String(r.receipt.messageId));
        syncIntent(delivery, 'sent', atMs, { messageIds: ids.length > 0 ? ids : null });
      }
      return {
        deliveryId: delivery.delivery_id, attemptId, state: outcome,
        okCount, partsTotal, lateAck,
      };
    });
  }

  /**
   * 失败上报。retryable=true ⇒ 回 pending（lease 清零，等人重新 claim）；
   * 否则 ⇒ failed 终态。调用方必须自己判断「确定没被上游接受」才能用 retryable，
   * 一旦是「响应丢了/超时/不确定」，应该走 markUnknownAfterSend 而不是这里。
   */
  function fail({ attemptId, error = null, retryable = false } = {}) {
    const atMs = at();
    const retry = Boolean(retryable);
    const message = error === null || error === undefined
      ? null
      : (typeof error === 'string' ? error : String(error.message ?? error));
    return tx(db, () => {
      const { delivery } = requireOwnedInTx(attemptId, atMs);
      db.prepare(SQL_END_ATTEMPT).run('failed', retry ? 'retryable' : 'terminal', atMs, message, attemptId);
      if (retry) {
        db.prepare(SQL_BACK_TO_PENDING).run(atMs, message, delivery.delivery_id);
        return { deliveryId: delivery.delivery_id, attemptId, state: DELIVERY_STATE.PENDING, retryable: true };
      }
      db.prepare(`UPDATE delivery SET
        state = ?, resolution = 'terminal', owner_pid = NULL, owner_pid_start_ticks = NULL,
        owner_nonce = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?, last_error = ?,
        settlement_epoch = settlement_epoch + 1
        WHERE delivery_id = ?`).run(DELIVERY_STATE.FAILED, atMs, message, delivery.delivery_id);
      syncIntent(delivery, 'failed', atMs, { error: message });
      return { deliveryId: delivery.delivery_id, attemptId, state: DELIVERY_STATE.FAILED, retryable: false };
    });
  }

  /**
   * 「已经开始发送，但结果不可知」——ack-lost / 超时 / 发送中途进程崩溃的统一出口。
   * 进入后永不自动重发；只有 reconcile 得到 'not-sent' 或人工裁定才能离开。
   */
  function markUnknownAfterSend({ attemptId, reason = null } = {}) {
    const atMs = at();
    const message = reason === null || reason === undefined ? 'unknown-after-send' : String(reason);
    return tx(db, () => {
      const attempt = readAttemptRow(db, attemptId);
      if (!attempt) throw new CandidateError(ERR.NOT_FOUND, `attempt 不存在：${attemptId}`);
      const delivery = readDeliveryRow(db, attempt.delivery_id);
      if (!delivery) throw new CandidateError(ERR.INTERNAL, `attempt 指向的 delivery 不存在：${attemptId}`);
      if (delivery.current_attempt_id !== attemptId) {
        throw new CandidateError(ERR.CONFLICT, `attempt ${attemptId} 已不是当前 attempt`, { deliveryId: delivery.delivery_id, attemptId });
      }
      if (delivery.state === DELIVERY_STATE.UNKNOWN_AFTER_SEND) {
        return { deliveryId: delivery.delivery_id, attemptId, state: delivery.state, alreadyUnknown: true };
      }
      if (TERMINAL.has(delivery.state)) {
        // 已知结局不允许被降级成「未知」：那会把一条已经确认的消息变成悬案
        throw new CandidateError(ERR.CONFLICT, `delivery 已是 ${delivery.state}，拒绝改成 unknown_after_send`, {
          deliveryId: delivery.delivery_id, state: delivery.state,
        });
      }
      if (attempt.send_started_at_ms === null) {
        // 还没开始发送就没有「发送后未知」这回事；这种情况应走 fail()/pending 重试
        throw new CandidateError(ERR.CONTRACT, 'send 尚未开始，不能标记 unknown_after_send（这会把本可安全重发的消息永久挂起）', {
          attemptId,
        });
      }
      writeUnknown(delivery, atMs, message, 'unknown');
      return { deliveryId: delivery.delivery_id, attemptId, state: DELIVERY_STATE.UNKNOWN_AFTER_SEND, alreadyUnknown: false };
    });
  }

  /** 续租。只允许当前 owner 且 lease 未过期；否则 DELIVERY_LEASE_LOST + 走恢复流程。 */
  function heartbeat({ attemptId, leaseMs: leaseOverride } = {}) {
    const atMs = at();
    const lease = normLease(leaseOverride ?? baseLeaseMs, 'leaseMs');
    return tx(db, () => {
      const { delivery } = requireOwnedInTx(attemptId, atMs);
      const leaseExpiresAtMs = atMs + lease;
      db.prepare('UPDATE delivery SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE delivery_id = ?')
        .run(leaseExpiresAtMs, atMs, delivery.delivery_id);
      return { attemptId, deliveryId: delivery.delivery_id, leaseExpiresAtMs };
    });
  }

  /**
   * 收口「lease 已过期」的在途记录（时间维度）。规则写死：
   *   未 send_started → pending（可重试，没有对外副作用）
   *   已 send_started → 可对账就问 provider；否则/答 unknown → unknown_after_send
   * @param {{provider?: object|null}} [options] 可选的 provider（支持 query 时才会用到）
   */
  async function expireLeases(options = {}) {
    return settleAbandoned({ atMs: at(), provider: options.provider ?? null, scope: 'lease' });
  }

  /**
   * 收口「owner 进程已死 **或** lease 已过期」的在途记录（进程重启后的入口）。
   * 与 expireLeases 的差别只有判据来源：这里把「进程死亡」也当成确凿的失效证据。
   */
  async function recoverOrphans(options = {}) {
    return settleAbandoned({ atMs: at(), provider: options.provider ?? null, scope: 'orphan' });
  }

  /**
   * 恢复流程的公共实现。
   * 注意 provider.reconcile 是外部 IO：它**在事务外**调用，绝不持写锁等网络。
   * 拿到答案后再用 applySettlement 做一次 fresh read 的短事务落库。
   */
  async function settleAbandoned({ atMs, provider, scope }) {
    const rows = db.prepare(`SELECT * FROM delivery WHERE state IN (?, ?)`).all(DELIVERY_STATE.CLAIMED, DELIVERY_STATE.SENDING);
    const results = [];
    for (const row of rows) {
      const dead = !ownerAlive(row);
      const expired = leaseExpiredAt(row, atMs);
      const eligible = scope === 'lease' ? expired : (expired || dead);
      if (!eligible) continue;

      const attempt = row.current_attempt_id ? readAttemptRow(db, row.current_attempt_id) : null;
      const started = Boolean(attempt && attempt.send_started_at_ms !== null);
      const baseReason = dead ? 'owner-process-dead' : 'lease-expired';
      const deliveryId = row.delivery_id;
      const attemptId = attempt ? attempt.attempt_id : null;

      if (!started) {
        // 没有任何对外副作用：直接回 pending，下一次 claim 会换新 attempt
        const applied = applySettlement({
          deliveryId, attemptId, decision: 'pending', atMs,
          reason: baseReason, attemptOutcome: 'abandoned',
        });
        results.push({ deliveryId, attemptId, started: false, decision: applied.state, reason: baseReason, changed: applied.changed });
        continue;
      }

      if (row.reconcile_support === RECONCILE_SUPPORT.QUERY && provider && typeof provider.reconcile === 'function') {
        let answer = 'unknown';
        try {
          answer = await provider.reconcile({ delivery: mapDelivery(row), attempt: attempt ? mapAttempt(attempt) : null });
        } catch {
          answer = 'unknown'; // 对账本身失败 = 仍然不可知：fail-closed
        }
        const normalized = normalizeReconcileAnswer(answer);
        const decision = normalized === 'sent' ? 'sent' : normalized === 'not-sent' ? 'pending' : 'unknown';
        const applied = applySettlement({
          deliveryId, attemptId, decision, atMs,
          reason: `${baseReason}:reconciled-${normalized}`,
          attemptOutcome: `reconciled-${normalized}`,
        });
        results.push({ deliveryId, attemptId, started: true, decision: applied.state, reconciled: normalized, reason: baseReason, changed: applied.changed });
        continue;
      }

      // 不可对账（或没给 provider）⇒ 永远停在 unknown，绝不赌一把重发
      const applied = applySettlement({
        deliveryId, attemptId, decision: 'unknown', atMs,
        reason: `no-reconcile:${baseReason}`, attemptOutcome: 'unknown',
      });
      results.push({ deliveryId, attemptId, started: true, decision: applied.state, reason: baseReason, changed: applied.changed });
    }
    return results;
  }

  /**
   * 主动对账：唯一能把 unknown_after_send 变回 pending/sent 的自动入口。
   * 能力声明以 delivery 行（入队时持久化）为准；provider 自称 none 也拒绝。
   * @param {{attemptId?: string, deliveryId?: string, provider: object}} input
   */
  async function reconcile(input = {}) {
    const attemptId = input.attemptId ?? null;
    const deliveryId = input.deliveryId ?? null;
    const provider = input.provider ?? null;
    if (!attemptId && !deliveryId) throw invalid('reconcile 需要 attemptId 或 deliveryId');
    if (!provider || typeof provider.reconcile !== 'function') throw invalid('reconcile 需要带 reconcile() 的 provider');

    // 定位（fresh read；对账前不信任任何缓存）
    let deliveryRow;
    let attemptRow = null;
    if (attemptId) {
      attemptRow = readAttemptRow(db, attemptId);
      if (!attemptRow) throw new CandidateError(ERR.NOT_FOUND, `attempt 不存在：${attemptId}`);
      deliveryRow = readDeliveryRow(db, attemptRow.delivery_id);
    } else {
      deliveryRow = readDeliveryRow(db, deliveryId);
      if (!deliveryRow) throw new CandidateError(ERR.NOT_FOUND, `delivery 不存在：${deliveryId}`);
      attemptRow = deliveryRow.current_attempt_id ? readAttemptRow(db, deliveryRow.current_attempt_id) : null;
    }
    if (!deliveryRow) throw new CandidateError(ERR.NOT_FOUND, `delivery 不存在：${attemptId ?? deliveryId}`);
    if (!attemptRow) throw new CandidateError(ERR.CONFLICT, `delivery ${deliveryRow.delivery_id} 还没有 attempt，无法对账`);

    // 能力声明检查必须先于任何副作用：声明 none 的通道，我们连问都不该问
    if (deliveryRow.reconcile_support !== RECONCILE_SUPPORT.QUERY) {
      throw new CandidateError(ERR.DELIVERY_NOT_RECONCILABLE, `delivery ${deliveryRow.delivery_id} 入队时声明 reconcile_support=none，不能对账`, {
        deliveryId: deliveryRow.delivery_id, reconcileSupport: deliveryRow.reconcile_support,
      });
    }
    if (provider.reconcileSupport !== undefined && provider.reconcileSupport !== RECONCILE_SUPPORT.QUERY) {
      throw new CandidateError(ERR.DELIVERY_NOT_RECONCILABLE, `provider ${provider.name ?? '?'} 没有对账能力（reconcileSupport=${provider.reconcileSupport}）`, {
        provider: provider.name, reconcileSupport: provider.reconcileSupport,
      });
    }
    // P1 防迟到反写：终态 unknown 上的对账一律丢弃（不调 provider、不写状态）
    if (deliveryRow.state === DELIVERY_STATE.UNKNOWN_AFTER_SEND) {
      lateSettleDiscarded += 1;
      return {
        deliveryId: deliveryRow.delivery_id, attemptId: attemptRow.attempt_id,
        changed: false, discarded: true, reason: 'terminal-unknown', state: deliveryRow.state,
      };
    }
    // 只允许对 in-flight（claimed/sending）发起对账
    if (deliveryRow.state !== DELIVERY_STATE.CLAIMED && deliveryRow.state !== DELIVERY_STATE.SENDING) {
      throw new CandidateError(ERR.CONFLICT, `delivery 当前状态 ${deliveryRow.state} 不需要对账（只有 claimed / sending 可对账；unknown 一律丢弃）`, {
        deliveryId: deliveryRow.delivery_id, state: deliveryRow.state,
      });
    }
    const expectedEpoch = Number(deliveryRow.settlement_epoch ?? 0);

    // 外部 IO 在事务外
    let answer = 'unknown';
    try {
      answer = await provider.reconcile({ delivery: mapDelivery(deliveryRow), attempt: mapAttempt(attemptRow) });
    } catch {
      answer = 'unknown';
    }
    const normalized = normalizeReconcileAnswer(answer);
    const decision = normalized === 'sent' ? 'sent' : normalized === 'not-sent' ? 'pending' : 'unknown';
    const applied = applySettlement({
      deliveryId: deliveryRow.delivery_id, attemptId: attemptRow.attempt_id, decision, atMs: at(),
      reason: `reconcile:${normalized}`, attemptOutcome: `reconciled-${normalized}`, expectedEpoch,
    });
    if (!applied.changed && (applied.reason === 'stale-epoch' || applied.reason === 'terminal' || applied.reason === 'stale-attempt' || applied.reason === 'not-in-flight' || applied.reason === 'already-unknown')) {
      lateSettleDiscarded += 1;
      return {
        deliveryId: deliveryRow.delivery_id, attemptId: attemptRow.attempt_id,
        reconciled: normalized, decision, state: applied.state, changed: false,
        discarded: true, reason: applied.reason, expectedEpoch, currentEpoch: applied.currentEpoch ?? null,
      };
    }
    return {
      deliveryId: deliveryRow.delivery_id, attemptId: attemptRow.attempt_id,
      reconciled: normalized, decision, state: applied.state, changed: applied.changed,
    };
  }

  /** 只读：单条投递 + 全部 attempt + 当前 attempt 的分片回执。 */
  function get(deliveryId) {
    const row = readDeliveryRow(db, String(deliveryId));
    if (!row) return null;
    const attemptRows = db.prepare('SELECT * FROM delivery_attempt WHERE delivery_id = ? ORDER BY n ASC').all(row.delivery_id);
    const attempts = attemptRows.map((attemptRow) => ({
      ...mapAttempt(attemptRow),
      receipts: readReceiptRows(db, attemptRow.attempt_id).map(mapReceipt),
    }));
    const current = attempts.find((item) => item.attemptId === row.current_attempt_id) ?? null;
    return { ...mapDelivery(row), attempts, current, receipts: current ? current.receipts : [] };
  }

  /** 只读：按状态列出（默认 50 条，按入队顺序）。 */
  function list(options = {}) {
    const limit = options.limit === undefined || options.limit === null ? 50 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid(`list.limit 必须是 1..${MAX_LIMIT} 的整数`);
    const state = options.state ?? null;
    if (state !== null && !Object.values(DELIVERY_STATE).includes(state)) throw invalid(`未知的 state：${state}`);
    const rows = state === null
      ? db.prepare('SELECT * FROM delivery ORDER BY created_at_ms ASC, rowid ASC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM delivery WHERE state = ? ORDER BY created_at_ms ASC, rowid ASC LIMIT ?').all(state, limit);
    return rows.map(mapDelivery);
  }

  return {
    enqueue,
    claim,
    markSendStarted,
    recordPartReceipt,
    ack,
    fail,
    markUnknownAfterSend,
    heartbeat,
    expireLeases,
    recoverOrphans,
    reconcile,
    get,
    list,
    // P1 新增：意图/幂等查询 + 恢复收口
    findByIdempotencyKey,
    findIntent,
    forceSettleForRecovery,
    recoveryBranchFor,
    stats: () => ({ lateSettleDiscarded }),
    // 诊断用：本实例的身份（owner_pid / nonce），测试与 service 层断言会用到
    identity,
    state: DELIVERY_STATE,
    reconcileSupport: RECONCILE_SUPPORT,
  };
}

export { normalizeReconcileAnswer };
