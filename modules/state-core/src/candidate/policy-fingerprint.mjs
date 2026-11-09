// socialV2 策略指纹：把「这条消息按什么权限面发出去」压成可比较的三元组。
//
// 为什么必须是 [mode, preset, owner] 三元组（GLM-DSH-READONLY-AUDIT-001 F12 / §4）：
//   旧桥的 `sessionPolicy(key)` 就是这三元组，且它有四处硬用途：
//     ① isCurrentSession —— 会话是否仍合法；
//     ② captureSendGuard —— **每条消息实际发送前的最终校验**（排队期间权限变化即弃发）；
//     ③ ensureSession —— 创建窗口期竞态丢弃；
//     ④ reconcileSessionPolicies —— 模式/preset 变更后的批量退役。
//   只比较其中一两项，就会出现「切模式后旧会话被继续复用（旧 preset 工具面 + 旧发送闸门）」，
//   或「preset 清单瞬时未知时把全部会话误退役」这两种真实事故形态。所以三项缺一不可。
//
// 本模块是纯函数：不读 DB、不读配置、不调 DSH。谁持有真相源谁负责把当前三元组传进来。

import { CandidateError, ERR } from './errors.mjs';
import { sha256Hex } from './util.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const FIELD_NAMES = Object.freeze(['mode', 'preset', 'owner']);

function requirePolicyText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是非空且首尾无空白的字符串`, { [field]: value });
  }
  return value;
}

/**
 * owner 允许三种形态：null（未配置）、非空字符串（QQ 号/角色名）、正安全整数。
 * 不做字符串化猜测之外的类型放宽：`{toString:()=>'123'}` 这种对象必须被拒绝。
 */
function requireOwner(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'owner 必须是正整数或非空字符串或 null', { owner: value });
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.trim() !== value || value.length === 0) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'owner 字符串必须是首尾无空白的非空字符串', { owner: value });
    }
    return value;
  }
  throw new CandidateError(ERR.INVALID_ARGUMENT, 'owner 必须是字符串、正整数或 null', { ownerType: typeof value });
}

/**
 * 计算 socialV2 策略指纹。
 *
 * @param {{mode:string, preset:string, owner?:string|number|null}} policy
 * @returns {{tuple: readonly [string,string,string|null], hash: string, json: string}}
 */
export function socialV2PolicyFingerprint({ mode, preset, owner } = {}) {
  const tuple = Object.freeze([
    requirePolicyText(mode, 'mode'),
    requirePolicyText(preset, 'preset'),
    requireOwner(owner),
  ]);
  const json = JSON.stringify(tuple);
  return Object.freeze({ tuple, hash: sha256Hex(json), json });
}

/**
 * 接受「指纹对象」或「原始三元组」两种输入，统一归一成指纹对象。
 * 明确区分类型：字符串/数组/缺字段都直接报错，不允许静默补默认值。
 */
function normalizeFingerprint(input, label) {
  if (!isPlainObject(input)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${label} 必须是策略指纹对象或 {mode,preset,owner}`);
  }
  if (Array.isArray(input.tuple)) {
    if (input.tuple.length !== 3) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, `${label}.tuple 必须是长度 3 的数组（[mode,preset,owner]）`);
    }
    return socialV2PolicyFingerprint({ mode: input.tuple[0], preset: input.tuple[1], owner: input.tuple[2] });
  }
  if (!('mode' in input) || !('preset' in input)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${label} 缺少 mode/preset（owner 可为 null）`);
  }
  return socialV2PolicyFingerprint({ mode: input.mode, preset: input.preset, owner: input.owner });
}

const display = (value) => (value === null ? 'null' : JSON.stringify(value));

/**
 * 比较前后两份策略指纹。
 *
 * @returns {{changed:boolean, reasons:string[]}} 逐字段给出原因（不是笼统的「变了」）
 */
export function assertPolicyUnchanged(before, after) {
  const a = normalizeFingerprint(before, 'before');
  const b = normalizeFingerprint(after, 'after');
  const reasons = [];
  for (let i = 0; i < FIELD_NAMES.length; i += 1) {
    if (a.tuple[i] !== b.tuple[i]) {
      reasons.push(`${FIELD_NAMES[i]} 变化：${display(a.tuple[i])} → ${display(b.tuple[i])}`);
    }
  }
  return Object.freeze({ changed: reasons.length > 0, reasons: Object.freeze(reasons) });
}

function normalizeAllowlist(allowlist) {
  if (allowlist instanceof Set) {
    for (const item of allowlist) {
      if (typeof item !== 'string' || item === '') {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'allowlist 里只能是非空字符串 sessionId');
      }
    }
    return new Set(allowlist);
  }
  if (Array.isArray(allowlist)) {
    for (const item of allowlist) {
      if (typeof item !== 'string' || item === '') {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'allowlist 里只能是非空字符串 sessionId');
      }
    }
    return new Set(allowlist);
  }
  throw new CandidateError(ERR.INVALID_ARGUMENT, 'allowlist 必须是数组或 Set');
}

/**
 * 发送前最终校验（等价于旧桥 captureSendGuard 的语义）。
 *
 * 两个条件必须同时满足，缺一即拒绝：
 *   1. 会话仍在 allowlist 内（排队期间权限被收回 ⇒ 弃发）；
 *   2. 与入队时记录的策略指纹一致（模式/preset/owner 任一变化 ⇒ 弃发）。
 *
 * 注意：这是「拒绝发送」的判定函数，不是「发送」函数；它不产生任何副作用。
 * 参数不合法时抛错而不是返回 allowed=false——配置写错和权限变化是两类问题，
 * 前者必须让调用方在开发期就看到。
 *
 * @param {object} args
 * @param {object} args.policyBefore 入队时记录的策略指纹（或 {mode,preset,owner}）
 * @param {object} args.policyNow 发送前的当前策略指纹（或 {mode,preset,owner}）
 * @param {string} args.sessionId
 * @param {string[]|Set<string>} args.allowlist 当前允许发送的 sessionId 集合
 * @returns {{allowed:boolean, reasons:string[], sessionId:string, policy:{before:string, now:string}}}
 */
export function captureSendGuard({ policyBefore, policyNow, sessionId, allowlist } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'captureSendGuard.sessionId 必须是非空字符串');
  }
  const before = normalizeFingerprint(policyBefore, 'policyBefore');
  const nowPolicy = normalizeFingerprint(policyNow, 'policyNow');
  const allowedIds = normalizeAllowlist(allowlist);

  const reasons = [];
  if (!allowedIds.has(sessionId)) {
    reasons.push(`会话 ${sessionId} 不在发送 allowlist 中`);
  }
  const diff = assertPolicyUnchanged(before, nowPolicy);
  if (diff.changed) {
    reasons.push(`socialV2 策略指纹已变化：${diff.reasons.join('；')}`);
  }
  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    sessionId,
    policy: Object.freeze({ before: before.hash, now: nowPolicy.hash }),
  });
}
