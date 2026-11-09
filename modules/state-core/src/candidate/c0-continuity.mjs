// C0 连续性准备：只读地描述 / 校验一个权威 Session 的「身份 + 内容」快照。
//
// 为什么要有这一层：C0（CORE_ENTITY的核心主体 Session）在迁移期**只读**。PROJECT_NAME不能创建、改名、归档或
// 恢复任何 Session，也不能写 profile patch；它能做的只有「在动手前后各取一次只读描述符，
// 证明还是同一个 Session、同一个 workspace/cwd、同一个 preset 内容」。
//   - sessionId 只落 fp8：完整 ID 是敏感标识，日志/报告里不出现；
//   - presetFingerprint 用 preset-registry 的内容指纹（preset ID 连续 ≠ 内容连续）；
//   - eventChainHeadSeq / eventCount / createdAtMs 用来识别「同 ID 重建」这种最隐蔽的漂移。
//
// 本模块是**只读**的：只 readFileSync 一个 JSON manifest，不碰 DB、不碰 DSH、不写任何文件。
// 显式禁止（对应 GLM-DSH-READONLY-AUDIT-001 §1）：sessions.create / agentPresets.* 写 /
// ensureChatModel / 改 profile patch。这些能力在本文件里根本不存在。

import fs from 'node:fs';
import path from 'node:path';
import { CandidateError, ERR } from './errors.mjs';
import { sha256Hex } from './util.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const requireText = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CandidateError(ERR.CONTRACT, `C0 manifest 的 ${field} 必须是非空字符串`, { field });
  }
  return value;
};

const requireNonNegativeInt = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CandidateError(ERR.CONTRACT, `C0 manifest 的 ${field} 必须是非负安全整数`, { field, value: value ?? null });
  }
  return value;
};

/** 校验并归一一份 C0 manifest。任何字段缺失/类型不对都必须显式失败（fail closed）。 */
function normalizeManifest(manifest, label = 'C0 manifest') {
  if (!isPlainObject(manifest)) {
    throw new CandidateError(ERR.CONTRACT, `${label} 必须是 JSON 对象`);
  }
  return Object.freeze({
    sessionId: requireText(manifest.sessionId, 'sessionId'),
    workspace: requireText(manifest.workspace, 'workspace'),
    cwd: requireText(manifest.cwd, 'cwd'),
    presetId: requireText(manifest.presetId, 'presetId'),
    presetFingerprint: requireText(manifest.presetFingerprint, 'presetFingerprint'),
    eventChainHeadSeq: requireNonNegativeInt(manifest.eventChainHeadSeq, 'eventChainHeadSeq'),
    eventCount: requireNonNegativeInt(manifest.eventCount, 'eventCount'),
    createdAtMs: requireNonNegativeInt(manifest.createdAtMs, 'createdAtMs'),
  });
}

/**
 * 读取只读 manifest，返回脱敏描述符。
 *
 * manifest 形状（合成 fixture / 只读导出均可）：
 *   { sessionId, workspace, cwd, presetId, presetFingerprint,
 *     eventChainHeadSeq, eventCount, createdAtMs }
 *
 * @param {{manifestFile:string}} args
 * @returns {{sessionIdFp8:string, workspace:string, cwd:string, presetId:string, presetFingerprint:string, eventChainHeadSeq:number, eventCount:number, createdAtMs:number}}
 */
export function describeC0({ manifestFile } = {}) {
  if (typeof manifestFile !== 'string' || manifestFile.trim() === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'describeC0.manifestFile 必须是非空字符串');
  }
  const absPath = path.resolve(manifestFile);
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new CandidateError(ERR.NOT_FOUND, `C0 manifest 不存在：${absPath}`, { manifestFile: absPath });
    }
    throw new CandidateError(ERR.UPSTREAM, `读取 C0 manifest 失败：${absPath}`, {
      manifestFile: absPath,
      cause: String(error?.message ?? error),
    });
  }
  let raw;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (error) {
    throw new CandidateError(ERR.CONTRACT, `C0 manifest 不是合法 JSON：${absPath}`, {
      manifestFile: absPath,
      cause: String(error?.message ?? error),
    });
  }
  const manifest = normalizeManifest(raw);
  // 只暴露 fp8：完整 sessionId 不进入描述符，就不可能被误写进报告/日志。
  return Object.freeze({
    sessionIdFp8: sha256Hex(manifest.sessionId).slice(0, 8),
    workspace: manifest.workspace,
    cwd: manifest.cwd,
    presetId: manifest.presetId,
    presetFingerprint: manifest.presetFingerprint,
    eventChainHeadSeq: manifest.eventChainHeadSeq,
    eventCount: manifest.eventCount,
    createdAtMs: manifest.createdAtMs,
  });
}

const FP8_RE = /^[0-9a-f]{8}$/;

/**
 * 归一输入：接受 describeC0 的脱敏描述符，也接受原始 manifest（内部换算 fp8）。
 * 描述符里没有完整 sessionId，所以比较时一律落到 fp8；报告里也只出现 fp8。
 */
function normalizeDescriptor(input, label) {
  if (!isPlainObject(input)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${label} 必须是 C0 描述符或 manifest 对象`);
  }
  const isDescriptor = Object.prototype.hasOwnProperty.call(input, 'sessionIdFp8') && !Object.prototype.hasOwnProperty.call(input, 'sessionId');
  if (isDescriptor) {
    if (typeof input.sessionIdFp8 !== 'string' || !FP8_RE.test(input.sessionIdFp8)) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, `${label}.sessionIdFp8 必须是 8 位 hex`);
    }
    return Object.freeze({
      sessionIdFp8: input.sessionIdFp8,
      sessionId: null,
      workspace: requireText(input.workspace, 'workspace'),
      cwd: requireText(input.cwd, 'cwd'),
      presetId: requireText(input.presetId, 'presetId'),
      presetFingerprint: requireText(input.presetFingerprint, 'presetFingerprint'),
      eventChainHeadSeq: requireNonNegativeInt(input.eventChainHeadSeq, 'eventChainHeadSeq'),
      eventCount: requireNonNegativeInt(input.eventCount, 'eventCount'),
      createdAtMs: requireNonNegativeInt(input.createdAtMs, 'createdAtMs'),
    });
  }
  const manifest = normalizeManifest(input, label);
  return Object.freeze({
    ...manifest,
    sessionIdFp8: sha256Hex(manifest.sessionId).slice(0, 8),
  });
}

/**
 * 校验两份 C0 描述符/清单是否描述同一个「身份 + 内容」。
 *
 * 比较项：sessionId(fp8)、workspace、cwd、presetId、presetFingerprint、
 * eventChainHeadSeq、eventCount、createdAtMs。
 * **任何变化都给出明确 reasons**（不是一句 changed），方向也要说清楚：
 *   - eventChainHeadSeq 前进 = 链尾推进（正常，但说明两次采样间发生过写入）；
 *   - eventChainHeadSeq 回退 = 日志被重建/回滚，必查；
 *   - createdAtMs 变化 = 同 ID 重建，最隐蔽的漂移。
 *
 * @returns {{ok:boolean, changed:boolean, reasons:string[]}}
 */
export function assertContinuity(before, after) {
  const a = normalizeDescriptor(before, 'before');
  const b = normalizeDescriptor(after, 'after');
  const reasons = [];

  if (a.sessionIdFp8 !== b.sessionIdFp8) {
    reasons.push(`sessionId 变化：fp8 ${a.sessionIdFp8} → ${b.sessionIdFp8}（不是同一个 Session）`);
  }
  if (a.workspace !== b.workspace) {
    reasons.push(`workspace 变化：${JSON.stringify(a.workspace)} → ${JSON.stringify(b.workspace)}`);
  }
  if (a.cwd !== b.cwd) {
    reasons.push(`cwd 变化：${JSON.stringify(a.cwd)} → ${JSON.stringify(b.cwd)}`);
  }
  if (a.presetId !== b.presetId) {
    reasons.push(`presetId 变化：${JSON.stringify(a.presetId)} → ${JSON.stringify(b.presetId)}`);
  }
  if (a.presetFingerprint !== b.presetFingerprint) {
    reasons.push(`presetFingerprint 变化：${a.presetFingerprint} → ${b.presetFingerprint}（preset 内容漂移）`);
  }
  if (a.eventChainHeadSeq !== b.eventChainHeadSeq) {
    const direction = b.eventChainHeadSeq > a.eventChainHeadSeq ? '前进' : '回退';
    reasons.push(`eventChainHeadSeq ${direction}：${a.eventChainHeadSeq} → ${b.eventChainHeadSeq}`);
  }
  if (a.eventCount !== b.eventCount) {
    reasons.push(`eventCount 变化：${a.eventCount} → ${b.eventCount}`);
  }
  if (a.createdAtMs !== b.createdAtMs) {
    reasons.push(`createdAtMs 变化：${a.createdAtMs} → ${b.createdAtMs}（会话创建时间不同，疑似同 ID 重建）`);
  }

  return Object.freeze({ ok: reasons.length === 0, changed: reasons.length > 0, reasons: Object.freeze(reasons) });
}
