// P2 outbound authorization: four independent gates, default deny.
// This module is intentionally pure: the Host must call it before any enqueue.
export const OUTBOUND_DENY_REASON = Object.freeze({
  INVALID_TARGET: 'INVALID_TARGET',
  NOT_PRIVATE: 'NOT_PRIVATE',
  GROUP_TARGET: 'GROUP_TARGET',
  TARGET_NOT_ADMIN: 'TARGET_NOT_ADMIN',
  LOGIN_UIN_FORBIDDEN: 'LOGIN_UIN_FORBIDDEN',
  GROUP_SOURCE: 'GROUP_SOURCE',
  NOT_SEND_TOOL: 'NOT_SEND_TOOL',
  CALLER_UNAUTHORIZED: 'CALLER_UNAUTHORIZED',
  OUTBOUND_DISABLED: 'OUTBOUND_DISABLED',
  TOOL_DISABLED: 'TOOL_DISABLED',
});

const SEND_TOOLS = new Set(['send_message', 'send_private_message']);
// SnowLuma 登录号，绝不因 allow/配置误写而变成可发送目标。
const FORBIDDEN_LOGIN_UIN = '20000004';

function targetString(target) {
  if (typeof target === 'string') return target.trim();
  if (target && typeof target === 'object') return String(target.key ?? target.target ?? '').trim();
  return '';
}

function senderUin(target) {
  const m = /^private:(\d+)$/.exec(targetString(target));
  return m ? m[1] : null;
}

function sourceIsGroup(source, sourceKey = null) {
  const values = [source, sourceKey].flatMap((v) => {
    if (typeof v === 'string') return [v];
    if (v && typeof v === 'object') return [v.key, v.conversationKey, v.target, v.kind, v.source];
    return [];
  }).filter(Boolean).map(String);
  return values.some((v) => /^group:/i.test(v) || /(^|:)group(?::|$)/i.test(v) || v === 'group');
}

function toolAllowed(config, tool) {
  if (!SEND_TOOLS.has(String(tool))) return false;
  const tools = config?.socialV2?.tools;
  if (!tools || typeof tools !== 'object') return true;
  if (tool === 'send_message') return tools.sendMessage !== false;
  if (tool === 'send_private_message') return tools.sendPrivate !== false;
  return true;
}

/**
 * @returns {{allowed:boolean, reason:string|null, target:string, tool:string, senderUin:string|null}}
 */
export function authorizeOutbound({ target, source = 'unknown', sourceKey = null, tool = 'send_message', caller = null, config = {} } = {}) {
  const raw = targetString(target);
  const uin = senderUin(raw);
  const reason = (code) => ({ allowed: false, reason: code, target: raw, tool: String(tool), senderUin: uin });

  if (!raw) return reason(OUTBOUND_DENY_REASON.INVALID_TARGET);
  // QQ private only. group:<id> is a hard private-only denial.
  if (/^group:/i.test(raw)) return reason(OUTBOUND_DENY_REASON.GROUP_TARGET);
  if (!uin) return reason(OUTBOUND_DENY_REASON.INVALID_TARGET);
  if (uin === FORBIDDEN_LOGIN_UIN) return reason(OUTBOUND_DENY_REASON.LOGIN_UIN_FORBIDDEN);
  const owner = String(config?.expected?.ownerQQ ?? config?.ownerQQ ?? '');
  if (!owner || uin !== owner) return reason(OUTBOUND_DENY_REASON.TARGET_NOT_ADMIN);
  if (sourceIsGroup(source, sourceKey)) return reason(OUTBOUND_DENY_REASON.GROUP_SOURCE);
  if (!SEND_TOOLS.has(String(tool))) return reason(OUTBOUND_DENY_REASON.NOT_SEND_TOOL);
  if (config?.deployment?.qqOutbound !== 'ENABLED') return reason(OUTBOUND_DENY_REASON.OUTBOUND_DISABLED);
  if (!toolAllowed(config, tool)) return reason(OUTBOUND_DENY_REASON.TOOL_DISABLED);
  if (!caller || typeof caller !== 'object') return reason(OUTBOUND_DENY_REASON.CALLER_UNAUTHORIZED);
  const callerOk = caller.internal === true
    || (caller.consoleTokenOk === true && caller.agentCall === true && caller.agentTokenOk === true);
  if (!callerOk) return reason(OUTBOUND_DENY_REASON.CALLER_UNAUTHORIZED);
  return { allowed: true, reason: null, target: raw, tool: String(tool), senderUin: uin };
}

export function isAllowedPrivateTarget(target, config = {}) {
  const uin = senderUin(target);
  return Boolean(uin && uin === String(config?.expected?.ownerQQ ?? config?.ownerQQ ?? '') && uin !== FORBIDDEN_LOGIN_UIN);
}
