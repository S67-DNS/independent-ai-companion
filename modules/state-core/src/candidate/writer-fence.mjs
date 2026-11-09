// 阶段 A：Writer Ownership / Session Fencing（跨进程，不是进程内队列）
//
// 为什么必须落库：PROJECT_NAME与 DSH、旧桥、其它客户端是不同进程。进程内的 Queue 只能
// 保证「同一个 Node 进程里不并发」，对「第二个进程同时写同一个 Session」毫无约束。
// 所以所有权、租约、代数（lifecycleRevision）全部写进 SQLite，并且每次读写都用
// BEGIN IMMEDIATE 拿写锁后 **fresh read** 再判断。
//
// 状态模型（每个 session 一行 writer_claim）：
//
//   idle ──claim──▶ active(runId, revision) ──renew──▶ active(心跳续租)
//                        │                                │
//                        ├──release──▶ idle               │
//                        └──lease 过期 / owner 进程已死 ──┴──▶ 可被他人 takeover（revision+1）
//
// 三条不变量：
//   1. 任何时刻最多一个 runId 持有未过期租约；
//   2. 所有权变更必然使 revision 单调 +1，旧 (runId,revision) 永久失效；
//   3. 写入必须在持有 fence 的事务里完成，且 COMMIT 前再复核一次。
//
// 关于「COMMIT 前复核」到底防什么（不能含糊）：
//   * 开始时的 fresh read 防的是「拿着过期 revision 进事务」——旧 Writer 延迟提交
//     时，新 Writer 早已把 revision 推高，fresh read 立刻发现；
//   * COMMIT 前的复核防的是「事务体自己把所有权弄丢了」——例如 fn 里调了
//     release()/claim() 或嵌套调用改了 claim 行。SQLite 的写锁保证别的事务此刻
//     改不了这一行，所以它证明的是「提交这一刻，我们仍然是 owner」，
//     而不是「外部没人抢」——后者由写锁 + fresh read 覆盖。

import { CandidateError, ERR } from './errors.mjs';
import { tx } from './db.mjs';
import { nowMs, newId, PROCESS_IDENTITY, isProcessAlive } from './util.mjs';

const COLUMNS = `session_id, lifecycle_revision, active_writer_run_id, owner_identity,
  owner_pid, owner_pid_start_ticks, owner_nonce, state, claimed_at_ms, heartbeat_at_ms, lease_expires_at_ms`;

function rowToClaim(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    revision: Number(row.lifecycle_revision),
    runId: row.active_writer_run_id ?? null,
    writerIdentity: row.owner_identity ?? null,
    pid: row.owner_pid == null ? null : Number(row.owner_pid),
    pidStartTicks: row.owner_pid_start_ticks ?? null,
    nonce: row.owner_nonce ?? null,
    state: row.state,
    claimedAtMs: Number(row.claimed_at_ms ?? 0),
    heartbeatAtMs: Number(row.heartbeat_at_ms ?? 0),
    leaseExpiresAtMs: Number(row.lease_expires_at_ms ?? 0),
  };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是非空字符串`, { field });
  }
  return value;
}

function requireSafeInt(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是安全整数`, { field, value });
  }
  return value;
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, now?: () => number, defaultLeaseMs?: number}} opts
 */
export function createWriterFence({ db, now = nowMs, defaultLeaseMs = 30_000 } = {}) {
  if (!db) throw new CandidateError(ERR.INVALID_ARGUMENT, 'createWriterFence 需要 db');

  const readClaim = (sessionId) => rowToClaim(
    db.prepare(`SELECT ${COLUMNS} FROM writer_claim WHERE session_id = ?`).get(sessionId),
  );

  function audit(sessionId, kind, { runId = null, revision = null, detail = null } = {}) {
    db.prepare('INSERT INTO writer_audit(at_ms, session_id, kind, run_id, revision, detail) VALUES (?,?,?,?,?,?)')
      .run(now(), sessionId, kind, runId, revision, detail == null ? null : JSON.stringify(detail));
  }

  /**
   * 该 claim 的 owner 是否已经不可能再写：
   *   - 租约过期；
   *   - 或 owner 进程已死（pid 不存在）；pid 被复用的情况由 pidStartTicks 兜底。
   * 注意：这里只用于「能否 takeover」的判断，绝不用于「旧 writer 的结果还算不算数」——
   * 后者一律以 revision/runId 为准。
   */
  function ownerIsGone(claim, at) {
    if (!claim) return true;
    if (claim.state === 'idle') return true;
    if (claim.leaseExpiresAtMs <= at) return true;
    if (claim.pid == null) return true;
    return !isProcessAlive({ pid: claim.pid, pidStartTicks: claim.pidStartTicks });
  }

  function validateOrThrow(claim, { sessionId, runId, revision }, at) {
    if (!claim || claim.state !== 'active') {
      throw new CandidateError(ERR.FENCE_LOST, `会话 ${sessionId} 当前无 writer`, { sessionId, runId, revision });
    }
    if (claim.runId !== runId) {
      throw new CandidateError(ERR.FENCE_LOST, `会话 ${sessionId} 的 writer 已变更为 ${claim.runId ?? 'null'}`, {
        sessionId, expectedRunId: runId, actualRunId: claim.runId,
      });
    }
    if (claim.revision !== revision) {
      throw new CandidateError(ERR.FENCE_LOST, `会话 ${sessionId} 的 lifecycleRevision 已从 ${revision} 变为 ${claim.revision}`, {
        sessionId, runId, expectedRevision: revision, actualRevision: claim.revision,
      });
    }
    if (claim.leaseExpiresAtMs <= at) {
      throw new CandidateError(ERR.LEASE_EXPIRED, `会话 ${sessionId} 的 write lease 已过期`, {
        sessionId, runId, leaseExpiresAtMs: claim.leaseExpiresAtMs, now: at,
      });
    }
    return claim;
  }

  return {
    /** 当前 claim 快照（只读；不要用它做写入决策，写入决策必须在事务内 fresh read）。 */
    snapshot(sessionId) {
      requireString(sessionId, 'sessionId');
      return readClaim(sessionId);
    },

    audit(sessionId, limit = 100) {
      requireString(sessionId, 'sessionId');
      return db.prepare('SELECT id, at_ms, session_id, kind, run_id, revision, detail FROM writer_audit WHERE session_id = ? ORDER BY id DESC LIMIT ?')
        .all(sessionId, Math.max(1, Math.min(Number(limit) | 0, 1000)))
        .map((r) => ({
          id: Number(r.id), atMs: Number(r.at_ms), sessionId: r.session_id, kind: r.kind,
          runId: r.run_id, revision: r.revision == null ? null : Number(r.revision),
          detail: r.detail ? JSON.parse(r.detail) : null,
        }));
    },

    /**
     * 取得写所有权。无主 / 租约过期 / owner 进程已死 → 取得；否则 WRITER_BUSY。
     * 同一 runId + 未过期租约 → 幂等返回（不推高 revision，避免自己把自己作废）。
     */
    claim({ sessionId, writerIdentity, ttlMs = defaultLeaseMs }) {
      requireString(sessionId, 'sessionId');
      requireString(writerIdentity, 'writerIdentity');
      const ttl = Math.max(1000, Number(ttlMs) | 0);
      const outcome = tx(db, () => {
        const at = now();
        const existing = readClaim(sessionId);
        if (existing && existing.state === 'active' && existing.runId && existing.pid === PROCESS_IDENTITY.pid
          && existing.pidStartTicks === PROCESS_IDENTITY.pidStartTicks && existing.leaseExpiresAtMs > at
          && existing.writerIdentity === writerIdentity) {
          // 同一个 writer 在同一进程里重复 claim：视为续租，不推高 revision。
          // 注意必须同时比对 writerIdentity —— 否则同一进程里的两个不同写入者
          // （例如两个模块/两个租户）会被误认成同一个人，fence 就形同虚设。
          const expires = at + ttl;
          db.prepare('UPDATE writer_claim SET heartbeat_at_ms = ?, lease_expires_at_ms = ? WHERE session_id = ?')
            .run(at, expires, sessionId);
          audit(sessionId, 'claim-idempotent', { runId: existing.runId, revision: existing.revision });
          return { sessionId, runId: existing.runId, revision: existing.revision, leaseExpiresAtMs: expires, resumed: true, previous: existing };
        }
        if (existing && !ownerIsGone(existing, at)) {
          // 关键：拒绝必须**先提交**再抛错。如果在这里直接 throw，tx() 会回滚，
          // 这条「谁在什么时候被谁拒了」的审计就跟着一起消失——事后无法回答
          // 「有没有第二个 writer 试过写」。所以先把事实落库，事务结束后再抛。
          audit(sessionId, 'denied', {
            runId: existing.runId, revision: existing.revision,
            detail: { requester: writerIdentity, holder: existing.writerIdentity, leaseExpiresAtMs: existing.leaseExpiresAtMs },
          });
          return { denied: true, holder: existing };
        }

        const runId = newId('run');
        const revision = (existing?.revision ?? 0) + 1;
        const expires = at + ttl;
        if (!existing) {
          db.prepare(`INSERT INTO writer_claim(${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
            sessionId, revision, runId, writerIdentity,
            PROCESS_IDENTITY.pid, PROCESS_IDENTITY.pidStartTicks, PROCESS_IDENTITY.bootNonce,
            'active', at, at, expires,
          );
        } else {
          db.prepare(`UPDATE writer_claim SET lifecycle_revision = ?, active_writer_run_id = ?, owner_identity = ?,
            owner_pid = ?, owner_pid_start_ticks = ?, owner_nonce = ?, state = 'active',
            claimed_at_ms = ?, heartbeat_at_ms = ?, lease_expires_at_ms = ? WHERE session_id = ?`).run(
            revision, runId, writerIdentity,
            PROCESS_IDENTITY.pid, PROCESS_IDENTITY.pidStartTicks, PROCESS_IDENTITY.bootNonce,
            at, at, expires, sessionId,
          );
        }
        audit(sessionId, existing ? 'takeover' : 'claim', {
          runId, revision,
          detail: existing ? { previousRunId: existing.runId, previousRevision: existing.revision, reason: 'lease-expired-or-owner-dead' } : null,
        });
        return { sessionId, runId, revision, leaseExpiresAtMs: expires, resumed: false, previous: existing };
      });
      if (outcome && outcome.denied === true) {
        // 审计已随事务提交；此刻再抛，保证「被拒绝」是可事后核对的既成事实。
        const holder = outcome.holder;
        throw new CandidateError(ERR.WRITER_BUSY, `会话 ${sessionId} 已被其它 writer 持有`, {
          sessionId, holderRunId: holder.runId, holderIdentity: holder.writerIdentity,
          leaseExpiresAtMs: holder.leaseExpiresAtMs, revision: holder.revision,
        });
      }
      return outcome;
    },

    /** 续租。必须同 runId 同 revision 且未过期。 */
    renew({ sessionId, runId, revision, ttlMs = defaultLeaseMs }) {
      requireString(runId, 'runId');
      requireSafeInt(revision, 'revision');
      const ttl = Math.max(1000, Number(ttlMs) | 0);
      return tx(db, () => {
        const at = now();
        const claim = readClaim(sessionId);
        validateOrThrow(claim, { sessionId, runId, revision }, at);
        const expires = at + ttl;
        db.prepare('UPDATE writer_claim SET heartbeat_at_ms = ?, lease_expires_at_ms = ? WHERE session_id = ?')
          .run(at, expires, sessionId);
        return { sessionId, runId, revision, leaseExpiresAtMs: expires };
      });
    },

    /** 释放所有权。非 owner → FENCE_LOST；已无主 → 幂等返回 released:false。 */
    release({ sessionId, runId, revision }) {
      requireString(runId, 'runId');
      requireSafeInt(revision, 'revision');
      return tx(db, () => {
        const at = now();
        const claim = readClaim(sessionId);
        if (!claim || claim.state !== 'active') return { sessionId, released: false, reason: 'no-active-writer' };
        if (claim.runId !== runId || claim.revision !== revision) {
          throw new CandidateError(ERR.FENCE_LOST, `释放失败：会话 ${sessionId} 的 owner 已不是 (${runId}, rev ${revision})`, {
            sessionId, expectedRunId: runId, expectedRevision: revision,
            actualRunId: claim.runId, actualRevision: claim.revision,
          });
        }
        db.prepare(`UPDATE writer_claim SET state = 'idle', active_writer_run_id = NULL,
          owner_identity = NULL, owner_pid = NULL, owner_pid_start_ticks = NULL, owner_nonce = NULL,
          heartbeat_at_ms = ?, lease_expires_at_ms = 0 WHERE session_id = ?`).run(at, sessionId);
        audit(sessionId, 'release', { runId, revision });
        return { sessionId, released: true };
      });
    },

    /** 只读断言（每次 fresh read）。 */
    assertFence({ sessionId, runId, revision }) {
      requireString(runId, 'runId');
      requireSafeInt(revision, 'revision');
      const at = now();
      const claim = readClaim(sessionId);
      return validateOrThrow(claim, { sessionId, runId, revision }, at);
    },

    /**
     * 唯一的受控写入口：事务内 fresh read → fn → COMMIT 前复核。
     * fn 收到的 db 与外部是同一个连接；fn 里**不得**自己 COMMIT/ROLLBACK。
     */
    withFence({ sessionId, runId, revision }, fn) {
      requireString(runId, 'runId');
      requireSafeInt(revision, 'revision');
      if (typeof fn !== 'function') throw new CandidateError(ERR.INVALID_ARGUMENT, 'withFence 需要 fn');
      return tx(db, () => {
        const at = now();
        validateOrThrow(readClaim(sessionId), { sessionId, runId, revision }, at);
        const out = fn(db);
        // COMMIT 前复核：证明提交这一刻我们仍是 owner，且 fn 没有把所有权弄丢。
        const finalAt = now();
        const finalClaim = validateOrThrow(readClaim(sessionId), { sessionId, runId, revision }, finalAt);
        audit(sessionId, 'commit', { runId, revision, detail: { leaseExpiresAtMs: finalClaim.leaseExpiresAtMs } });
        return out;
      });
    },

    /** 无 fence 的写尝试统一从这里失败（集成层调用，保证没有第二条写路径）。 */
    denyUnfenced(sessionId, reason = 'unfenced-write') {
      audit(sessionId, 'unfenced-write-denied', { detail: { reason } });
      throw new CandidateError(ERR.NO_FENCE, `会话 ${sessionId} 的写入必须持有 Writer Fence`, { sessionId, reason });
    },
  };
}
