// L0/L1 直接读写 state/social-v2.json（B 方案：不迁移、不复制、不新建第二套存储）。
//
// 关键约束（SOCIALV2-PORT-CONTRACT v1 §3）：
//   * 写必须串行化：进程内单写队列，每次写前重新读整份文件，只改自己负责的字段
//     （recentMessages / unread / L1 四类），最后 temp + rename 原子替换。
//     这样 lifecycle 写入的 wakeConfig.sleepUntil 不会被本模块覆盖。
//   * L0 落盘上限：recentMessages 200、unread 100；运行时读取视图仍按 100 / 30。
//   * L1 上限/过期/promise 状态机复用 production src/memory-lifecycle.mjs 的语义。
//   * 正文进 L1 前统一 redact（已知 agent token），与旧桥 redactKnownTokensOnly 一致。
//
// 本模块不启动服务、不连接 Provider；只做文件读写与纯函数格式化。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  appendPromise, capPromises, normalizeImpression, normalizePromise,
  normalizeSourceMid, reconcileRecalledMemory, updatePromise,
} from './memory-lifecycle.mjs';

export const RECENT_RUNTIME_LIMIT = 100;
export const RECENT_DISK_LIMIT = 200;
export const UNREAD_RUNTIME_LIMIT = 30;
export const UNREAD_DISK_LIMIT = 100;
export const TOPIC_LIMIT = 20;
export const THOUGHT_LIMIT = 20;
export const THOUGHT_TTL_MS = 2 * 60 * 60 * 1000;
export const TOPIC_STALE_MS = 24 * 60 * 60 * 1000;
export const IMPRESSION_LIMIT = 50;
export const MEMORY_CATEGORIES = Object.freeze(['activeTopic', 'pendingThought', 'memberImpression', 'promise']);

export class SocialV2StoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SocialV2StoreError';
    this.code = code;
    this.detail = detail;
  }
}

export function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

/** 与 src/bridge.js:1586 `allowed()` 同语义（deny 优先；allow 非空则必须命中；空则看 allowAllWhenEmpty）。 */
export function allowed(kind, id, cfg = {}) {
  const s = String(id);
  const denyList = cfg?.deny?.[kind] ?? cfg?.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg?.allow?.[kind] ?? cfg?.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg?.allowAllWhenEmpty === true;
}

export function isKeyAllowedByConfig(key, cfg = {}) {
  const canonical = canonicalV2Key(key);
  if (!canonical) return false;
  const [kind, id] = canonical.split(':');
  return allowed(kind, id, cfg);
}

/** 与 src/md-to-plain.js truncateText 同语义（按 UTF-16 码元，避开孤立代理）。 */
export function truncateText(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) {
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}

export function normalizeSpeakerIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v)).filter((v) => /^\d+$/.test(v)))].slice(0, 20);
}

export function computeWakeSafety(wc, now = Date.now()) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke
    || (Array.isArray(tr.keywords) && tr.keywords.length > 0)
    || normalizeSpeakerIds(tr.speakerIds).length > 0;
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now;
  const soft = Number(tr.probability) > 0;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed: hard || timed || soft, stale };
}

export function isSleepingConfig(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true;
}

const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

export function preSleepWaitBlocked(conversation, config = {}, now = Date.now()) {
  if (!conversation) return false;
  const w = config?.socialV2?.wake ?? {};
  if (w.preSleepWaitEnabled === false) return false;
  const recent = Array.isArray(conversation.recentMessages) ? conversation.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (last && EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''))) return false;
  const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
  if ((conversation.lastIncomingAt || 0) && now - conversation.lastIncomingAt >= waitMs) return false;
  if (conversation.preSleepWaitSatisfiedAt && (!conversation.lastIncomingAt || conversation.lastIncomingAt <= conversation.preSleepWaitSatisfiedAt)) return false;
  if (conversation.preSleepWaitObservedAt && (!conversation.lastIncomingAt || conversation.lastIncomingAt <= conversation.preSleepWaitObservedAt)) return false;
  return true;
}

function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|示例显示名A|示例显示名B|示例显示名C|示例称呼A|示例称呼B|示例称呼C|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

/** 与 src/bridge.js:11065 `formatMemoryV2` 同结构。 */
export function formatMemory(conversation, now = Date.now()) {
  if (!conversation) return '';
  const lines = [];
  const topics = Array.isArray(conversation.activeTopics) ? conversation.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    lines.push('【进行中的话题】');
    for (const t of topics.slice(-10)) {
      const ago = t.lastMentionAt ? Math.round((now - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && now - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
      lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
    }
  }
  const promises = Array.isArray(conversation.promises) ? conversation.promises.filter((p) => p && (p.status ?? 'open') === 'open' && String(p.text || '').trim()) : [];
  if (promises.length) {
    lines.push('【答应过的事】');
    for (const p of promises.slice(-10)) {
      const ms = Number(p.createdAt);
      const when = ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : '';
      const dueMs = Number(p.dueAt);
      const due = dueMs > 0 && dueMs <= 8.64e15 ? `；期限 ${new Date(dueMs).toISOString().slice(0, 10)}` : '';
      lines.push(`- ${p.text}${when ? `（${when} 记下${due}）` : ''}`);
    }
  }
  const thoughts = Array.isArray(conversation.pendingThoughts) ? conversation.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < t.expiresAt)) : [];
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts.slice(-10)) lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
  }
  const impressions = conversation.memberImpressions && typeof conversation.memberImpressions === 'object' ? conversation.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length) {
    lines.push('【对群友的印象】');
    for (const name of names.slice(-10)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
    }
  }
  return lines.join('\n');
}

/** 与 src/bridge.js:11016 `formatParticipationV2` 同结构（纯提示字符串）。 */
export function formatParticipation(conversation, now = Date.now()) {
  if (!conversation) return '';
  const hour = 60 * 60 * 1000;
  const fiveMin = 5 * 60 * 1000;
  const recent = Array.isArray(conversation.recentMessages) ? conversation.recentMessages : [];
  const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
  const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
  if (!aiCount && !otherCount) return '';
  const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
  const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
  const directUnread = Array.isArray(conversation.unread) ? conversation.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
  const lastAiGap = now - (Number(conversation.lastAiReplyAt) || 0);
  const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
  let hint = '';
  if (directUnread > 0) hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
  else if (recentAi2m >= 2) hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
  else if (lastAiGap < 120000) hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
  else if (aiCount >= 5) hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
  else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
  else if (otherCount >= 10 && aiCount === 0) hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
  else if (otherCount < 3 && aiCount > 0) hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
  else if (aiCount <= 1 && otherCount >= 10) hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
  const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
  return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
}

export function suggestQuietMs(conversation, config = {}, now = Date.now()) {
  const defaultMs = Number(config?.socialV2?.wait?.defaultQuietMs) || 8000;
  if (!conversation) return defaultMs;
  const recent = Array.isArray(conversation.recentMessages) ? conversation.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return defaultMs;
  const text = String(last.tail || last.plain || last.text || '').trim();
  if (/(\.\.\.|…|，|,|、|；|;|：|:)$/.test(text)) return 12000;
  const burst = recent.filter((m) => m && !m.isSelf && now - Number(m.time || 0) < 15000).length;
  if (burst >= 3) return 12000;
  return defaultMs;
}

export function replyTiming(conversation, config = {}, now = Date.now()) {
  const minimum = Number(config?.socialV2?.wait?.minQuietAfterNewMs);
  const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
  const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(config?.socialV2?.wait?.maxMs) || 600000));
  const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMs(conversation, config, now)) || 0));
  const value = Number(conversation?.lastIncomingAt);
  const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, now - value) : 0;
  return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

// ── 统一写入锁 / 单写入口（发布前闸门①） ───────────────────────────────────
//
// 规则：
//   * state/social-v2.json.lock 用 O_EXCL 创建；内容只有 pid / 时间 / host 元数据。
//   * 锁内 read-modify-write，按字段归属合并；未知字段始终保留。
//   * 崩溃残留按 staleMs（默认 10s）回收；抢锁 50ms × 20 次有界重试；拿不到
//     就抛 SOCIAL_V2_LOCK_TIMEOUT，绝不绕过锁直接写。
//   * 只记锁元数据计数，不记消息正文。
export const DEFAULT_STATE_LOCK_STALE_MS = 10_000;
export const DEFAULT_STATE_LOCK_RETRY_MS = 50;
export const DEFAULT_STATE_LOCK_RETRIES = 20;

export const STATE_OWNERSHIP = Object.freeze({
  lifecycleRootFields: Object.freeze(['paused']),
  lifecycleConversationFields: Object.freeze(['lastIncomingAt', 'wakeConfig']),
  lifecycleWakeScheduleFields: Object.freeze(['mode', 'sleepUntil', 'triggers', 'batchWindowMs', 'lastWakeAt', 'wakeCount', 'infinite']),
  storeConversationFields: Object.freeze([
    'recentMessages', 'unread', 'activeTopics', 'pendingThoughts', 'memberImpressions', 'promises', 'agentToken',
    // L0 游标：不在 lead 的已知归属清单里，但 recent/unread 的 seq 与 readThrough 必须由同一 L0 写者维护；
    // 它们不属于 lifecycle 的 paused/lastIncomingAt/wakeConfig，单独列为 store 扩展字段（报告里明示）。
    'lastUnreadSeq', 'lastReadThroughSeq',
  ]),
  wakeConfirmationFields: Object.freeze(['confirmedAt', 'confirmedBy', 'noActionCount']),
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeWakeConfig(diskWc, draftWc, owner, options = {}) {
  const base = isPlainObject(diskWc) ? clone(diskWc) : {};
  const draft = isPlainObject(draftWc) ? draftWc : {};
  if (owner === 'lifecycle') {
    for (const field of STATE_OWNERSHIP.lifecycleWakeScheduleFields) {
      if (field in draft) base[field] = clone(draft[field]);
    }
    if (isPlainObject(draft.triggers)) {
      base.triggers = { ...(isPlainObject(base.triggers) ? base.triggers : {}), ...clone(draft.triggers) };
    }
    if (options.includeConfirmation === true) {
      for (const field of STATE_OWNERSHIP.wakeConfirmationFields) {
        if (field in draft) base[field] = clone(draft[field]);
      }
    }
  } else {
    // store：只合并确认类；mode/infinite 仅在调用方显式声明时才允许（mark-read 默认不写）。
    for (const field of STATE_OWNERSHIP.wakeConfirmationFields) {
      if (field in draft) base[field] = clone(draft[field]);
    }
    if (options.allowWakeMode === true) {
      for (const field of ['mode', 'infinite']) {
        if (field in draft) base[field] = clone(draft[field]);
      }
    }
  }
  return base;
}

/**
 * 字段级合并：以磁盘为基线，只应用 owner 拥有的字段。
 * owner: 'lifecycle' | 'store'
 */
export function mergeOwnedState(disk, draft, owner, options = {}) {
  const base = clone(disk);
  if (!isPlainObject(base.conversations)) base.conversations = {};
  if (!isPlainObject(draft) || !isPlainObject(draft.conversations)) return base;
  if (owner === 'lifecycle') {
    if (Object.prototype.hasOwnProperty.call(draft, 'paused')) base.paused = draft.paused === true;
  }
  for (const [key, draftConv] of Object.entries(draft.conversations)) {
    if (!isPlainObject(draftConv)) continue;
    const diskConv = isPlainObject(base.conversations[key]) ? base.conversations[key] : null;
    if (!diskConv) continue; // 不凭空创建会话；未知字段只在已有会话内保留
    if (owner === 'lifecycle') {
      const incoming = Number(draftConv.lastIncomingAt);
      const current = Number(diskConv.lastIncomingAt) || 0;
      if (Number.isFinite(incoming) && incoming >= current) diskConv.lastIncomingAt = incoming;
      if ('wakeConfig' in draftConv) {
        diskConv.wakeConfig = mergeWakeConfig(diskConv.wakeConfig, draftConv.wakeConfig, 'lifecycle', options);
      }
    } else {
      for (const field of STATE_OWNERSHIP.storeConversationFields) {
        if (Object.prototype.hasOwnProperty.call(draftConv, field)) diskConv[field] = clone(draftConv[field]);
      }
      const incoming = Number(draftConv.lastIncomingAt);
      const current = Number(diskConv.lastIncomingAt) || 0;
      // lastIncomingAt：store 可写，但必须单调递增。
      if (Number.isFinite(incoming) && incoming >= current) diskConv.lastIncomingAt = incoming;
      if ('wakeConfig' in draftConv) {
        diskConv.wakeConfig = mergeWakeConfig(diskConv.wakeConfig, draftConv.wakeConfig, 'store', options);
      }
    }
  }
  return base;
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 跨进程单写入口：锁内 read-modify-write，按字段归属合并。
 * 同步 API（lifecycle 的 persistState 是同步的）；store 的 async mutate 直接调用它。
 */
export function createSocialV2StateWriter({
  stateFile,
  lockFile = null,
  staleMs = DEFAULT_STATE_LOCK_STALE_MS,
  retryMs = DEFAULT_STATE_LOCK_RETRY_MS,
  retries = DEFAULT_STATE_LOCK_RETRIES,
  renameRetries = 10,
  renameRetryMs = 10,
  now = () => Date.now(),
  logger = () => {},
  pid = process.pid,
  host = os.hostname(),
  fsImpl = fs,
  writeFileSyncImpl = fs.writeFileSync,
  renameSyncImpl = fs.renameSync,
} = {}) {
  if (!stateFile) throw new Error('stateFile required');
  const file = path.resolve(stateFile);
  const lockPath = lockFile ? path.resolve(lockFile) : `${file}.lock`;
  const metrics = {
    acquired: 0, writes: 0, waits: 0, timeouts: 0, staleRecovered: 0,
    lastWaitMs: 0, maxWaitMs: 0, lastError: null, lastWriteAt: 0,
  };
  let held = false;

  function readState() {
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      throw new SocialV2StoreError('state-missing', `social-v2.json 不可读：${error?.message ?? error}`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let raw;
    try { raw = JSON.parse(text); } catch (error) {
      throw new SocialV2StoreError('invalid-state', `social-v2.json 不是合法 JSON：${error?.message ?? error}`);
    }
    if (!isPlainObject(raw)) throw new SocialV2StoreError('invalid-state', 'social-v2.json 根节点必须是对象');
    if (!isPlainObject(raw.conversations)) raw.conversations = {};
    return raw;
  }

  function writeStateAtomic(raw) {
    const tmp = `${file}.tmp-${pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      writeFileSyncImpl(tmp, JSON.stringify(raw, null, 2), 'utf8');
      // Windows 上目标文件被杀软/其它读句柄短暂占用时 rename 会抛 EPERM/EBUSY；
      // 锁仍持有，短重试后仍是原子替换，绝不改成非原子覆盖。
      let lastError = null;
      for (let attempt = 0; attempt < Math.max(1, Number(renameRetries) || 1); attempt += 1) {
        try {
          renameSyncImpl(tmp, file);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
          if (attempt < Math.max(1, Number(renameRetries) || 1) - 1) sleepSync(Number(renameRetryMs) || 0);
        }
      }
      if (lastError) throw lastError;
      metrics.writes += 1;
      metrics.lastWriteAt = Number(now());
    } catch (error) {
      try { fsImpl.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw new SocialV2StoreError('write-failed', `social-v2.json 写入失败：${error?.message ?? error}`);
    }
  }

  function lockIsStale() {
    try {
      const stat = fsImpl.statSync(lockPath);
      let createdMs = Number.NaN;
      try {
        const meta = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8'));
        createdMs = Number(meta?.createdAtMs);
        if (!Number.isFinite(createdMs)) createdMs = Date.parse(meta?.startedAt ?? '');
      } catch { /* malformed lock: use mtime */ }
      if (!Number.isFinite(createdMs)) createdMs = Number(stat.mtimeMs);
      return Number(now()) - createdMs > Number(staleMs);
    } catch {
      return false; // lock disappeared between EEXIST and stat
    }
  }

  function acquireLock() {
    const startedAt = Number(now());
    let staleRecoveries = 0;
    for (let attempt = 0; attempt < Math.max(1, Number(retries) || 1); attempt += 1) {
      try {
        const fd = fsImpl.openSync(lockPath, 'wx');
        try {
          fsImpl.writeFileSync(fd, JSON.stringify({
            pid, host, startedAt: new Date(Number(now())).toISOString(), createdAtMs: Number(now()), stateFile: file,
          }), 'utf8');
        } finally {
          fsImpl.closeSync(fd);
        }
        held = true;
        metrics.acquired += 1;
        metrics.lastWaitMs = Number(now()) - startedAt;
        metrics.maxWaitMs = Math.max(metrics.maxWaitMs, metrics.lastWaitMs);
        return { lockPath, waitedMs: metrics.lastWaitMs, attempts: attempt + 1 };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new SocialV2StoreError('lock-failed', `拿锁失败：${error?.message ?? error}`);
        metrics.waits += 1;
        if (lockIsStale() && staleRecoveries < 3) {
          try { fsImpl.unlinkSync(lockPath); } catch { /* another process may have recovered it */ }
          metrics.staleRecovered += 1;
          staleRecoveries += 1;
          logger({ event: 'social-v2-lock-stale-recovered', lockPath, pid, staleMs: Number(staleMs) });
          attempt -= 1; // 回收 stale 不消耗正常重试预算
          continue;
        }
        if (attempt < Math.max(1, Number(retries) || 1) - 1) sleepSync(Number(retryMs) || 0);
      }
    }
    metrics.timeouts += 1;
    metrics.lastError = 'SOCIAL_V2_LOCK_TIMEOUT';
    const waitedMs = Number(now()) - startedAt;
    metrics.lastWaitMs = waitedMs;
    metrics.maxWaitMs = Math.max(metrics.maxWaitMs, waitedMs);
    logger({ event: 'social-v2-lock-timeout', lockPath, pid, retries: Number(retries), retryMs: Number(retryMs), waitedMs });
    throw new SocialV2StoreError('SOCIAL_V2_LOCK_TIMEOUT', `social-v2.json 写入锁超时（${waitedMs}ms）：${lockPath}`, {
      lockPath, attempts: Number(retries), waitedMs,
    });
  }

  function releaseLock() {
    if (!held) return;
    held = false;
    try { fsImpl.unlinkSync(lockPath); } catch { /* another recovery may have removed it */ }
  }

  /** 锁内 read-modify-write。mutator 在整份磁盘快照上修改，返回结果原样透传。 */
  function mutate(owner, mutator, options = {}) {
    if (owner !== 'lifecycle' && owner !== 'store') throw new Error(`unknown state owner: ${owner}`);
    if (typeof mutator !== 'function') throw new Error('mutator required');
    acquireLock();
    try {
      const disk = readState();
      const draft = clone(disk);
      const result = mutator(draft, clone(disk));
      const merged = mergeOwnedState(disk, draft, owner, options);
      writeStateAtomic(merged);
      return result;
    } finally {
      releaseLock();
    }
  }

  return {
    stateFile: file,
    lockPath,
    read: readState,
    mutate,
    metrics: () => ({ ...metrics }),
    held: () => held,
    ownership: STATE_OWNERSHIP,
  };
}


/**
 * @param {{stateFile:string, recentDiskLimit?:number, unreadDiskLimit?:number,
 *   now?:()=>number, logger?:Function, writeFileSyncImpl?:Function,
 *   renameSyncImpl?:Function, knownTokens?:string[]}} options
 */
export function createSocialV2Store({
  stateFile,
  stateWriter = null,
  lockFile = null,
  staleMs = DEFAULT_STATE_LOCK_STALE_MS,
  retryMs = DEFAULT_STATE_LOCK_RETRY_MS,
  retries = DEFAULT_STATE_LOCK_RETRIES,
  recentDiskLimit = RECENT_DISK_LIMIT,
  unreadDiskLimit = UNREAD_DISK_LIMIT,
  now = () => Date.now(),
  logger = () => {},
  writeFileSyncImpl = fs.writeFileSync,
  renameSyncImpl = fs.renameSync,
  knownTokens = [],
} = {}) {
  if (!stateFile) throw new Error('stateFile required');
  const file = path.resolve(stateFile);
  const knownTokenSet = new Set(knownTokens.filter((t) => typeof t === 'string' && t));
  const modelSeen = new Map(); // key -> Set<seq>（与旧桥一致：只在内存，不落盘）
  const metrics = { writes: 0, writeFailures: 0, lastError: null, lastWriteAt: 0, inbound: 0, self: 0, recalls: 0 };
  let chain = Promise.resolve();
  // social-v2.json 的唯一写入入口。Host 会显式注入同一个 writer 给 lifecycle；
  // 独立使用 store 时（测试/单模块）也默认创建带锁 writer，绝无无锁写路径。
  const writer = stateWriter ?? createSocialV2StateWriter({
    stateFile: file, lockFile, staleMs, retryMs, retries, now, logger,
    writeFileSyncImpl, renameSyncImpl,
  });

  function readRaw() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { paused: false, conversations: {} };
      throw error;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let raw;
    try { raw = JSON.parse(text); } catch (error) {
      throw new SocialV2StoreError('invalid-state', `social-v2.json 不是合法 JSON：${error?.message ?? error}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SocialV2StoreError('invalid-state', 'social-v2.json 根节点必须是对象');
    if (!raw.conversations || typeof raw.conversations !== 'object') raw.conversations = {};
    // 已知 token 集合：每次读都吸收当前所有会话 token（旧桥还有上一代；重启/跨进程无法恢复，见报告 UNKNOWN）
    absorbKnownTokens(raw);
    return raw;
  }

  function absorbKnownTokens(raw) {
    for (const st of Object.values(raw?.conversations ?? {})) {
      if (st && typeof st.agentToken === 'string' && st.agentToken) knownTokenSet.add(st.agentToken);
    }
  }

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  function mutate(key, mutator, { reason = 'mutate', includeConfirmation = false, allowWakeMode = false } = {}) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return Promise.reject(new SocialV2StoreError('invalid-key', `无效的会话 key：${key}`));
    return enqueue(async () => {
      try {
        const result = writer.mutate('store', (draft) => {
          absorbKnownTokens(draft);
          const conversation = draft.conversations[canonical];
          if (!conversation || typeof conversation !== 'object') {
            throw new SocialV2StoreError('not-found', `会话不存在：${canonical}`, { key: canonical });
          }
          return mutator(conversation, draft, canonical);
        }, { reason, includeConfirmation, allowWakeMode });
        metrics.writes += 1;
        metrics.lastWriteAt = Number(now());
        return result;
      } catch (error) {
        metrics.writeFailures += 1;
        metrics.lastError = String(error?.message ?? error);
        throw error;
      }
    });
  }

  function redact(text) {
    let s = String(text ?? '');
    for (const token of knownTokenSet) if (token && s.includes(token)) s = s.split(token).join('***');
    return s;
  }

  function readConversation(key) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return null;
    const raw = readRaw();
    const conversation = raw.conversations[canonical];
    if (!conversation || typeof conversation !== 'object') return null;
    return { raw, conversation: clone(conversation), key: canonical };
  }

  /** 与旧桥 store 的运行时视图一致：recent 100 / unread 30。 */
  function effectiveRecent(conversation) {
    return Array.isArray(conversation?.recentMessages) ? conversation.recentMessages.slice(-RECENT_RUNTIME_LIMIT) : [];
  }
  function effectiveUnread(conversation) {
    return Array.isArray(conversation?.unread) ? conversation.unread.slice(-UNREAD_RUNTIME_LIMIT) : [];
  }

  function conversationToken(key) {
    const snapshot = readConversation(key);
    return snapshot?.conversation?.agentToken ? String(snapshot.conversation.agentToken) : null;
  }

  function tokenMatches(key, token) {
    const expected = conversationToken(key);
    if (typeof token !== 'string' || !token || !expected) return false;
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function noteSeen(key, messages) {
    const canonical = canonicalV2Key(key);
    if (!canonical || !Array.isArray(messages)) return;
    const snapshot = readConversation(canonical);
    const unread = new Set((snapshot?.conversation?.unread ?? []).map((m) => m?.seq).filter(Number.isSafeInteger));
    let set = modelSeen.get(canonical);
    if (!set) { set = new Set(); modelSeen.set(canonical, set); }
    for (const seq of [...set]) if (!unread.has(seq)) set.delete(seq);
    for (const message of messages) if (Number.isSafeInteger(message?.seq) && unread.has(message.seq)) set.add(message.seq);
  }

  function readThroughSeq(conversation, additional = [], key = null) {
    const canonical = canonicalV2Key(key);
    const seen = new Set(canonical ? (modelSeen.get(canonical) ?? []) : []);
    for (const message of additional) if (Number.isSafeInteger(message?.seq) && message.seq > 0) seen.add(message.seq);
    const unread = Array.isArray(conversation?.unread) ? conversation.unread : [];
    const seqs = unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(conversation?.lastUnreadSeq) ? conversation.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(conversation?.lastReadThroughSeq) ? conversation.lastReadThroughSeq : 0;
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function requestedReadThrough(conversation, body, key) {
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = readThroughSeq(conversation, [], key);
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > (Number(conversation?.lastUnreadSeq) || 0)) {
      throw new SocialV2StoreError('invalid-argument', 'throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
    }
    return seq;
  }

  function acknowledge(conversation, throughSeq) {
    const before = Array.isArray(conversation.unread) ? conversation.unread.length : 0;
    if (throughSeq === null) {
      conversation.unread = [];
      conversation.lastReadThroughSeq = Number(conversation.lastUnreadSeq) || 0;
    } else {
      conversation.unread = (conversation.unread ?? []).filter((m) => !Number.isSafeInteger(m?.seq) || m.seq > throughSeq);
      conversation.lastReadThroughSeq = Math.max(Number(conversation.lastReadThroughSeq) || 0, throughSeq);
    }
    return before - (conversation.unread?.length ?? 0);
  }

  function wakeConfigOf(conversation) {
    return conversation?.wakeConfig && typeof conversation.wakeConfig === 'object' ? conversation.wakeConfig : {};
  }

  function appendInbound(key, {
    sender = '', userId = null, text = '', isOwner = false, messageId = null,
    time = Number(now()), kind = 'text', media = [], forwardIds = [], quoteTargetIsSelf = false,
  } = {}) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return Promise.reject(new SocialV2StoreError('invalid-key', `无效的会话 key：${key}`));
    metrics.inbound += 1;
    return mutate(canonical, (conversation) => {
      const seq = (Number(conversation.lastUnreadSeq) || 0) + 1;
      const textSafe = truncateText(String(text ?? ''), 200);
      const message = {
        seq,
        messageId: messageId != null ? String(messageId) : null,
        sender: String(sender ?? ''),
        userId: userId != null ? String(userId) : null,
        text: textSafe,
        plain: textSafe,
        tail: textSafe,
        quoteTargetIsSelf: !!quoteTargetIsSelf,
        isOwner: !!isOwner,
        ownerLabel: isOwner ? '管理员' : '',
        isSelf: false,
        media: Array.isArray(media) ? media.map((m) => ({ ...m })).slice(0, 8) : [],
        hasMedia: Array.isArray(media) && media.length > 0,
        forwardIds: Array.isArray(forwardIds) ? forwardIds.map(String).slice(0, 8) : [],
        hasForward: Array.isArray(forwardIds) && forwardIds.length > 0,
        kind: String(kind || 'text').slice(0, 12),
        time: Number(time) || Number(now()),
      };
      conversation.lastUnreadSeq = seq;
      // lastIncomingAt 由 store 写但必须单调递增（writer 合并层还会再兜一次）。
      conversation.lastIncomingAt = Math.max(Number(conversation.lastIncomingAt) || 0, message.time);
      // preSleepWait* 不属于 store 的已知归属，保留磁盘现值，不在这里改写。
      if (!Array.isArray(conversation.recentMessages)) conversation.recentMessages = [];
      if (!Array.isArray(conversation.unread)) conversation.unread = [];
      conversation.recentMessages.push(message);
      if (conversation.recentMessages.length > recentDiskLimit) conversation.recentMessages.splice(0, conversation.recentMessages.length - recentDiskLimit);
      conversation.unread.push(message);
      if (conversation.unread.length > unreadDiskLimit) conversation.unread.splice(0, conversation.unread.length - unreadDiskLimit);
      return message;
    }, { reason: 'inbound' });
  }

  function appendSelf(key, { text = '', messageId = null, time = Number(now()), kind = 'text' } = {}) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return Promise.reject(new SocialV2StoreError('invalid-key', `无效的会话 key：${key}`));
    metrics.self += 1;
    return mutate(canonical, (conversation) => {
      const textSafe = truncateText(redact(String(text ?? '')), 200);
      const message = {
        messageId: messageId != null ? String(messageId) : null,
        sender: '我', text: textSafe, plain: textSafe, tail: textSafe,
        quoteTargetIsSelf: false, isOwner: true, ownerLabel: '我', isSelf: true,
        kind: String(kind || 'text').slice(0, 12), time: Number(time) || Number(now()),
      };
      if (!Array.isArray(conversation.recentMessages)) conversation.recentMessages = [];
      conversation.recentMessages.push(message);
      if (conversation.recentMessages.length > recentDiskLimit) conversation.recentMessages.splice(0, conversation.recentMessages.length - recentDiskLimit);
      // preSleepWait* / lastAiReplyAt 不属于 store 已知归属，保留现值。
      return message;
    }, { reason: 'self-sent' });
  }

  function markRead(key, throughSeq, { isAgent = true } = {}) {
    void isAgent;
    return mutate(key, (conversation) => {
      const markedCount = acknowledge(conversation, throughSeq);
      // lastActionAt 不在已知归属里，保留；wakeConfig 只合并确认类字段。
      const wc = wakeConfigOf(conversation);
      wc.noActionCount = 0;
      wc.confirmedAt = Number(now());
      wc.confirmedBy = 'mark_read';
      conversation.wakeConfig = wc;
      const safety = computeWakeSafety(wc);
      return {
        markedCount,
        unreadCount: effectiveUnread(conversation).length,
        readThroughSeq: readThroughSeq(conversation, [], key),
        wakeGuaranteed: safety.guaranteed,
        wakeSafety: safety,
        wakeConfig: clone(wc),
      };
    }, { reason: 'mark-read' });
  }

  // ── L1 记忆 ───────────────────────────────────────────────────────────────
  function cleanupMemory(conversation) {
    const at = Number(now());
    if (Array.isArray(conversation.pendingThoughts)) {
      conversation.pendingThoughts = conversation.pendingThoughts.filter((t) => t && (!t.expiresAt || at < Number(t.expiresAt)));
    }
    if (Array.isArray(conversation.activeTopics)) {
      conversation.activeTopics = conversation.activeTopics.filter((t) => t && (!t.lastMentionAt || at - Number(t.lastMentionAt) < TOPIC_STALE_MS));
    }
  }

  function appendMemoryTo(conversation, category, content, extra = {}) {
    const at = Number(now());
    const text = redact(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    cleanupMemory(conversation);
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(conversation.activeTopics)) conversation.activeTopics = [];
      const existing = conversation.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = at;
        if (normalizeSourceMid(extra.sourceMid)) existing.sourceMid = normalizeSourceMid(extra.sourceMid);
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redact(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redact(String(extra.pendingQuestion)), 200);
      } else {
        conversation.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: at,
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redact(String(p))).slice(0, 10) : [],
          pendingQuestion: redact(String(extra.pendingQuestion || '')).slice(0, 200),
          ...(normalizeSourceMid(extra.sourceMid) ? { sourceMid: normalizeSourceMid(extra.sourceMid) } : {}),
        });
      }
      if (conversation.activeTopics.length > TOPIC_LIMIT) conversation.activeTopics.splice(0, conversation.activeTopics.length - TOPIC_LIMIT);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(conversation.pendingThoughts)) conversation.pendingThoughts = [];
      const existing = conversation.pendingThoughts.find((t) => t && String(t.text || '') === text);
      const ttl = Number(extra.expiresAtMs) || THOUGHT_TTL_MS;
      if (existing) {
        existing.createdAt = at;
        existing.expiresAt = at + ttl;
        if (normalizeSourceMid(extra.sourceMid)) existing.sourceMid = normalizeSourceMid(extra.sourceMid);
        if (extra.motivation) existing.motivation = redact(String(extra.motivation)).slice(0, 50);
      } else {
        conversation.pendingThoughts.push({
          text: text.slice(0, 200), createdAt: at, expiresAt: at + ttl,
          motivation: redact(String(extra.motivation || 'curiosity')).slice(0, 50),
          ...(normalizeSourceMid(extra.sourceMid) ? { sourceMid: normalizeSourceMid(extra.sourceMid) } : {}),
        });
      }
      if (conversation.pendingThoughts.length > THOUGHT_LIMIT) conversation.pendingThoughts.splice(0, conversation.pendingThoughts.length - THOUGHT_LIMIT);
    } else if (cat === 'promise' && text) {
      appendPromise(conversation, truncateText(text, 200), extra, at);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!conversation.memberImpressions || typeof conversation.memberImpressions !== 'object') conversation.memberImpressions = {};
      const old = normalizeImpression(conversation.memberImpressions[target] || {});
      const traits = old.traits.slice(0, 10);
      const trait = text.slice(0, 50);
      const sourceMid = normalizeSourceMid(extra.sourceMid);
      if (trait && !traits.includes(trait)) traits.push(trait);
      if (trait) {
        old.traitSources ??= Object.create(null);
        old.unsourcedTraits ??= [];
        if (sourceMid) old.traitSources[trait] = [...new Set([...(old.traitSources[trait] || []), sourceMid])].slice(0, 8);
        else if (!old.traitSources[trait]?.length && !old.unsourcedTraits.includes(trait)) old.unsourcedTraits.push(trait);
      }
      conversation.memberImpressions[target] = normalizeImpression({
        ...old, traits: traits.slice(-10), interactionCount: old.interactionCount + 1, lastSeenAt: at,
      });
      const entries = Object.entries(conversation.memberImpressions);
      if (entries.length > IMPRESSION_LIMIT) {
        entries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < entries.length - IMPRESSION_LIMIT; i += 1) delete conversation.memberImpressions[entries[i][0]];
      }
    }
  }

  function memoryAppend(key, category, content, extra = {}) {
    return mutate(key, (conversation) => {
      appendMemoryTo(conversation, category, content, extra);
      return { memory: formatMemory(conversation), conversation: clone(conversation) };
    }, { reason: 'memory-append' });
  }

  function memoryUpdate(key, category, oldContent, newContent, cleanExtra = {}, target = '') {
    return mutate(key, (conversation) => {
      if (category === 'activeTopic' && Array.isArray(conversation.activeTopics)) {
        const idx = conversation.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) throw new SocialV2StoreError('not-found', '找不到要编辑的 activeTopic');
        if (newContent !== undefined) conversation.activeTopics[idx].text = newContent.slice(0, 200);
        if (cleanExtra.pendingQuestion !== undefined) conversation.activeTopics[idx].pendingQuestion = String(cleanExtra.pendingQuestion).slice(0, 200);
        if (Array.isArray(cleanExtra.participants)) conversation.activeTopics[idx].participants = cleanExtra.participants.map(String).slice(0, 10);
      } else if (category === 'pendingThought' && Array.isArray(conversation.pendingThoughts)) {
        const idx = conversation.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) throw new SocialV2StoreError('not-found', '找不到要编辑的 pendingThought');
        if (newContent !== undefined) conversation.pendingThoughts[idx].text = newContent.slice(0, 200);
        if (cleanExtra.motivation !== undefined) conversation.pendingThoughts[idx].motivation = String(cleanExtra.motivation).slice(0, 50);
        if (cleanExtra.expiresAtMs !== undefined) conversation.pendingThoughts[idx].expiresAt = Number(now()) + Math.max(0, Number(cleanExtra.expiresAtMs) || 0);
      } else if (category === 'promise' && Array.isArray(conversation.promises)) {
        const idx = conversation.promises.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) throw new SocialV2StoreError('not-found', '找不到要编辑的 promise');
        try {
          updatePromise(conversation.promises[idx], {
            newContent, status: cleanExtra.status, dueAt: cleanExtra.dueAt, sourceMid: cleanExtra.sourceMid,
          }, Number(now()));
          conversation.promises = capPromises(conversation.promises);
        } catch (error) {
          throw new SocialV2StoreError('invalid-argument', String(error?.message ?? error));
        }
      } else if (category === 'memberImpression' && conversation.memberImpressions && typeof conversation.memberImpressions === 'object') {
        const oldTarget = target;
        if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) throw new SocialV2StoreError('invalid-argument', '非法的群友名字');
        if (!Object.prototype.hasOwnProperty.call(conversation.memberImpressions, oldTarget)) throw new SocialV2StoreError('not-found', '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）');
        let im = conversation.memberImpressions[oldTarget];
        const newTarget = String(cleanExtra.target || oldTarget).trim().slice(0, 64);
        if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) throw new SocialV2StoreError('invalid-argument', '非法的群友名字');
        if (newContent !== undefined) {
          const previousTraits = new Set(Array.isArray(im.traits) ? im.traits : []);
          const traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
          const unsourcedTraits = new Set(Array.isArray(im.unsourcedTraits) ? im.unsourcedTraits : []);
          for (const trait of traits) if (!previousTraits.has(trait)) unsourcedTraits.add(trait);
          im.traits = traits;
          im.unsourcedTraits = [...unsourcedTraits];
          im = normalizeImpression(im);
          conversation.memberImpressions[oldTarget] = im;
        }
        if (cleanExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanExtra.interactionCount) || 0);
        if (newTarget !== oldTarget) delete conversation.memberImpressions[oldTarget];
        conversation.memberImpressions[newTarget] = im;
        const entries = Object.entries(conversation.memberImpressions);
        if (entries.length > IMPRESSION_LIMIT) {
          entries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
          for (let i = 0; i < entries.length - IMPRESSION_LIMIT; i += 1) delete conversation.memberImpressions[entries[i][0]];
        }
      }
      return { memory: formatMemory(conversation), conversation: clone(conversation) };
    }, { reason: 'memory-update' });
  }

  function memoryRemove(key, category, content, target = '') {
    return mutate(key, (conversation) => {
      if (category === 'activeTopic' && Array.isArray(conversation.activeTopics)) conversation.activeTopics = conversation.activeTopics.filter((t) => String(t?.text ?? '') !== content);
      else if (category === 'pendingThought' && Array.isArray(conversation.pendingThoughts)) conversation.pendingThoughts = conversation.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
      else if (category === 'promise' && Array.isArray(conversation.promises)) conversation.promises = conversation.promises.filter((t) => String(t?.text ?? '') !== content);
      else if (category === 'memberImpression' && conversation.memberImpressions && typeof conversation.memberImpressions === 'object') delete conversation.memberImpressions[target];
      return { memory: formatMemory(conversation), conversation: clone(conversation) };
    }, { reason: 'memory-remove' });
  }

  function memoryClear(key, category) {
    return mutate(key, (conversation) => {
      if (!category || category === 'activeTopic') conversation.activeTopics = [];
      if (!category || category === 'pendingThought') conversation.pendingThoughts = [];
      if (!category || category === 'memberImpression') conversation.memberImpressions = {};
      if (!category || category === 'promise') conversation.promises = [];
      return { memory: formatMemory(conversation), conversation: clone(conversation) };
    }, { reason: 'memory-clear' });
  }

  function memoryQuery(key, category) {
    const snapshot = readConversation(key);
    if (!snapshot) return null;
    const conversation = snapshot.conversation;
    cleanupMemory(conversation);
    const raw = {
      activeTopics: Array.isArray(conversation.activeTopics) ? conversation.activeTopics.slice(-TOPIC_LIMIT) : [],
      pendingThoughts: Array.isArray(conversation.pendingThoughts) ? conversation.pendingThoughts.filter((t) => !t.expiresAt || Number(now()) < t.expiresAt).slice(-THOUGHT_LIMIT) : [],
      memberImpressions: conversation.memberImpressions && typeof conversation.memberImpressions === 'object' ? clone(conversation.memberImpressions) : {},
      promises: capPromises(conversation.promises),
    };
    if (MEMORY_CATEGORIES.includes(category)) {
      if (category !== 'activeTopic') raw.activeTopics = [];
      if (category !== 'pendingThought') raw.pendingThoughts = [];
      if (category !== 'memberImpression') raw.memberImpressions = {};
      if (category !== 'promise') raw.promises = [];
    }
    return { key: snapshot.key, category: category || '', formatted: formatMemory({ ...conversation, ...raw }), raw };
  }

  function markRecalled(key, mid) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return Promise.reject(new SocialV2StoreError('invalid-key', `无效的会话 key：${key}`));
    metrics.recalls += 1;
    return mutate(canonical, (conversation) => {
      const id = String(mid ?? '').trim();
      if (!id) throw new SocialV2StoreError('invalid-argument', 'mid 不能为空');
      let touched = 0;
      for (const listName of ['recentMessages', 'unread']) {
        for (const message of Array.isArray(conversation[listName]) ? conversation[listName] : []) {
          if (!message || message.recalled || String(message.messageId ?? '') !== id) continue;
          message.recalled = true;
          message.text = '[已撤回]';
          message.plain = '[已撤回]';
          message.tail = '[已撤回]';
          message.media = [];
          message.hasMedia = false;
          message.forwardIds = [];
          message.hasForward = false;
          // D4：表情描述同属被撤回内容（旧桥 bridge.js:12327 同语义）。
          if (message.sticker) delete message.sticker;
          touched += 1;
        }
      }
      const removed = reconcileRecalledMemory(conversation, id);
      return { touched, memoryRemoved: removed, conversation: clone(conversation) };
    }, { reason: 'recall' });
  }

  async function safeAppendInbound(key, payload) {
    try {
      const message = await appendInbound(key, payload);
      return { ok: true, message };
    } catch (error) {
      logger(`[social-v2] 入站 L0 写入失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'write-failed' };
    }
  }

  async function safeAppendSelf(key, payload) {
    try {
      const message = await appendSelf(key, payload);
      return { ok: true, message };
    } catch (error) {
      logger(`[social-v2] 自己消息 L0 写入失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'write-failed' };
    }
  }

  return {
    file,
    readRaw,
    readConversation,
    conversationToken,
    tokenMatches,
    redact,
    effectiveRecent,
    effectiveUnread,
    noteSeen,
    readThroughSeq,
    requestedReadThrough,
    wakeConfigOf,
    wakeSafety: computeWakeSafety,
    formatMemory,
    formatParticipation,
    replyTiming: (conversation, config) => replyTiming(conversation, config, Number(now())),
    appendInbound,
    appendSelf,
    markRead,
    memoryQuery,
    memoryAppend,
    memoryUpdate,
    memoryRemove,
    memoryClear,
    markRecalled,
    safeAppendInbound,
    safeAppendSelf,
    reconcileRecalledMemory,
    normalizePromise,
    stateWriter: writer,
    metrics: () => ({ ...metrics, lock: writer.metrics() }),
    _queue: () => chain,
  };
}
