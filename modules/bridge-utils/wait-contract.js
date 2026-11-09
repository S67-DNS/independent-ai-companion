// Wait 契约：桥接端「实际生效预算」与 MCP 客户端「等待预算」的唯一计算来源。
//
// 背景（GLM-READONLY-AUDIT-ACCEPTANCE-001-A-FOLLOWUP §3.3-3.5）：
//   - 桥接对 purpose=messages 会把请求预算静默抬到 `socialV2.wait.idleFloorMs`（默认 180000）；
//   - MCP 客户端却按**原始** timeoutMs 计算自己的长轮询预算（10s → 40s），
//     导致客户端先断、桥接仍在等，模型收到「等待超时（40s）」并重试，烧 token。
//   - 修复口径：桥接在响应/预检里回传 `effectiveTimeoutMs`，MCP 客户端用它算预算。
//
// 该模块不依赖 fs/http，只做纯计算，便于单元测试；bridge.js 与 mcp-snowluma-safe.js 共用。

export const WAIT_DEFAULTS = Object.freeze({
  defaultMs: 30_000,
  minMs: 5_000,
  maxMs: 600_000,
  idleFloorMs: 180_000,
  minQuietAfterNewMs: 10_000,
  maxQuietCapMs: 120_000,
  maxClientBudgetMs: 725_000
});

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 计算一次 wait 请求在桥接端实际采用的参数。
 *
 * 返回字段：
 *  - requestedMs         调用方请求的预算（已 clamp 到 minMs/maxMs）
 *  - effectiveTimeoutMs  桥接实际等新消息的预算（messages 用途会抬到 idleFloorMs）
 *  - timeoutMs           effectiveTimeoutMs 的别名（保持既有调用点可读）
 *  - quietMs / maxQuietMs / minQuietAfterNewMs
 *  - maxTotalMs          桥接 handler 可能占用的最大墙钟（预算 + 到达后静默窗口 + 5s 兜底）
 *  - countsAsObservation 本次等待是否可能构成沉睡前观察（仅 messages 且预算 >= preSleepWaitMs）
 */
export function computeWaitPlan({ body = {}, waitCfg = {}, suggestedQuietMs = null, preSleepWaitMs = 300_000 } = {}) {
  const replyWait = body.purpose === 'reply';
  const cfg = { ...WAIT_DEFAULTS, ...(waitCfg ?? {}) };

  const defaultMs = finiteNumber(cfg.defaultMs) ?? WAIT_DEFAULTS.defaultMs;
  const minMs = Math.max(100, finiteNumber(cfg.minMs) ?? WAIT_DEFAULTS.minMs);
  const maxMs = Math.max(minMs, finiteNumber(cfg.maxMs) ?? WAIT_DEFAULTS.maxMs);
  const requestedRaw = Number(body.timeoutMs) || defaultMs;
  const requestedMs = clamp(Math.round(requestedRaw), minMs, maxMs);

  // 0 表示关闭下限（测试/调试用）；缺省才回落到 180s。
  const rawIdleFloor = finiteNumber(cfg.idleFloorMs);
  const idleFloorMs = rawIdleFloor != null && rawIdleFloor >= 0 ? rawIdleFloor : WAIT_DEFAULTS.idleFloorMs;
  const timeoutMs = replyWait ? requestedMs : Math.min(maxMs, Math.max(idleFloorMs, requestedMs));

  const rawMinQuiet = finiteNumber(cfg.minQuietAfterNewMs);
  const minQuietAfterNewMs = rawMinQuiet != null ? Math.max(0, rawMinQuiet) : WAIT_DEFAULTS.minQuietAfterNewMs;
  const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(WAIT_DEFAULTS.maxQuietCapMs, maxMs));
  const baseQuiet = finiteNumber(body.quietMs);
  const quietSource = baseQuiet != null
    ? baseQuiet
    : (finiteNumber(suggestedQuietMs) != null ? finiteNumber(suggestedQuietMs) : minQuietAfterNewMs);
  const quietMs = clamp(Math.round(quietSource) || 0, minQuietAfterNewMs, maxQuietMs);

  const minNewMessages = Math.max(1, Math.round(finiteNumber(body.minNewMessages) || 1));
  const maxTotalMs = timeoutMs + (replyWait ? 0 : maxQuietMs) + 5_000;

  return {
    replyWait,
    requestedMs,
    effectiveTimeoutMs: timeoutMs,
    timeoutMs,
    idleFloorMs,
    minMs,
    maxMs,
    minQuietAfterNewMs,
    maxQuietMs,
    quietMs,
    minNewMessages,
    maxTotalMs,
    countsAsObservation: !replyWait && timeoutMs >= preSleepWaitMs
  };
}

/**
 * MCP 客户端长轮询预算：必须覆盖桥接的 effectiveTimeoutMs + 到达后静默窗口 + 传输余量。
 * 上限 725s（与既有实现一致，避免无限挂起）。
 */
export function computeWaitClientBudget(plan = {}, { maxBudgetMs = WAIT_DEFAULTS.maxClientBudgetMs } = {}) {
  const effective = finiteNumber(plan.effectiveTimeoutMs);
  if (effective == null || effective <= 0) return null;
  const maxQuiet = finiteNumber(plan.maxQuietMs);
  const quietBudget = maxQuiet == null ? 0 : Math.min(maxQuiet, 120_000);
  const budget = effective + quietBudget + 10_000;
  return Math.max(1_000, Math.min(maxBudgetMs, budget));
}
