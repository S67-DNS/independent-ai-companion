// SOCIALV2 L0/L1/L2 端点移植（12 个，B 方案：直接复用同一份 state/social-v2.json 与 history/*.jsonl）。
//
// 鉴权三件套（契约 §1）：
//   x-console-token 必须匹配 config.json consoleToken（缺失时回退 state/console-token）；
//   x-agent-call 必须等于 '1'（缺失不得退化成管理端全权）；
//   x-agent-token 必须等于该会话 social-v2.json 的 agentToken（缺失=拒绝）。
// 任何鉴权失败都发生在任何写之前（§6.2 零写）。
//
// 响应形状逐端点对照 src/bridge.js 的现网 handler；调用方 MCP 用 serializeModelData 原样透传，
// 所以键名/嵌套结构保持一致。具体行号见 out/PORT-REPORT.md。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  createSocialV2Store, canonicalV2Key, allowed as allowedByList,
  computeWakeSafety, isSleepingConfig, preSleepWaitBlocked, truncateText,
  formatMemory, formatParticipation, MEMORY_CATEGORIES,
} from './social-v2-store.mjs';
import { createHistoryArchive } from './history-recall.mjs';

export const SOCIALV2_ENDPOINTS = Object.freeze([
  { method: 'GET', path: '/api/socialV2/prompt', tool: 'getPrompt' },
  { method: 'GET', path: '/api/socialV2/unread', tool: 'getUnread' },
  { method: 'GET', path: '/api/socialV2/recent', tool: 'getRecent' },
  { method: 'GET', path: '/api/socialV2/state', tool: 'socialState' },
  { method: 'POST', path: '/api/socialV2/mark-read', tool: 'markRead' },
  { method: 'GET', path: '/api/socialV2/memory', tool: 'memory' },
  { method: 'POST', path: '/api/socialV2/memory-append', tool: 'memory' },
  { method: 'POST', path: '/api/socialV2/memory-update', tool: 'memory' },
  { method: 'POST', path: '/api/socialV2/memory-remove', tool: 'memory' },
  { method: 'POST', path: '/api/socialV2/memory-clear', tool: 'memory' },
  { method: 'GET', path: '/api/socialV2/recall', tool: 'memory' },
  { method: 'GET', path: '/api/socialV2/group-members', tool: 'getGroupMembers' },
]);
const ROUTES = new Map(SOCIALV2_ENDPOINTS.map((entry) => [`${entry.method} ${entry.path}`, entry]));

export class SocialV2ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'SocialV2ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 合并侧车 config 与旧桥 config.json：allow/deny/socialV2/slang/consoleToken 以旧桥文件为准。 */
export function loadRuntimeConfig({ config = {}, configPath = null } = {}) {
  const merged = { ...config };
  const file = configPath ? readJsonFile(configPath) : null;
  if (file && typeof file === 'object') {
    for (const key of ['allow', 'deny', 'allowAllWhenEmpty', 'socialV2', 'slang', 'consoleToken', 'ownerQQ']) {
      if (file[key] !== undefined) merged[key] = file[key];
    }
    if (file.bridge !== undefined) merged.bridge = file.bridge;
  }
  return merged;
}

export function resolveConsoleToken({ config = {}, stateDir = null } = {}) {
  const configured = String(config.consoleToken ?? '').trim();
  if (TOKEN_RE.test(configured)) return { token: configured, source: 'config' };
  if (stateDir) {
    try {
      const fileToken = fs.readFileSync(path.join(stateDir, 'console-token'), 'utf8').trim();
      if (TOKEN_RE.test(fileToken)) return { token: fileToken, source: 'state/console-token' };
    } catch { /* fall through */ }
  }
  return { token: null, source: 'missing' };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function keyFromRequest(url, body) {
  return String(url.searchParams.get('key') ?? body?.key ?? '').trim();
}

function intParam(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cleanExtra(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * @param {{stateFile:string, historyDir:string, config?:object, configPath?:string, stateDir?:string,
 *   consoleToken?:string, store?:object, history?:object, now?:Function, logger?:Function,
 *   roleProvider?:Function, selfProfile?:{nickname:?(string|null),userId:?(string|null),line:?(string|null)},
 *   groupMembersProvider?:Function, stickerEnabled?:?boolean,
 *   slangProvider?:?Function, stickerProvider?:?Function, voiceProvider?:?Function,
 *   voiceLibrary?:?Array<{name:string}>, voiceMaxSeconds?:?number,
 *   slangEntries?:?Array, slangBlock?:?string, stickerTotal?:?number, stickerContext?:?string, stickerStrategy?:?string}} options
 *
 * prompt 的 slang/stickers/voices 可达性约定（D5）：
 *   available:true  = 读到真源（"源存在但为空"也算 true，count/total 为 0 是事实）；
 *   available:false = 取不到 / 未接线，必须带 reason；**绝不允许**用 []/''/0 静默冒充空库。
 * 真源由 Host 注入 provider（slangProvider/stickerProvider/voiceProvider）；静态值选项保留
 * 兼容（显式传入即视为已接线），默认 null 表示"未接线"，此时 available:false。
 */
export function createSocialV2Api({
  stateFile,
  historyDir,
  config = {},
  configPath = null,
  stateDir = null,
  consoleToken = null,
  store = null,
  history = null,
  now = () => Date.now(),
  logger = () => {},
  roleProvider = null,
  selfProfile = { nickname: null, userId: null, line: null },
  groupMembersProvider = null,
  stickerEnabled = null,
  slangProvider = null,
  stickerProvider = null,
  voiceProvider = null,
  voiceLibrary = null,
  voiceMaxSeconds = null,
  slangEntries = null,
  slangBlock = null,
  stickerTotal = null,
  stickerContext = null,
  stickerStrategy = null,
} = {}) {
  if (!stateFile) throw new Error('stateFile required');
  if (!historyDir) throw new Error('historyDir required');
  const runtimeConfig = loadRuntimeConfig({ config, configPath });
  const tokenInfo = consoleToken != null
    ? { token: TOKEN_RE.test(String(consoleToken)) ? String(consoleToken) : null, source: 'option' }
    : resolveConsoleToken({ config: runtimeConfig, stateDir: stateDir ?? path.dirname(stateFile) });
  const v2Store = store ?? createSocialV2Store({ stateFile, now, logger });
  const v2History = history ?? createHistoryArchive({ historyDir, now, logger, redact: (text) => v2Store.redact(text) });
  const accessConfig = runtimeConfig.bridge?.allowed ?? runtimeConfig;
  const metrics = { requests: 0, authFailures: 0, writes: 0, historyAppends: 0, l0Failures: 0, promptLibsNotWired: 0 };
  // stickerEnabled 未显式给出时按旧桥语义取 config（cfg.socialV2.sticker.enabled !== false）。
  // 之前默认 false 会让 enabledTools() 静默少广告 6 个表情工具，与旧桥行为不一致。
  const stickerEnabledEffective = stickerEnabled === null || stickerEnabled === undefined
    ? runtimeConfig.socialV2?.sticker?.enabled !== false
    : stickerEnabled === true;

  function toolEnabled(flag) {
    if (!flag) return true;
    return runtimeConfig.socialV2?.tools?.[flag] !== false;
  }

  function assertAuth({ key, headers }) {
    if (!tokenInfo.token) throw new SocialV2ApiError(401, 'UNAUTHORIZED', '控制台令牌缺失：拒绝以无鉴权方式提供服务');
    if (!safeEqual(headers['x-console-token'], tokenInfo.token)) throw new SocialV2ApiError(401, 'UNAUTHORIZED', '控制台令牌无效');
    if (String(headers['x-agent-call'] ?? '') !== '1') throw new SocialV2ApiError(401, 'UNAUTHORIZED', '缺少 x-agent-call: 1（不得退化成管理端全权）');
    const agentToken = headers['x-agent-token'];
    if (typeof agentToken !== 'string' || !agentToken) throw new SocialV2ApiError(401, 'UNAUTHORIZED', '缺少 x-agent-token');
    if (!v2Store.tokenMatches(key, agentToken)) throw new SocialV2ApiError(403, 'FORBIDDEN', 'agent token 无效');
  }

  function assertScope(key) {
    const canonical = canonicalV2Key(key);
    if (!canonical) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'key 必须形如 group:群号 或 private:QQ号');
    const [kind, id] = canonical.split(':');
    if (!allowedByList(kind, id, accessConfig)) throw new SocialV2ApiError(403, 'FORBIDDEN', '目标不在当前模式允许范围内');
    return canonical;
  }

  function assertEnabled() {
    const raw = v2Store.readRaw();
    if (raw?.paused === true) throw new SocialV2ApiError(403, 'FORBIDDEN', 'social-v2 已暂停');
    if (runtimeConfig.socialV2?.enabled === false) throw new SocialV2ApiError(403, 'FORBIDDEN', 'socialV2 已禁用');
  }

  function requireConversation(key) {
    const snapshot = v2Store.readConversation(key);
    if (!snapshot) throw new SocialV2ApiError(404, 'NOT_FOUND', '会话不存在');
    return snapshot;
  }

  function enabledTools() {
    const toolMap = {
      getPrompt: 'qq_get_prompt', getUnread: 'qq_get_unread_messages', getRecent: 'qq_get_recent_messages',
      socialState: 'qq_social_state', sendGroup: 'qq_send_group_message', sendPrivate: 'qq_send_private_message',
      reply: 'qq_reply', sendBurst: 'qq_send_burst', sendMessage: 'qq_send_message', waitMessages: 'qq_wait_for_messages',
      feedback: 'qq_report_feedback', getMyRecent: 'qq_get_my_recent_messages', getMessageDetail: 'qq_get_message_detail',
      getActiveMembers: 'qq_get_active_members', setWakeConfig: 'qq_set_wake_config', markRead: 'qq_mark_read',
      memory: 'qq_memory_append / qq_memory_query / qq_memory_update / qq_memory_remove / qq_memory_clear',
      slangQuery: 'qq_slang_query', slangSubmit: 'qq_slang_submit', getImages: 'qq_get_message_images',
      getForwardMsg: 'qq_get_forward_msg', sendPoke: 'qq_send_poke', listStickers: 'qq_list_stickers',
      getStickerImage: 'qq_get_sticker_image', sendSticker: 'qq_send_sticker', setStickerRemark: 'qq_set_sticker_remark',
      stickerNote: 'qq_sticker_note', collectSticker: 'qq_collect_sticker', getSelfImage: 'qq_get_self_image',
      sendVoice: 'qq_send_voice / qq_list_voices', singCover: 'sing_cover / sing_search（唱一段歌，最多 5 分钟）',
    };
    const tools = runtimeConfig.socialV2?.tools ?? {};
    const stickerFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
    const out = [];
    for (const [flag, name] of Object.entries(toolMap)) {
      if (tools[flag] !== false && !(stickerFlags.has(flag) && !stickerEnabledEffective)) out.push(name);
    }
    return out;
  }

  function rolePayload() {
    const expectedName = runtimeConfig.expected?.role ?? null;
    if (typeof roleProvider !== 'function') return { configured: false, available: true, name: expectedName, hint: '' };
    let role;
    try { role = roleProvider(); } catch (error) {
      return { configured: true, available: false, name: expectedName, reason: String(error?.message ?? error), detail: null, file: null };
    }
    if (role?.configured === true && role.ok === false) {
      return { configured: true, available: false, name: role.name ?? expectedName, reason: role.reason ?? 'role-card-unavailable', detail: role.detail ?? null, file: role.roleFile ?? null };
    }
    return { configured: role?.configured === true, available: true, name: role?.name ?? expectedName, hint: String(role?.hint ?? '') };
  }

  // ── prompt 真源（D5）：fail closed —— 没有 provider 也没有显式静态值 ⇒ available:false + reason:'not-wired' ──
  // 绝不返回"形状一致的空值"冒充空库；生产 Host 恒注入三个 provider（静态守卫会检查）。
  /** 调 provider：未接线返回 null；抛错/返回非法值 → 明确不可用（不回退成空数组）。 */
  async function callPromptProvider(provider, name) {
    if (typeof provider !== 'function') return null;
    try {
      const value = await provider();
      if (value && typeof value === 'object') return value;
      return { available: false, reason: `${name}-provider-invalid-result` };
    } catch (error) {
      logger(`[socialv2-api] ${name} provider 失败: ${error?.message ?? error}`);
      return { available: false, reason: `${name}-provider-error`, error: String(error?.message ?? error) };
    }
  }

  function withAvailability(payload, reasonDefault) {
    if (payload.available === true) return payload;
    return { ...payload, available: false, reason: String(payload.reason ?? reasonDefault) };
  }

  function slangPayload(raw) {
    if (raw === null) {
      // 未接线：fail closed（不得冒充空库）。
      return { enabled: runtimeConfig.slang?.enabled !== false, available: false, reason: 'not-wired', entries: [], block: '' };
    }
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return withAvailability({
      enabled: raw?.enabled === undefined ? runtimeConfig.slang?.enabled !== false : raw.enabled !== false,
      available: raw?.available === true,
      ...(raw?.reason ? { reason: String(raw.reason) } : {}),
      ...(raw?.stale === true ? { stale: true } : {}),
      ...(raw?.staleSinceMs ? { staleSinceMs: Number(raw.staleSinceMs) } : {}),
      ...(raw?.source ? { source: String(raw.source) } : {}),
      count: Number.isInteger(raw?.count) ? raw.count : entries.length,
      entries,
      block: String(raw?.block ?? ''),
      ...(raw?.loadedAtMs ? { loadedAtMs: Number(raw.loadedAtMs) } : {}),
      ...(raw?.error ? { error: String(raw.error) } : {}),
    }, 'slang-unavailable');
  }

  function stickerPayload(raw) {
    const stickerCfg = runtimeConfig.socialV2?.sticker ?? {};
    const includeInPrompt = stickerCfg.includeInPrompt !== false;
    if (raw === null) {
      // 未接线：fail closed。
      return { enabled: stickerCfg.enabled !== false, available: false, reason: 'not-wired', total: 0, context: '', strategy: '' };
    }
    return withAvailability({
      enabled: raw?.enabled === undefined ? stickerCfg.enabled !== false : raw.enabled !== false,
      available: raw?.available === true,
      ...(raw?.reason ? { reason: String(raw.reason) } : {}),
      ...(raw?.stale === true ? { stale: true } : {}),
      ...(raw?.staleSinceMs ? { staleSinceMs: Number(raw.staleSinceMs) } : {}),
      ...(raw?.source ? { source: String(raw.source) } : {}),
      total: Number(raw?.total) || 0,
      context: includeInPrompt ? String(raw?.context ?? '') : '',
      strategy: includeInPrompt ? String(raw?.strategy ?? '') : '',
      ...(raw?.loadedAtMs ? { loadedAtMs: Number(raw.loadedAtMs) } : {}),
      ...(raw?.error ? { error: String(raw.error) } : {}),
    }, 'stickers-unavailable');
  }

  function voicePayload(raw) {
    if (raw === null) {
      // 未接线：fail closed（voice 被 config 显式禁用时不会走到这里，走 {enabled:false}）。
      return {
        enabled: true,
        available: false,
        reason: 'not-wired',
        total: 0,
        names: [],
        maxSeconds: Number(voiceMaxSeconds) > 0 ? Number(voiceMaxSeconds) : 0,
        hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去',
      };
    }
    const names = Array.isArray(raw?.names) ? raw.names.slice(0, 12).map((n) => String(n ?? '')) : [];
    const configuredMax = Number(voiceMaxSeconds) > 0 ? Number(voiceMaxSeconds) : Number(runtimeConfig.socialV2?.voice?.maxSeconds);
    return withAvailability({
      enabled: raw?.enabled === undefined ? runtimeConfig.socialV2?.voice?.enabled !== false : raw.enabled !== false,
      available: raw?.available === true,
      ...(raw?.reason ? { reason: String(raw.reason) } : {}),
      ...(raw?.stale === true ? { stale: true } : {}),
      ...(raw?.staleSinceMs ? { staleSinceMs: Number(raw.staleSinceMs) } : {}),
      ...(raw?.source ? { source: String(raw.source) } : {}),
      total: Number(raw?.total) || names.length,
      names,
      maxSeconds: Number(raw?.maxSeconds) > 0 ? Number(raw.maxSeconds) : (configuredMax > 0 ? configuredMax : 300),
      hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去',
      ...(raw?.loadedAtMs ? { loadedAtMs: Number(raw.loadedAtMs) } : {}),
      ...(raw?.error ? { error: String(raw.error) } : {}),
    }, 'voices-unavailable');
  }

  const handlers = {
    async prompt(url, body, headers, key) {
      requireConversation(key);
      const role = rolePayload();
      if (role.configured && !role.available) {
        return {
          status: 503,
          body: {
            ok: false,
            error: `角色定义不可用（${role.reason}），已拒绝返回角色提示`,
            code: 'role-card-unavailable',
            role: { name: role.name, configured: true, ok: false, reason: role.reason, detail: role.detail, file: role.file },
          },
        };
      }
      const snapshot = requireConversation(key);
      const st = snapshot.conversation;
      void body; void headers;
      const wakeConfig = v2Store.wakeConfigOf(st);
      const safety = computeWakeSafety(wakeConfig);
      const stickerCfg = runtimeConfig.socialV2?.sticker ?? {};
      // 三个字段的真源：provider 优先；未接线时明确 available:false（静态值显式传入视为已接线）。
      const slangRaw = (await callPromptProvider(slangProvider, 'slang'))
        ?? (slangEntries !== null
          ? { enabled: runtimeConfig.slang?.enabled !== false, available: true, source: 'static-options', entries: slangEntries, block: slangBlock }
          : null);
      const stickerRaw = (await callPromptProvider(stickerProvider, 'stickers'))
        ?? (stickerTotal !== null || stickerContext !== null || stickerStrategy !== null
          ? { enabled: stickerCfg.enabled !== false, available: true, source: 'static-options', total: stickerTotal ?? 0, context: stickerContext ?? '', strategy: stickerStrategy ?? '' }
          : null);
      const voiceDisabled = runtimeConfig.socialV2?.voice?.enabled === false;
      const voiceRaw = voiceDisabled
        ? null
        : (await callPromptProvider(voiceProvider, 'voices'))
          ?? (voiceLibrary !== null
            ? { enabled: true, available: true, source: 'static-options', total: Array.isArray(voiceLibrary) ? voiceLibrary.length : 0, names: (Array.isArray(voiceLibrary) ? voiceLibrary : []).slice(0, 12).map((v) => v?.name), maxSeconds: voiceMaxSeconds }
            : null);
      if (slangRaw === null || stickerRaw === null || (!voiceDisabled && voiceRaw === null)) {
        // 未接线导致的不可用：一次 prompt 记一次，供 /health 观测（不记正文）。
        metrics.promptLibsNotWired += 1;
      }
      return {
        status: 200,
        body: {
          ok: true,
          key,
          time: new Date(Number(now())).toISOString(),
          self: {
            nickname: selfProfile?.nickname ?? null,
            userId: selfProfile?.userId ?? null,
            line: selfProfile?.line ?? null,
          },
          role: { name: role.name, hint: role.hint },
          recommended: runtimeConfig.socialV2?.provideRecommendations === false ? null : {
            wake: runtimeConfig.socialV2?.wake ?? {},
            send: runtimeConfig.socialV2?.send ?? {},
            wait: runtimeConfig.socialV2?.wait ?? {},
            proactive: runtimeConfig.socialV2?.proactive ?? {},
          },
          enabledTools: enabledTools(),
          replyTiming: v2Store.replyTiming(st, runtimeConfig),
          unreadCount: v2Store.effectiveUnread(st).length,
          recentCount: v2Store.effectiveRecent(st).length,
          currentWakeConfig: wakeConfig,
          wakeSafety: safety,
          memory: formatMemory(st),
          participation: formatParticipation(st),
          slang: slangPayload(slangRaw),
          stickers: stickerPayload(stickerRaw),
          voices: voiceDisabled ? { enabled: false } : voicePayload(voiceRaw),
        },
      };
    },

    async state(url, body, headers, key) {
      void body; void headers;
      const snapshot = requireConversation(key);
      const st = snapshot.conversation;
      const wakeConfig = v2Store.wakeConfigOf(st);
      return {
        status: 200,
        body: {
          ok: true, key,
          wakeConfig,
          wakeSafety: computeWakeSafety(wakeConfig),
          unreadCount: v2Store.effectiveUnread(st).length,
          recentCount: v2Store.effectiveRecent(st).length,
          lastWakeReason: st.lastWakeReason ?? '',
          lastAiReplyAt: Number(st.lastAiReplyAt) || 0,
        },
      };
    },

    async unread(url, body, headers, key) {
      void body; void headers;
      const limit = intParam(url.searchParams.get('limit'), 30, 1, 100);
      const afterRaw = url.searchParams.get('afterSeq');
      let afterSeq = null;
      if (afterRaw !== null) {
        if (!/^\d+$/.test(afterRaw)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'afterSeq 必须是非负安全整数；从最早未读开始请传 0');
        afterSeq = Number(afterRaw);
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'afterSeq 必须是非负安全整数；从最早未读开始请传 0');
      }
      const snapshot = requireConversation(key);
      const st = snapshot.conversation;
      const unread = v2Store.effectiveUnread(st);
      const messages = afterSeq === null ? unread.slice(-limit) : unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
      v2Store.noteSeen(key, messages);
      return {
        status: 200,
        body: { ok: true, key, unreadCount: unread.length, messages, readThroughSeq: v2Store.readThroughSeq(st, [], key) },
      };
    },

    async recent(url, body, headers, key) {
      void body; void headers;
      const limit = intParam(url.searchParams.get('limit'), 20, 1, 100);
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const snapshot = requireConversation(key);
      const st = snapshot.conversation;
      const recent = v2Store.effectiveRecent(st);
      const start = Math.max(0, recent.length - offset - limit);
      const end = Math.max(0, recent.length - offset);
      const messages = recent.slice(start, end);
      v2Store.noteSeen(key, messages);
      return { status: 200, body: { ok: true, key, messages, readThroughSeq: v2Store.readThroughSeq(st, [], key) } };
    },

    async markRead(url, body, headers, key) {
      void url;
      const snapshot = requireConversation(key);
      const st = snapshot.conversation;
      const throughSeq = v2Store.requestedReadThrough(st, body, key);
      if (isSleepingConfig(v2Store.wakeConfigOf(st)) && preSleepWaitBlocked(st, runtimeConfig, Number(now()))) {
        const preSleepMs = Math.max(0, Number(runtimeConfig.socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Number(now()) - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        throw new SocialV2ApiError(400, 'PRE_SLEEP_WAIT_BLOCKED', `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`, {
          preSleepWaitMs: preSleepMs, preSleepWaitRemainingMs: remaining,
        });
      }
      void headers;
      const result = await v2Store.markRead(key, throughSeq);
      metrics.writes += 1;
      return {
        status: 200,
        body: {
          ok: true, key,
          markedCount: result.markedCount,
          unreadCount: result.unreadCount,
          readThroughSeq: result.readThroughSeq,
          wakeGuaranteed: result.wakeGuaranteed,
          wakeSafety: result.wakeSafety,
          wakeConfig: result.wakeConfig,
        },
      };
    },

    async memory(url, body, headers, key) {
      void body; void headers;
      const category = String(url.searchParams.get('category') ?? '').trim();
      if (category && !MEMORY_CATEGORIES.includes(category)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'category 必须是 activeTopic / pendingThought / memberImpression / promise');
      const result = v2Store.memoryQuery(key, category);
      if (!result) throw new SocialV2ApiError(404, 'NOT_FOUND', '会话不存在');
      return { status: 200, body: { ok: true, key, category, formatted: result.formatted, raw: result.raw } };
    },

    async memoryAppend(url, body, headers, key) {
      void url; void headers;
      const category = String(body?.category ?? '').trim();
      const content = String(body?.content ?? '').trim();
      const extra = cleanExtra(body?.extra);
      if (!category || !content) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'key/category/content 不能为空');
      if (!MEMORY_CATEGORIES.includes(category)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'category 必须是 activeTopic / pendingThought / memberImpression / promise');
      if (category === 'memberImpression' && !String(extra.target || '').trim()) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'memberImpression 需要 extra.target 指定群友名字');
      const sanitized = {
        ...extra,
        ...(extra.target !== undefined ? { target: v2Store.redact(String(extra.target)).trim() } : {}),
        ...(extra.motivation !== undefined ? { motivation: v2Store.redact(String(extra.motivation)).trim() } : {}),
        ...(extra.pendingQuestion !== undefined ? { pendingQuestion: v2Store.redact(String(extra.pendingQuestion)).trim() } : {}),
        ...(Array.isArray(extra.participants) ? { participants: extra.participants.map((p) => v2Store.redact(String(p)).trim()) } : {}),
      };
      const result = await v2Store.memoryAppend(key, category, content, sanitized);
      metrics.writes += 1;
      return { status: 200, body: { ok: true, key, category, content, memory: result.memory } };
    },

    async memoryUpdate(url, body, headers, key) {
      void url; void headers;
      const category = String(body?.category ?? '').trim();
      const oldContent = String(body?.oldContent ?? '').trim();
      const target = v2Store.redact(String(body?.target ?? '').trim());
      const newContent = body?.newContent !== undefined && body?.newContent !== null ? v2Store.redact(String(body.newContent).trim()) : undefined;
      const newExtra = cleanExtra(body?.newExtra);
      const cleanNewExtra = {
        ...newExtra,
        pendingQuestion: newExtra.pendingQuestion !== undefined ? v2Store.redact(String(newExtra.pendingQuestion)).trim() : undefined,
        participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => v2Store.redact(String(p)).trim()) : undefined,
        motivation: newExtra.motivation !== undefined ? v2Store.redact(String(newExtra.motivation)).trim() : undefined,
        target: newExtra.target !== undefined ? v2Store.redact(String(newExtra.target)).trim() : undefined,
      };
      if (!category) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'key/category 不能为空');
      if (!MEMORY_CATEGORIES.includes(category)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'category 必须是 activeTopic / pendingThought / memberImpression / promise');
      if (category === 'memberImpression' && !target) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'memberImpression 需要 target 指定原群友名字');
      if (category !== 'memberImpression' && !oldContent) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', '该类别需要 oldContent 指定要编辑的记忆内容');
      const result = await v2Store.memoryUpdate(key, category, oldContent, newContent, cleanNewExtra, target);
      metrics.writes += 1;
      return { status: 200, body: { ok: true, key, category, memory: result.memory } };
    },

    async memoryRemove(url, body, headers, key) {
      void url; void headers;
      const category = String(body?.category ?? '').trim();
      const content = String(body?.content ?? '').trim();
      const target = String(body?.target ?? '').trim();
      if (!category) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'key/category 不能为空');
      if (!MEMORY_CATEGORIES.includes(category)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'category 必须是 activeTopic / pendingThought / memberImpression / promise');
      if (category === 'memberImpression' && !target) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'memberImpression 需要 target 指定群友名字');
      if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', '非法的群友名字');
      if (category !== 'memberImpression' && !content) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', '该类别需要 content 指定要删除的记忆内容');
      const result = await v2Store.memoryRemove(key, category, content, target);
      metrics.writes += 1;
      return { status: 200, body: { ok: true, key, category, memory: result.memory } };
    },

    async memoryClear(url, body, headers, key) {
      void url; void headers;
      const category = String(body?.category ?? '').trim();
      if (category && !MEMORY_CATEGORIES.includes(category)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'category 必须是 activeTopic / pendingThought / memberImpression / promise');
      const result = await v2Store.memoryClear(key, category);
      metrics.writes += 1;
      return { status: 200, body: { ok: true, key, category: category || 'all', memory: result.memory } };
    },

    async recall(url, body, headers, key) {
      void body; void headers;
      const q = String(url.searchParams.get('q') ?? '').trim();
      if (!q) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'q 不能为空');
      const limit = intParam(url.searchParams.get('limit'), 5, 1, 20);
      const options = {};
      for (const name of ['after', 'before', 'self', 'sender', 'context']) {
        const value = url.searchParams.get(name);
        if (value !== null) options[name] = value;
      }
      let result;
      try {
        result = v2History.search(key, q, limit, options);
      } catch (error) {
        throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', String(error?.message ?? error));
      }
      return { status: 200, body: { ok: true, key, q, ...result } };
    },

    async groupMembers(url, body, headers, key) {
      void body; void headers;
      if (!/^group:\d+$/.test(key)) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', '群成员只能按 group:群号 查询');
      const limit = intParam(url.searchParams.get('limit'), 50, 1, 100);
      if (typeof groupMembersProvider !== 'function') throw new SocialV2ApiError(503, 'CAPABILITY_UNAVAILABLE', '群成员读取不可用：未配置 OneBot HTTP');
      let raw;
      try {
        raw = await groupMembersProvider(Number(key.split(':')[1]), limit);
      } catch (error) {
        throw new SocialV2ApiError(502, 'UPSTREAM', `获取群成员失败：${error?.message ?? error}`);
      }
      if (!Array.isArray(raw)) throw new SocialV2ApiError(502, 'UPSTREAM', '网关返回的成员列表格式异常，已拒绝');
      const members = raw.slice(0, limit).map((member) => ({
        userId: member?.user_id != null ? String(member.user_id) : '',
        nickname: truncateText(String(member?.nickname ?? ''), 40),
        card: truncateText(String(member?.card ?? ''), 40),
        ...(member?.role ? { role: String(member.role) } : {}),
      })).filter((member) => member.userId);
      return { status: 200, body: { ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members } };
    },
  };

  function routeHandler(entry) {
    const name = entry.path.split('/').pop().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return handlers[name];
  }

  function matches(method, requestUrl) {
    try {
      const url = new URL(requestUrl, 'http://127.0.0.1');
      void method;
      return url.pathname.startsWith('/api/socialV2/');
    } catch { return false; }
  }

  async function handleRequest({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    metrics.requests += 1;
    let parsed;
    try { parsed = new URL(url, 'http://127.0.0.1'); } catch {
      return { status: 400, body: { ok: false, error: '无效的请求地址' } };
    }
    if (!parsed.pathname.startsWith('/api/socialV2/')) return null;
    const entry = ROUTES.get(`${method} ${parsed.pathname}`);
    if (!entry) return { status: 404, body: { ok: false, error: 'not found' } };
    const key = keyFromRequest(parsed, body);
    try {
      if (!key) throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'key 不能为空');
      const canonical = assertScope(key);
      assertAuth({ key: canonical, headers });
      assertEnabled();
      if (!toolEnabled(entry.tool)) {
        const toolName = entry.path.includes('memory') ? 'qq_memory_*' : entry.path.includes('recall') ? 'qq_recall' : `qq_${entry.tool}`;
        throw new SocialV2ApiError(403, 'FORBIDDEN', `工具未启用：${toolName}`);
      }
      const handler = routeHandler(entry);
      if (typeof handler !== 'function') throw new SocialV2ApiError(500, 'INTERNAL', 'endpoint handler missing');
      return await handler(parsed, body, headers, canonical);
    } catch (error) {
      if (error instanceof SocialV2ApiError) {
        metrics.authFailures += error.status === 401 || error.status === 403 ? 1 : 0;
        return {
          status: error.status,
          body: { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}), ...error.extra },
        };
      }
      if (error?.code === 'not-found') return { status: 404, body: { ok: false, error: String(error.message) } };
      if (error?.code === 'invalid-argument') return { status: 400, body: { ok: false, error: String(error.message) } };
      if (error?.code === 'write-failed') return { status: 500, body: { ok: false, error: String(error.message) } };
      logger(`[socialv2-api] ${method} ${parsed.pathname} 失败: ${error?.stack ?? error}`);
      return { status: 500, body: { ok: false, error: String(error?.message ?? error) } };
    }
  }

  async function readHttpBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) { reject(new SocialV2ApiError(413, 'PAYLOAD_TOO_LARGE', 'body too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleHttp(req, res) {
    if (!req.url || !req.url.startsWith('/api/socialV2/')) return false;
    let body = null;
    try {
      if (req.method === 'POST') {
        const text = await readHttpBody(req);
        if (text.trim()) {
          try { body = JSON.parse(text); } catch { throw new SocialV2ApiError(400, 'INVALID_ARGUMENT', 'body 不是合法 JSON'); }
        }
      }
      const result = await handleRequest({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
      return true;
    } catch (error) {
      const status = error?.status ?? 400;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
      return true;
    }
  }

  // ── Host L0 写入责任（不经过 HTTP；由 core-host 的入站/成功出站钩子调用） ───────
  async function recordInbound({ key, sender = '', userId = null, text = '', isOwner = false, messageId = null, time = Number(now()), kind = 'text', media = [] } = {}) {
    const result = await v2Store.safeAppendInbound(key, { sender, userId, text, isOwner, messageId, time, kind, media });
    if (!result.ok) { metrics.l0Failures += 1; return result; }
    const archived = v2History.appendEntry(key, {
      text, sender, isSelf: false, kind, time: result.message.time, mid: result.message.messageId,
    });
    if (archived.appended) metrics.historyAppends += 1;
    return { ...result, archived };
  }

  async function recordSelfSent({ key, text = '', messageId = null, time = Number(now()), kind = 'text' } = {}) {
    const result = await v2Store.safeAppendSelf(key, { text, messageId, time, kind });
    if (!result.ok) { metrics.l0Failures += 1; return result; }
    const archived = v2History.appendEntry(key, {
      text: v2Store.redact(text), sender: '我', isSelf: true, kind, time: result.message.time, mid: result.message.messageId,
    });
    if (archived.appended) metrics.historyAppends += 1;
    return { ...result, archived };
  }

  // ── 撤回幂等（GAP-A）：同一 mid 重复 notice 不得产生第二条 tombstone ──────────
  // 以历史文件里已存在的 tombstone 为准（跨进程/重启有效）；进程内 Set 只是快路径。
  const recalledMids = new Set();
  function historyHasRecall(key, mid) {
    const id = String(mid ?? '').trim();
    if (!id) return false;
    const cacheKey = `${key}\u0000${id}`;
    if (recalledMids.has(cacheKey)) return true;
    try {
      const file = v2History.fileFor(key);
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line || line.indexOf('"recall"') < 0) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && String(entry.recall ?? '') === id) return true;
        } catch { /* 坏行跳过：不影响其它行的判定 */ }
      }
    } catch { /* 文件不存在/读不了 ⇒ 视为还没有 tombstone，交给 appendRecall 决定 */ }
    return false;
  }

  async function recordRecall({ key, mid } = {}) {
    const id = String(mid ?? '').trim();
    if (!id) return { ok: false, deduped: false, error: 'mid 不能为空', tombstone: { appended: false, reason: 'empty-mid' } };
    const duplicate = historyHasRecall(key, id);
    const tombstone = duplicate ? { appended: false, reason: 'duplicate' } : v2History.appendRecall(key, id);
    let state = null;
    try { state = await v2Store.markRecalled(key, id); }
    catch (error) { return { ok: false, deduped: duplicate, error: String(error?.message ?? error), tombstone }; }
    const cacheKey = `${key}\u0000${id}`;
    recalledMids.add(cacheKey);
    if (recalledMids.size > 512) recalledMids.delete(recalledMids.values().next().value);
    metrics.writes += 1;
    metrics.recalls = (metrics.recalls ?? 0) + 1;
    return { ok: true, deduped: duplicate, tombstone, ...state };
  }

  return {
    store: v2Store,
    history: v2History,
    runtimeConfig,
    consoleToken: tokenInfo,
    metrics: () => ({ ...metrics, store: v2Store.metrics() }),
    matches,
    handleRequest,
    handleHttp,
    recordInbound,
    recordSelfSent,
    recordRecall,
    endpoints: SOCIALV2_ENDPOINTS,
  };
}
