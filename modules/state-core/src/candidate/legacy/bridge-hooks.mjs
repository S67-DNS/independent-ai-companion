// 旧桥接线钩子（OPENCORE-CONSTRUCTION-002 / 任务 A）。
//
// 目标：让桥接的**真实**权威写入与消息发送路径经过已经验证过的三个机制，
// 而不是在旁边再跑一套。做法只有两类，均为最小侵入：
//
//   1. 权威文件写入：`writeRoleContent` / 日记写入 / socialV2 状态落盘
//      → legacyAuthorityWrite()：Writer Fence 互斥 + Memory Provenance CAS。
//   2. 出站文本发送：/api/test-send、sendToQQ、sendBurstToQQ、onebotSend
//      → legacyDeliver()：持久 Delivery Outbox + send_started 分界线 + unknown 语义。
//
// 开关：`OPENCORE_CANDIDATE_BRIDGE=1` 才启用。
//   * 关闭时：**完全保持旧行为**（直接调用传入的 send thunk / 原子写文件）。
//   * 开启时：机制失败 = 抛错（fail-closed），绝不静默退回旁路。
//     否则「接上了」和「没接上」在故障时看起来会一模一样。
//
// 隔离：默认数据目录是本仓库 `data/`；可用 OPENCORE_CANDIDATE_DATA 指向别处。
// 本模块绝不读写 `~/.dsh`，不发 QQ（QQ 发送仍由调用方传入的 thunk 完成），
// 也不持有任何凭据。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openDb } from '../db.mjs';
import { createWriterFence } from '../writer-fence.mjs';
import { createSessionWriter } from '../session-write-gate.mjs';
import { createMemoryStore, TRUST } from '../memory-provenance.mjs';
import { createOutbox, DELIVERY_STATE } from '../delivery-outbox.mjs';
import { createIdentity } from '../identity.mjs';
import { nowMs, relPosix, ensureDir, randomHex } from '../util.mjs';
import { CandidateError, ERR } from '../errors.mjs';

const REPO_ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
const PROCESS_STARTED_AT = Date.now();

/** 权威记忆面：只登记这三类文件；其它文件一律不进入 provenance。 */
export const AUTHORITY_KINDS = Object.freeze({
  role: 'role',
  diary: 'diary',
  'social-v2': 'social-v2',
});

let runtime = null;
let initError = null;
let drained = false;

const log = (...args) => {
  try { process.stderr.write(`[candidate-bridge] ${args.join(' ')}\n`); } catch { /* ignore */ }
};

export function isBridgeHookEnabled() {
  const flag = String(process.env.OPENCORE_CANDIDATE_BRIDGE ?? '').trim();
  return flag === '1' || flag === 'true';
}

function dataDir() {
  return path.resolve(process.env.OPENCORE_CANDIDATE_DATA || path.join(REPO_ROOT, 'data'));
}

/**
 * 惰性初始化。失败时**缓存错误**：第一次失败之后每次调用都抛同一个错，
 * 避免「第一次失败退回旧路径、之后又偷偷成功」这种半接线状态。
 */
function getRuntime() {
  if (initError) throw initError;
  if (runtime) return runtime;
  try {
    const data = ensureDir(dataDir());
    const dbPath = path.join(data, 'bridge-legacy.db');
    const db = openDb(dbPath, { busyTimeoutMs: 8000 });
    const fence = createWriterFence({ db, defaultLeaseMs: 30_000 });
    const writer = createSessionWriter({ db, fence });
    const memory = createMemoryStore({ root: REPO_ROOT, db });
    const outbox = createOutbox({ db, leaseMs: 60_000 });
    const identity = createIdentity({ root: REPO_ROOT });
    runtime = { db, fence, writer, memory, outbox, identity, dbPath, root: REPO_ROOT, data };
    log(`enabled db=${dbPath}`);
    return runtime;
  } catch (error) {
    initError = error instanceof CandidateError
      ? error
      : new CandidateError(ERR.INTERNAL, `接线钩子初始化失败：${error?.message ?? error}`, { cause: String(error?.stack ?? '') });
    throw initError;
  }
}

/** 处理「上一个进程留下的 pending 投递」：它们不该在重启后被补发。 */
async function drainStalePending(rt) {
  if (drained) return;
  drained = true;
  let rounds = 0;
  for (;;) {
    rounds += 1;
    if (rounds > 100) break;
    const claimed = rt.outbox.claim({ limit: 25, leaseMs: 10_000 });
    if (!claimed.length) break;
    for (const item of claimed) {
      const rec = rt.outbox.get(item.deliveryId);
      const createdAt = Number(rec?.createdAtMs ?? 0);
      if (createdAt >= PROCESS_STARTED_AT) {
        // 理论上不会发生（本进程刚启动就开始消费自己的新消息）；保守起见放回 pending。
        rt.outbox.fail({ attemptId: item.attemptId, error: 'unexpected-in-flight-at-startup', retryable: false });
        log(`启动扫描发现本进程创建的在途投递 ${item.deliveryId}，已终止（需人工核对）`);
        continue;
      }
      // 上个进程的遗留：没有发送 thunk 可重放，补发陈旧回复是错的。
      rt.outbox.fail({ attemptId: item.attemptId, error: 'stale-pending-from-previous-process', retryable: false });
      log(`陈旧 pending 投递已终止（不会补发）：${item.deliveryId}`);
    }
  }
}

function authorityWriterIdentity(kind) {
  // 注意：provenance 只认 `authority` 这一个授权身份（isAuthorityWriter 是严格相等）。
  // 人类可读的“谁写的”（bridge:CORE_ENTITY）放在 fence 审计里，不混进 provenance 身份。
  void kind;
  return 'authority';
}

/** 与 provenance 的 hash 口径保持一致（sha256 of UTF-8 bytes）。 */
function sha256Of(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

/**
 * 权威文件写入（同步）。
 *
 * @returns {boolean} true = 已由本钩子处理；false = 钩子关闭，调用方应走原路径。
 * @throws 钩子开启且机制失败时抛出（fail-closed，不退回原子写）。
 */
export function legacyAuthorityWrite({ absPath, content, kind = 'role' } = {}) {
  if (!isBridgeHookEnabled()) return false;
  if (typeof absPath !== 'string' || typeof content !== 'string') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'legacyAuthorityWrite 需要 absPath 与 string content');
  }
  const rt = getRuntime();
  const rel = relPosix(rt.root, path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `权威写入路径越界：${absPath}`);
  }

  const sessionId = 'authority:local';
  const writerIdentity = authorityWriterIdentity(kind);
  const auditIdentity = `bridge:${kind}`;
  const claim = rt.fence.claim({ sessionId, writerIdentity: auditIdentity, ttlMs: 30_000 });
  try {
    ensureDir(path.dirname(path.resolve(absPath)));
    let verdict = null;
    try { verdict = rt.memory.verify(rel); } catch (error) { if (error?.code !== ERR.NOT_FOUND) throw error; }

    if (!verdict || verdict.registered === false) {
      // 首次登记：文件可能还不存在（例如新的一天日记）。先落盘再登记，
      // 并把这一步作为 adopt 记审计 —— 没有旧内容可 CAS，谈不上绕过。
      if (!fs.existsSync(path.resolve(absPath))) fs.writeFileSync(path.resolve(absPath), content, { encoding: 'utf8', mode: 0o600 });
      rt.memory.adopt({ relPath: rel, writerIdentity, trust: TRUST.AUTHORITY });
      // adopt 记录的是「当时磁盘上的内容」；若调用方要写的内容与之不同，再走一次 CAS。
      const snap = rt.memory.verify(rel);
      if (snap.hash !== sha256Of(content)) {
        const res = rt.memory.reserve({ relPath: rel, writerIdentity });
        rt.memory.write({ relPath: rel, content, writerIdentity, reservationId: res.reservationId, expectedHash: res.expectedHash });
      }
      return true;
    }

    if (verdict.trust === TRUST.DRIFT || verdict.externalChange === true) {
      throw new CandidateError(ERR.MEMORY_DRIFT, `权威文件已被外部修改，拒绝覆盖：${rel}`, { relPath: rel });
    }
    if (verdict.hash === sha256Of(content)) {
      // 内容没变：不制造新 generation，也不写盘（避免无谓的 inode 抖动）。
      return true;
    }
    const reservation = rt.memory.reserve({ relPath: rel, writerIdentity });
    rt.memory.write({
      relPath: rel, content, writerIdentity,
      reservationId: reservation.reservationId,
      expectedHash: reservation.expectedHash,
    });
    return true;
  } finally {
    try { rt.fence.release({ sessionId, runId: claim.runId, revision: claim.revision }); } catch (error) {
      log(`释放 authority fence 失败：${error?.message ?? error}`);
    }
  }
}

/**
 * QQ 文本发送接线。
 *
 * `send` 是调用方给的 thunk，**原样执行旧的低层发送**；本函数只负责在它前后
 * 加上持久化与判定。返回值：
 *   { handled:false }                 → 钩子关闭，调用方自己发（行为与旧版完全一致）
 *   { handled:true, result }          → 已发送并 ack
 *   { handled:true, result:null, state:'unknown' } → 已开始发送但结果不可知
 */
export async function legacyDeliver({ key, kind, id, text: textBody, send, meta = null } = {}) {
  if (!isBridgeHookEnabled()) {
    const result = await send();
    return { handled: false, result, state: 'direct' };
  }
  if (typeof send !== 'function') throw new CandidateError(ERR.INVALID_ARGUMENT, 'legacyDeliver 需要 send thunk');
  const rt = getRuntime();
  await drainStalePending(rt);

  const enq = rt.outbox.enqueue({
    channel: 'qq',
    target: String(key ?? `${kind}:${id}`),
    sessionId: null,
    idempotencyKey: null,
    idempotent: false,
    reconcileSupport: 'none',
    payload: {
      text: String(textBody ?? '').slice(0, 4000),
      kind, id: String(id ?? ''),
      meta: meta ?? null,
      at: nowMs(),
    },
  });

  // claim 到别的投递时先放回 pending（不终止别人的消息），直到拿到自己这条。
  // 启动时已清空陈旧 pending，正常情况下这里只有自己一条。
  let item = null;
  for (let i = 0; i < 8 && !item; i += 1) {
    const batch = rt.outbox.claim({ limit: 50, leaseMs: 60_000 });
    if (!batch.length) break;
    const others = [];
    for (const candidate of batch) {
      if (candidate.deliveryId === enq.deliveryId) item = candidate;
      else others.push(candidate);
    }
    for (const other of others) {
      // 放回队列，不吞掉别人的消息；它自己的调用方会在下一轮 claim 到它。
      try { rt.outbox.fail({ attemptId: other.attemptId, error: 'requeue-not-mine', retryable: true }); } catch { /* ignore */ }
    }
  }
  if (!item) {
    throw new CandidateError(ERR.INTERNAL, `投递 ${enq.deliveryId} 未能被本进程领取`, { deliveryId: enq.deliveryId });
  }

  rt.outbox.markSendStarted({ attemptId: item.attemptId });
  try {
    const result = await send();
    rt.outbox.recordPartReceipt({ attemptId: item.attemptId, partNo: 1, ok: true, receipt: extractMessageId(result) });
    rt.outbox.ack({ attemptId: item.attemptId, receipt: extractMessageId(result) });
    return { handled: true, result, state: DELIVERY_STATE.SENT, deliveryId: enq.deliveryId };
  } catch (error) {
    // 发送已经开始：结果不可知（可能超时后成功，也可能真的失败）。
    // 语义上只能记 unknown —— 绝不自动重发同一条 QQ 消息。
    try {
      rt.outbox.recordPartReceipt({ attemptId: item.attemptId, partNo: 1, ok: false, receipt: String(error?.message ?? error).slice(0, 300) });
      rt.outbox.markUnknownAfterSend({ attemptId: item.attemptId, reason: String(error?.message ?? error) });
    } catch (inner) {
      log(`记录 unknown 失败：${inner?.message ?? inner}`);
    }
    log(`发送未知（已记 unknown_after_send，不重发）：${key} :: ${error?.message ?? error}`);
    // 仍然把错误抛回调用方：旧桥的 catch 要照旧记 lastSendFailed / 打日志，
    // 只是数据库里多了一条「unknown」的事实。不能因为接了 Outbox 就吞掉失败。
    throw error;
  }
}

function extractMessageId(result) {
  if (result && typeof result === 'object') {
    const mid = result.message_id ?? result.messageId ?? result.data?.message_id;
    if (mid !== undefined && mid !== null) return { message_id: String(mid) };
  }
  return null;
}

/** 启动恢复：把上一个进程遗留的在途投递收口。 */
export async function legacyRecover() {
  if (!isBridgeHookEnabled()) return { enabled: false };
  const rt = getRuntime();
  await drainStalePending(rt);
  const memory = rt.memory.reconcile();
  const orphans = await rt.outbox.recoverOrphans();
  const expired = await rt.outbox.expireLeases();
  const unresolved = rt.outbox.list({ state: DELIVERY_STATE.UNKNOWN_AFTER_SEND, limit: 200 })
    .map((d) => ({ deliveryId: d.deliveryId, target: d.target, attempts: d.attemptCount }));
  log(`recover memory.drifted=${memory.drifted?.length ?? 0} orphans=${orphans?.length ?? 0} unknown=${unresolved.length}`);
  return { enabled: true, memory, orphans, expired, unresolved };
}

// ── P1-2：Desktop 第二写入者检测 ────────────────────────────────────────────
//
// DSH 没有写入者 lease，Desktop UI 与PROJECT_NAME可以同时往同一个 Session 写。
// 能做的不是「阻止 UI」（做不到），而是：
//   1. PROJECT_NAME的每个 prompt 都带一个自己铸的 requestId（DSH 持久化成 source.rpcId）；
//   2. 事件流里出现不认识的 rpcId ⇒ 存在第二写入者；
//   3. 该 Session 立刻进入 foreign-writer 状态，PROJECT_NAME**停止发起新 prompt**，并写审计；
//   4. 人工核对后用 clear 接口解除（可识别、可恢复）。
// 这条边界是**检测 + 自停**，不是全局写锁 —— 报告里必须这么写，不能含糊。

/** 铸一个属于PROJECT_NAME的 requestId（与 DSH 的 user/message.source.rpcId 一一对应）。 */
export function legacyMintRequest({ sessionId = null } = {}) {
  const id = `in:qq--${randomHex(12)}`;
  if (isBridgeHookEnabled()) {
    try {
      const rt = getRuntime();
      rt.db.prepare('INSERT OR IGNORE INTO own_request(request_id, session_id, at_ms) VALUES (?,?,?)')
        .run(id, sessionId, nowMs());
    } catch (error) { log(`记录自有 requestId 失败：${error?.message ?? error}`); }
  }
  return id;
}

/**
 * 登记一个「已经存在的」requestId（本地窗口 / runtime adapter 自铸的 id）。
 *
 * 为什么需要它（CONSTRUCTION-005 / Kimi D-02）：旧实现按前缀信任
 * `in:local--` 和未登记的 `in:qq--`，任何人都能伪造前缀绕过 foreign-writer。
 * 新语义：**只有本进程登记在 own_request 里的 id 才算自有写入**；
 * 本地窗口和 runtime 自铸的 id 必须显式登记，否则 observer 会把它们判成外部写入。
 */
export function legacyRegisterRequest({ rpcId, sessionId = null, source = 'local' } = {}) {
  if (!isBridgeHookEnabled()) return { enabled: false };
  if (typeof rpcId !== 'string' || rpcId.length === 0) {
    return { enabled: true, registered: false, reason: 'empty-rpc-id' };
  }
  try {
    const rt = getRuntime();
    const at = nowMs();
    rt.db.prepare('INSERT OR IGNORE INTO own_request(request_id, session_id, at_ms) VALUES (?,?,?)')
      .run(rpcId, sessionId, at);
    rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
      .run(at, sessionId, 'own-registered', rpcId, `source=${source}`);
    return { enabled: true, registered: true };
  } catch (error) {
    log(`登记自有 requestId 失败：${error?.message ?? error}`);
    return { enabled: true, registered: false, error: String(error?.message ?? error) };
  }
}

// 严格身份：只接受 own_request 中登记且 session 匹配的 id。
// 空 rpcId、伪造前缀、未登记 id 一律不是「自有」。（Kimi D-02）
function isOwnRpcId(rt, rpcId, sessionId) {
  if (typeof rpcId !== 'string' || rpcId.length === 0) return false;
  const row = rt.db.prepare('SELECT session_id FROM own_request WHERE request_id = ?').get(rpcId);
  if (!row) return false;
  // session_id 为空表示「铸的时候还没绑定会话」：只有在同一进程内登记过才可信，
  // 这里仍要求具体会话匹配，避免跨会话复用 id。
  return row.session_id === sessionId;
}

function markForeign(rt, sessionId, rpcId, detail) {
  const at = nowMs();
  rt.db.prepare(`INSERT INTO session_guard(session_id, state, foreign_rpc_id, foreign_count, at_ms, detail)
    VALUES (?, 'foreign-writer', ?, 1, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET state = 'foreign-writer',
      foreign_rpc_id = excluded.foreign_rpc_id,
      foreign_count = session_guard.foreign_count + 1,
      at_ms = excluded.at_ms,
      detail = excluded.detail`)
    .run(sessionId, rpcId, at, detail);
  rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
    .run(at, sessionId, 'foreign-detected', rpcId, detail);
}

/** 观察一条 user/message 的 rpcId，判断是否来自第二写入者。 */
export function legacyObserveRpc({ sessionId, rpcId = null, sourceKind = null, source = 'event' } = {}) {
  if (!isBridgeHookEnabled()) return { enabled: false };
  if (typeof sessionId !== 'string' || !sessionId) return { enabled: true, ignored: 'no-session' };
  // 只有「人写的」user/message 才算写入者候选。time-context 等系统注入的
  // user/message 由 DSH 自己生成（带服务端 UUID），把它们当第二写入者会误报。
  if (sourceKind && sourceKind !== 'user') return { enabled: true, foreign: false, ignored: 'system-injected', sourceKind };
  const rt = getRuntime();
  const at = nowMs();
  if (isOwnRpcId(rt, rpcId, sessionId)) {
    rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
      .run(at, sessionId, 'own-request', rpcId, `source=${source}`);
    return { enabled: true, foreign: false, rpcId };
  }
  const reason = (typeof rpcId !== 'string' || rpcId.length === 0)
    ? 'missing-rpc-id'
    : 'unregistered-rpc-id';
  markForeign(rt, sessionId, rpcId, `source=${source} reason=${reason} rpcId=${rpcId ?? '(null)'}`);
  log(`检测到第二写入者：session=${sessionId} rpcId=${rpcId ?? '(null)'} reason=${reason} → foreign-writer`);
  return { enabled: true, foreign: true, rpcId, reason };
}

/** 观察失败：不能保持 clear，必须让该 Session 进入 unknown（后续权威写入被阻断）。 */
export function legacyMarkObserverFailure({ sessionId, reason = 'observer-error' } = {}) {
  if (!isBridgeHookEnabled()) return { enabled: false };
  if (typeof sessionId !== 'string' || !sessionId) return { enabled: true, ignored: 'no-session' };
  const rt = getRuntime();
  const at = nowMs();
  rt.db.prepare(`INSERT INTO session_guard(session_id, state, foreign_rpc_id, foreign_count, at_ms, detail)
    VALUES (?, 'unknown', NULL, 0, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET state = 'unknown', at_ms = excluded.at_ms, detail = excluded.detail`)
    .run(sessionId, at, String(reason));
  rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
    .run(at, sessionId, 'observer-error', null, String(reason));
  log(`[candidate] observer 失败，会话进入 unknown（拒绝后续权威写入）：session=${sessionId} reason=${reason}`);
  return { enabled: true, sessionId, state: 'unknown' };
}

/**
 * 扫描一份 session/snapshot 的 records，把历史 user/message 里的外部写入也识别出来。
 * 桥接离线期间 Desktop UI 的写入只会出现在重连快照里（Kimi D-02 的漏检点）。
 */
export function legacyScanSnapshot({ sessionId, records = [], source = 'snapshot' } = {}) {
  if (!isBridgeHookEnabled()) return { enabled: false };
  if (typeof sessionId !== 'string' || !sessionId) return { enabled: true, ignored: 'no-session' };
  if (!Array.isArray(records) || records.length === 0) return { enabled: true, scanned: 0, foreign: 0 };
  let scanned = 0;
  let foreign = 0;
  for (const entry of records) {
    const event = entry?.type === 'event' ? entry.event : entry;
    if (event?.type !== 'user/message') continue;
    const src = event?.data?.source ?? {};
    if (src.kind !== 'user') continue;
    scanned += 1;
    const result = legacyObserveRpc({ sessionId, rpcId: src.rpcId ?? null, sourceKind: src.kind, source });
    if (result.foreign) foreign += 1;
  }
  const rt = getRuntime();
  rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
    .run(nowMs(), sessionId, 'snapshot-scan', null, `scanned=${scanned} foreign=${foreign}`);
  return { enabled: true, scanned, foreign };
}

/** 当前 Session 是否被检测到存在第二写入者 / 观察失败。 */
export function legacyWriteBlocked(sessionId) {
  if (!isBridgeHookEnabled() || !sessionId) return false;
  const rt = getRuntime();
  const row = rt.db.prepare('SELECT state FROM session_guard WHERE session_id = ?').get(sessionId);
  return row?.state === 'foreign-writer' || row?.state === 'unknown';
}

/** PROJECT_NAME准备写这个 Session 时的 fail-closed 断言。 */
export function legacyAssertWritable(sessionId) {
  if (!isBridgeHookEnabled() || !sessionId) return;
  const rt = getRuntime();
  const row = rt.db.prepare('SELECT state, foreign_rpc_id, at_ms, detail FROM session_guard WHERE session_id = ?').get(sessionId);
  if (!row || (row.state !== 'foreign-writer' && row.state !== 'unknown')) return;
  rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
    .run(nowMs(), sessionId, 'assert-blocked', row.foreign_rpc_id ?? null, `state=${row.state} detail=${row.detail ?? ''}`);
  throw new CandidateError(ERR.BLOCKED, `会话 ${sessionId} 写入被阻断（state=${row.state}）：${row.state === 'unknown' ? 'observer 无法确认写入者身份' : '检测到第二写入者'}；需人工核对后用 clear-write-block 解除`, {
    sessionId, state: row.state, foreignRpcId: row.foreign_rpc_id ?? null, detectedAtMs: row.at_ms,
  });
}

/** 人工解除：确认 Desktop UI 已停止/已核对后调用。 */
export function legacyClearWriteBlock({ sessionId, operator = 'unknown' } = {}) {
  if (!isBridgeHookEnabled()) return { enabled: false };
  const rt = getRuntime();
  const at = nowMs();
  rt.db.prepare(`INSERT INTO session_guard(session_id, state, foreign_rpc_id, foreign_count, at_ms, cleared_at_ms, detail)
    VALUES (?, 'clear', NULL, 0, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET state = 'clear', cleared_at_ms = excluded.cleared_at_ms, detail = excluded.detail`)
    .run(sessionId, at, at, `cleared by ${operator}`);
  rt.db.prepare('INSERT INTO guard_audit(at_ms, session_id, kind, rpc_id, detail) VALUES (?,?,?,?,?)')
    .run(at, sessionId, 'clear', null, `operator=${operator}`);
  return { enabled: true, sessionId, state: 'clear' };
}

/** 诊断（控制台/测试用）。 */
export function legacyStatus() {
  if (!isBridgeHookEnabled()) return { enabled: false };
  const rt = getRuntime();
  // drift / untrusted 条目不会出现在可注入清单里，但必须在状态面板里可见 ——
  // 否则「有一条记忆被外部改过、已经被拦下」在运行期是静默的。
  const drifted = rt.db.prepare("SELECT path, trust, generation FROM memory_registry WHERE trust IN ('drift','untrusted') ORDER BY path")
    .all().map((r) => ({ relPath: String(r.path), trust: String(r.trust), generation: Number(r.generation) }));
  const deliveries = rt.outbox.list({ limit: 30 });
  return {
    enabled: true,
    dbPath: rt.dbPath,
    root: rt.root,
    memory: rt.memory.listForInjection().map((m) => ({ relPath: m.relPath, generation: m.generation, trust: m.trust, hash: String(m.hash).slice(0, 12) })),
    drifted,
    deliveryCounts: deliveries.reduce((acc, d) => { acc[d.state] = (acc[d.state] ?? 0) + 1; return acc; }, {}),
    deliveries: deliveries.map((d) => ({ deliveryId: d.deliveryId, target: d.target, state: d.state, attempts: d.attemptCount })),
    fences: rt.fence.audit('authority:local', 20),
    guard: {
      foreign: rt.db.prepare("SELECT session_id, state, foreign_rpc_id, foreign_count, at_ms, detail FROM session_guard WHERE state IN ('foreign-writer','unknown')").all(),
      recent: rt.db.prepare('SELECT at_ms, session_id, kind, rpc_id FROM guard_audit ORDER BY id DESC LIMIT 20').all(),
    },
  };
}
