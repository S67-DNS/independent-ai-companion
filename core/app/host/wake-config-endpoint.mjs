// Host 受控 wake 配置端点（#1 的唯一入口）。
//
// 约束：
//   * 仅监听 127.0.0.1（由 core-host 决定），不接受远端来源；
//   * key 必须在 allow.private / allow.groups（或 ownerQQ）白名单内；
//   * config 字段走 wake-config-schema 的同一套白名单，未知字段 400；
//   * 可选控制令牌（OPENCORE_HOST_CONTROL_TOKEN / config.core.controlToken）：配置了就要求
//     `x-opencore-host-token` 精确匹配；没配置则依赖回环绑定 + key 白名单。
//   * 响应只回 wakeConfig/task 元数据（sleepUntil、generation、是否跳过），不含正文。

import { normalizeWakeConfigPatch } from '../lifecycle/wake-config-schema.mjs';

export const WAKE_CONFIG_PATH = '/lifecycle/wake-config';
const KEY_RE = /^(private|group):(\d+)$/;

export function canonicalWakeKey(key) {
  const match = KEY_RE.exec(String(key ?? ''));
  if (!match) return null;
  const id = String(Number(match[2]));
  if (id === '0' || id === 'NaN') return null;
  return `${match[1]}:${id}`;
}

export function isWakeKeyAllowed(key, { allow = {}, ownerQQ = null } = {}) {
  const canonical = canonicalWakeKey(key);
  if (!canonical) return false;
  const [kind, id] = canonical.split(':');
  const owner = ownerQQ == null ? null : String(ownerQQ);
  if (kind === 'private') {
    const list = (allow?.private ?? []).map(String);
    return list.includes(id) || (owner != null && id === owner);
  }
  const list = (allow?.groups ?? []).map(String);
  return list.includes(id);
}

export function authorizeWakeControl({ headers = {}, expectedToken = null } = {}) {
  if (!expectedToken) return { ok: true, mode: 'loopback-key-allowlist' };
  const got = headers?.['x-opencore-host-token'];
  if (typeof got !== 'string' || got.length === 0) return { ok: false, reason: 'UNAUTHORIZED' };
  // 长度先比可避免明显的时序侧信道；令牌本身不写日志。
  if (got.length !== String(expectedToken).length || got !== String(expectedToken)) return { ok: false, reason: 'UNAUTHORIZED' };
  return { ok: true, mode: 'host-token' };
}

export function normalizeWakeConfigRequest(body, { nowMs = Date.now(), allow = {}, ownerQQ = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'WAKE_CONFIG_INVALID', message: 'body 必须是 JSON 对象', field: 'body' };
  }
  if (typeof body.key !== 'string' || body.key === '') {
    return { ok: false, status: 400, code: 'WAKE_CONFIG_INVALID', message: 'key 必须是非空字符串', field: 'key' };
  }
  if (!isWakeKeyAllowed(body.key, { allow, ownerQQ })) {
    return { ok: false, status: 403, code: 'KEY_NOT_ALLOWED', message: '该会话不在 wake 配置白名单内', field: 'key' };
  }
  if (body.throughSeq !== undefined && body.throughSeq !== null) {
    if (!Number.isInteger(body.throughSeq) || body.throughSeq < 0) {
      return { ok: false, status: 400, code: 'WAKE_CONFIG_INVALID', message: 'throughSeq 必须是非负整数', field: 'throughSeq' };
    }
  }
  if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
    return { ok: false, status: 400, code: 'WAKE_CONFIG_INVALID', message: 'config 必须是 JSON 对象', field: 'config' };
  }
  try {
    const { patch, sleepUntilMs } = normalizeWakeConfigPatch(body.config, { nowMs });
    if (sleepUntilMs !== null) patch.sleepUntil = new Date(sleepUntilMs).toISOString();
    return {
      ok: true,
      key: canonicalWakeKey(body.key),
      config: patch,
      throughSeq: body.throughSeq ?? null,
      throughSeqAccepted: false, // Host 不在本端点内做 mark-read；MCP 侧另行调用原有 mark-read
    };
  } catch (error) {
    return {
      ok: false, status: 400, code: error?.code ?? 'WAKE_CONFIG_INVALID',
      message: String(error?.message ?? error), field: error?.field ?? 'config',
    };
  }
}

/**
 * 纯请求处理：core-host 只负责读 body/写响应，所有鉴权/校验/应用逻辑都在这里，
 * 方便隔离测试（不需要启动 HTTP server）。
 * @returns {{status:number, body:object}}
 */
export function handleWakeConfigRequest({
  body, headers = {}, expectedToken = null, allow = {}, ownerQQ = null,
  nowMs = Date.now(), apply,
} = {}) {
  const auth = authorizeWakeControl({ headers, expectedToken });
  if (!auth.ok) {
    return { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: '缺少或错误的 host 控制令牌' } }, auth };
  }
  const normalized = normalizeWakeConfigRequest(body, { nowMs, allow, ownerQQ });
  if (!normalized.ok) {
    return { status: normalized.status, body: { ok: false, error: { code: normalized.code, message: normalized.message, field: normalized.field } }, auth };
  }
  if (typeof apply !== 'function') {
    return { status: 500, body: { ok: false, error: { code: 'INTERNAL', message: '缺少 apply 回调' } }, auth };
  }
  let result;
  try {
    result = apply(normalized.key, normalized.config, normalized.throughSeq);
  } catch (error) {
    return {
      status: 400,
      body: { ok: false, error: { code: error?.code ?? 'WAKE_CONFIG_INVALID', message: String(error?.message ?? error), field: error?.field ?? null } },
      auth,
    };
  }
  if (result?.ok === false) {
    const status = result.reason === 'UNKNOWN_CONVERSATION' ? 404 : 400;
    return {
      status,
      body: { ok: false, error: { code: result.reason ?? 'WAKE_CONFIG_REJECTED', message: 'wake 配置未应用' } },
      auth,
    };
  }
  return {
    status: 200,
    auth,
    body: {
      ok: true,
      path: WAKE_CONFIG_PATH,
      key: normalized.key,
      wakeConfig: result?.wakeConfig ?? null,
      generation: result?.generation ?? null,
      task: result?.task ?? null,
      skipped: result?.skipped ?? null,
      schedulerDispatched: result?.schedulerDispatched === true,
      throughSeq: normalized.throughSeq,
      throughSeqAccepted: false,
    },
  };
}
