import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeWaitPlan } from 'file:///<WORKSPACE>/';
import { looksLikeUnfinished } from 'file:///<WORKSPACE>/';
import { normalizeWakeConfigPatch } from './wake-config-schema.mjs';
export { normalizeWakeConfigPatch };

export const LEGACY_STATE_VERSION = 'socialV2-v1';
export const DEFAULT_LOCK = 'state/legacy-lifecycle-scheduler.lock';
const TASK_PRIORITY = { replyCheck: 40, timeout: 30, proactiveCheck: 20 };
const TIMER_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck']);
const MAX_TASK_RECORDS = 500;
export const DEFAULT_WAKE_TASK_GRACE_MS = 60000;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function canonicalKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  if (!m) return null;
  const n = String(Number(m[2]));
  if (n === '0') return null;
  return `${m[1]}:${n}`;
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function atomicWrite(file, obj) {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  // Windows 上目标文件可能短暂被杀进程句柄/扫描器占用；EPERM/EBUSY 做有限重试，
  // 不把一次瞬时占用升级成 Host 崩溃。
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(tmp, file); return; } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 6) throw error;
      Atomics.wait(wait, 0, 0, 25 * (attempt + 1));
    }
  }
}

/** Read the existing social-v2.json without creating a new state store. */
export function loadLegacyState(stateFile) {
  const raw = readJson(stateFile, null);
  if (!raw || raw.conversations == null || typeof raw.conversations !== 'object') {
    throw new Error('legacy-social-v2-state-invalid');
  }
  const conversations = {};
  for (const [key, st] of Object.entries(raw.conversations)) {
    const ck = canonicalKey(key);
    if (!ck || !st || typeof st !== 'object') continue;
    conversations[ck] = clone(st);
  }
  return { paused: raw.paused === true, conversations, source: stateFile, schema: LEGACY_STATE_VERSION };
}

export function defaultWakeConfig(config = {}) {
  const w = config?.socialV2?.wake ?? config?.wake ?? {};
  const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
  const defaultInfinite = w.recommendedDefaultInfinite !== false;
  const recMin = Number(w.recommendedSleepMinMs) || 300000;
  const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
  let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
  const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
  const hardMax = Number(w.sleepMaxMs) || 0;
  if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
  if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
  return {
    mode: defaultMode, infinite: defaultInfinite,
    sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
    triggers: {
      atMention: w.recommendedAtMention !== false, nameMention: w.recommendedNameMention !== false,
      speakerIds: [], keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
      question: w.recommendedQuestion !== false, poke: w.recommendedPoke !== false,
      anyMessage: defaultMode === 'active', probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0)),
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: 0, wakeCount: 0, noActionCount: 0, confirmedAt: 0, confirmedBy: 'default',
  };
}

export function computeWakeSafety(wc, now = Date.now()) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke
    || (Array.isArray(tr.keywords) && tr.keywords.length > 0)
    || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > now;
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || now - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard: Boolean(hard), timed: Boolean(timed), soft: Boolean(soft), guaranteed: Boolean(guaranteed), stale: Boolean(stale) };
}

export function nextWakeAt(state, now = Date.now()) {
  if (!state || state.paused) return null;
  let soonest = null;
  for (const [key, st] of Object.entries(state.conversations ?? {})) {
    const wc = st?.wakeConfig;
    if (!wc || wc.infinite) continue;
    const at = Date.parse(wc.sleepUntil ?? '');
    if (!Number.isFinite(at) || at <= now) continue;
    if (soonest == null || at < soonest) soonest = at;
  }
  return soonest == null ? null : new Date(soonest).toISOString();
}

/** Reuse the first-version wakeConfig trigger semantics (pure, no DSH/QQ). */
export function evaluateWakeTriggers(state, key, event = {}, random = Math.random) {
  const ck = canonicalKey(key);
  const st = ck ? state?.conversations?.[ck] : null;
  if (!st) return { wake: false, reason: 'unknown-conversation' };
  if (state.paused) return { wake: false, reason: 'social-v2-paused' };
  const wc = st.wakeConfig || {};
  const tr = wc.triggers || {};
  const text = String(event.raw_message ?? event.text ?? '');
  const userId = String(event.user_id ?? event.userId ?? '');
  const probes = [];
  if (wc.mode === 'active' || tr.anyMessage === true) probes.push('anyMessage');
  if (tr.atMention === true && (event.atMe === true || event.mentioned === true)) probes.push('atMention');
  if (tr.nameMention === true && (event.nameMention === true || /CORE_ENTITY|DeepSeek/i.test(text))) probes.push('nameMention');
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.map(String).includes(userId)) probes.push('speakerId');
  if (Array.isArray(tr.keywords) && tr.keywords.some((k) => k && text.includes(String(k)))) probes.push('keyword');
  if (tr.question === true && /[?？]\s*$/.test(text)) probes.push('question');
  if (tr.poke === true && event.post_type === 'notice' && event.sub_type === 'poke') probes.push('poke');
  if (probes.length) return { wake: true, reason: 'hard-trigger', trigger: probes[0], triggers: probes };
  const p = Math.min(1, Math.max(0, Number(tr.probability) || 0));
  if (p > 0 && random() < p) return { wake: true, reason: 'probability-trigger', trigger: 'probability', probability: p };
  return { wake: false, reason: 'no-trigger' };
}

function proactiveBlocked(config, at = new Date()) {
  const windows = config?.socialV2?.proactive?.blockWindows;
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const day = at.getDay(); const minutes = at.getHours() * 60 + at.getMinutes();
  const parse = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim()); if (!m) return null; const h = Number(m[1]), mm = Number(m[2]); return h < 24 && mm < 60 ? h * 60 + mm : null; };
  for (const w of windows) {
    if (!w || typeof w !== 'object') continue;
    const days = Array.isArray(w.weekdays) ? w.weekdays.map(Number) : [1, 2, 3, 4, 5];
    if (!days.includes(day)) continue;
    const start = parse(w.start), end = parse(w.end);
    if (start == null || end == null || start >= end) continue;
    if (minutes >= start && minutes < end) return true;
  }
  return false;
}
function duePromises(st, now) {
  return Array.isArray(st?.promises) ? st.promises.filter((p) => p && !p.nudgedAt && (!p.dueAt || Number(p.dueAt) <= now)) : [];
}

/**
 * New-Host adapter for first-version socialV2 state, wake, reply-check and
 * proactive timers. Existing state/history is read in place; the adapter is
 * explicit-only, uses one lock, persists pending scheduler tasks separately,
 * and emits all candidates to the Host callback (never DSH or QQ).
 */
export function createLegacyLifecycleAdapter({
  stateFile, lockFile, taskFile, enabled = false, writable = false, diveEnabled, proactiveEnabled, config = {},
  stateWriter = null,
  now = () => Date.now(), onWake = async () => {}, onSkip = null, intervalMs = 0, random = Math.random,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  if (!stateFile) throw new Error('stateFile required');
  const diveOn = diveEnabled === undefined ? enabled === true : diveEnabled === true;
  const proactiveOn = proactiveEnabled === undefined
    ? (diveEnabled === undefined ? enabled === true : false)
    : proactiveEnabled === true;
  const anySchedulerOn = diveOn || proactiveOn;
  const state = loadLegacyState(stateFile);
  if (writable && (!stateWriter || typeof stateWriter.mutate !== 'function')) {
    const error = new Error('STATE_WRITER_REQUIRED: writable legacy lifecycle must be injected a Host state writer');
    error.code = 'STATE_WRITER_REQUIRED';
    throw error;
  }
  const lockPath = lockFile || path.join(path.dirname(stateFile), 'legacy-lifecycle-scheduler.lock');
  const taskPath = taskFile || path.join(path.dirname(stateFile), 'legacy-lifecycle-tasks.json');
  let schedulerEnabled = false; let timer = null; let lockHeld = false;
  const tasks = new Map();
  const completed = [];
  // 每个 key 的调度代际：任何会让旧 sleep-wake 任务失效的事件（入站/重配/新的 dive）
  // 都会 bump；tick/authorizeWake 在真正 emit/发送前比对，旧代际只能被跳过。
  const generations = new Map();
  const skipped = [];
  const generationFor = (key) => {
    const ck = canonicalKey(key);
    return ck ? (generations.get(ck) ?? 0) : 0;
  };
  function bumpGeneration(key) {
    const ck = canonicalKey(key);
    if (!ck) return 0;
    const next = (generations.get(ck) ?? 0) + 1;
    generations.set(ck, next);
    return next;
  }
  function taskGraceMs() {
    const raw = Number(config?.core?.wakeTaskGraceMs ?? config?.socialV2?.wake?.taskGraceMs);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WAKE_TASK_GRACE_MS;
  }
  /** 跳过日志只保留 task ID/时间/原因（以及 key/type），绝不包含 prompt/正文。 */
  function logSkip(entry) {
    const record = {
      taskId: entry?.taskId ?? null,
      type: entry?.type ?? null,
      key: entry?.key ?? null,
      atMs: Number(entry?.atMs ?? now()),
      dueAtMs: entry?.dueAtMs == null ? null : Number(entry.dueAtMs),
      reason: String(entry?.reason ?? 'unknown'),
    };
    skipped.push(record);
    if (skipped.length > MAX_TASK_RECORDS) skipped.shift();
    try { onSkip?.(record); } catch { /* skip logging must not break scheduling */ }
    return record;
  }
  function taskId(type, key, dueAtMs) { return `${type}:${key}:${dueAtMs}`; }
  function persistTasks() {
    if (!writable) return { persisted: false, reason: 'READ_ONLY' };
    const pending = [...tasks.values()].filter((t) => t.status === 'pending');
    atomicWrite(taskPath, { schema: 'legacy-lifecycle-tasks-v1', tasks: pending, completed: completed.slice(-50) });
    return { persisted: true, taskFile: taskPath, pending: pending.length };
  }
  /**
   * 重启恢复（#2）：持久化的 sleep-wake 任务如果已经逾期，只能标记 expired/skipped，
   * 绝不补发。清掉对应的 wakeConfig.sleepUntil，防止 scheduleSleepTasks 再次建任务。
   * 未来任务恢复时采用当前代际（重启后不存在旧 timer）。
   */
  function restoreTasks(nowMs = now()) {
    const raw = readJson(taskPath, null);
    if (!raw || !Array.isArray(raw.tasks)) return { restored: 0, expired: 0 };
    let restored = 0; let expiredCount = 0;
    for (const t of raw.tasks) {
      if (!t || t.status !== 'pending' || !t.id) continue;
      const ck = canonicalKey(t.key); if (!ck) continue;
      const dueAtMs = Number(t.dueAtMs);
      if (t.type === 'sleep-wake' && Number.isFinite(dueAtMs) && dueAtMs <= nowMs) {
        const st = state.conversations[ck];
        if (st?.wakeConfig) st.wakeConfig.sleepUntil = null;
        const record = {
          ...t, key: ck, status: 'expired', reason: 'overdue-on-restart',
          generation: generationFor(ck), completedAtMs: nowMs,
        };
        completed.push(record);
        if (completed.length > MAX_TASK_RECORDS) completed.shift();
        logSkip({ taskId: t.id, type: t.type, key: ck, atMs: nowMs, dueAtMs, reason: 'overdue-on-restart' });
        expiredCount += 1;
        continue;
      }
      const expiresAtMs = Number.isFinite(Number(t.expiresAtMs))
        ? Number(t.expiresAtMs)
        : (t.type === 'sleep-wake' ? dueAtMs + taskGraceMs() : null);
      tasks.set(t.id, {
        ...t, key: ck, status: 'pending',
        generation: generationFor(ck),
        ...(expiresAtMs == null ? {} : { expiresAtMs }),
      });
      restored += 1;
    }
    return { restored, expired: expiredCount };
  }
  function acquireLock() {
    try {
      if (fs.existsSync(lockPath)) {
        let stale = false;
        try {
          const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          const oldPid = Number(old?.pid);
          if (!Number.isInteger(oldPid) || oldPid <= 0) stale = true;
          else { try { process.kill(oldPid, 0); } catch (e) { if (e.code === 'ESRCH') stale = true; } }
        } catch { stale = true; }
        if (stale) { try { fs.unlinkSync(lockPath); } catch { /* another owner may have cleaned it */ } }
      }
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), stateFile }, null, 2));
      fs.closeSync(fd); lockHeld = true; return { ok: true, lockPath, staleRecovered: true };
    } catch (e) { return { ok: false, reason: e.code === 'EEXIST' ? 'LOCK_HELD' : String(e.message), lockPath }; }
  }
  function releaseLock() { if (!lockHeld) return; try { fs.unlinkSync(lockPath); } catch {} lockHeld = false; }
  function persistState({ includeConfirmation = false } = {}) {
    if (!writable) return { persisted: false, reason: 'READ_ONLY' };
    if (!stateWriter || typeof stateWriter.mutate !== 'function') {
      const error = new Error('STATE_WRITER_REQUIRED: refusing to persist social-v2.json without Host state writer');
      error.code = 'STATE_WRITER_REQUIRED';
      throw error;
    }
    // social-v2.json 的唯一写入口：锁内 read-modify-write，字段级合并。
    // 本适配器只写 paused / lastIncomingAt / wakeConfig 的调度面；store 的
    // recentMessages/unread/L1/agentToken 与未知字段由 writer 保留。
    stateWriter.mutate('lifecycle', (draft) => {
      draft.paused = state.paused === true;
      for (const [key, own] of Object.entries(state.conversations ?? {})) {
        const target = draft.conversations[key];
        if (!target || typeof target !== 'object' || !own || typeof own !== 'object') continue;
        if (own.lastIncomingAt !== undefined) target.lastIncomingAt = own.lastIncomingAt;
        if (own.wakeConfig !== undefined) target.wakeConfig = clone(own.wakeConfig);
      }
    }, { includeConfirmation });
    return { persisted: true, stateFile, lock: stateWriter.metrics?.() ?? null };
  }
  function addTask(type, key, dueAtMs, reason, extra = {}) {
    if (!Number.isFinite(dueAtMs)) return null;
    const id = taskId(type, key, dueAtMs);
    if (tasks.has(id)) return tasks.get(id);
    const generation = Number.isFinite(Number(extra.generation)) ? Number(extra.generation) : generationFor(key);
    const expiresAtMs = extra.expiresAtMs != null
      ? Number(extra.expiresAtMs)
      : (type === 'sleep-wake' ? dueAtMs + taskGraceMs() : null);
    const task = {
      id, type, key, dueAtMs, reason, status: 'pending', createdAtMs: now(),
      correlationId: crypto.randomUUID(), generation,
      ...(expiresAtMs == null ? {} : { expiresAtMs }),
      ...extra,
      generation,
      ...(expiresAtMs == null ? {} : { expiresAtMs }),
    };
    tasks.set(id, task); persistTasks(); return task;
  }
  function completeTask(task, outcome = 'completed') {
    if (!task) return;
    tasks.delete(task.id);
    completed.push({ ...task, status: outcome, completedAtMs: now() }); if (completed.length > MAX_TASK_RECORDS) completed.shift();
    persistTasks();
  }
  function cancelTasks(key, type, reason = 'cancelled') {
    for (const t of [...tasks.values()]) if (t.key === key && (!type || t.type === type) && t.status === 'pending') completeTask(t, reason);
  }
  function nextTaskAt(nowMs = now()) {
    let at = null;
    for (const t of tasks.values()) if (t.status === 'pending' && t.dueAtMs > nowMs && (at == null || t.dueAtMs < at)) at = t.dueAtMs;
    return at == null ? null : new Date(at).toISOString();
  }
  function due(nowMs = now()) {
    if (state.paused || !diveOn || !schedulerEnabled) return [];
    return [...tasks.values()]
      .filter((t) => t.status === 'pending' && t.type === 'sleep-wake' && t.dueAtMs <= nowMs)
      .map((t) => ({ key: t.key, dueAt: new Date(t.dueAtMs).toISOString(), reason: 'legacy-timeout', wakeCount: Number(state.conversations[t.key]?.wakeConfig?.wakeCount) || 0 }));
  }
  function scheduleSleepTasks(nowMs = now()) {
    if (!diveOn) return { added: 0, expired: 0 };
    if (state.paused) return { added: 0, expired: 0 };
    let added = 0; let expiredCount = 0;
    for (const [key, st] of Object.entries(state.conversations)) {
      const wc = st.wakeConfig;
      if (!wc || wc.infinite || !wc.sleepUntil) continue;
      const at = Date.parse(wc.sleepUntil);
      if (!Number.isFinite(at)) { wc.sleepUntil = null; continue; }
      if (at <= nowMs) {
        wc.sleepUntil = null;
        logSkip({ taskId: `sleep-wake:${key}:${at}`, type: 'sleep-wake', key, atMs: nowMs, dueAtMs: at, reason: 'overdue-on-start' });
        expiredCount += 1;
        continue;
      }
      if (!addTask('sleep-wake', key, at, 'timeout')) continue;
      added += 1;
    }
    return { added, expired: expiredCount };
  }
  function proactiveConfig() { return config?.socialV2?.proactive ?? {}; }
  function scheduleProactiveTask(key, baseNow = now()) {
    if (!proactiveOn) return null;
    const p = proactiveConfig();
    if (p.enabled === false) return null;
    if (state.paused) return null;
    for (const t of tasks.values()) if (t.key === key && t.type === 'proactive-check' && t.status === 'pending') return t;
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + random() * (max - min));
    return addTask('proactive-check', key, baseNow + delay, 'proactiveCheck');
  }
  function scheduleReply(key, { replyAt = now(), replyId = null, recentMessages = null } = {}) {
    if (!diveOn) return { scheduled: false, blocked: 'DIVE_DISABLED' };
    if (state.paused) return { scheduled: false, blocked: 'SOCIAL_V2_PAUSED' };
    const ck = canonicalKey(key); if (!ck || !state.conversations[ck]) return { scheduled: false, blocked: 'UNKNOWN_CONVERSATION' };
    const st = state.conversations[ck];
    for (const t of tasks.values()) if (t.key === ck && t.type === 'sleep-wake') return { scheduled: false, blocked: 'SLEEP_PENDING' };
    for (const t of tasks.values()) if (t.key === ck && t.type === 'reply-check' && t.status === 'pending') return { scheduled: false, deduped: true, taskId: t.id };
    const self = Array.isArray(recentMessages) ? recentMessages.filter((m) => m && m.isSelf) : (Array.isArray(st.recentMessages) ? st.recentMessages.filter((m) => m && m.isSelf) : []);
    let delay = Math.max(1000, Number(config?.socialV2?.autoReplyCheckMs) || 30000);
    if (self.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')))) delay = Math.round(delay * 1.5);
    if (self.length >= 3) delay = Math.round(delay * 1.3);
    const task = addTask('reply-check', ck, Number(replyAt) + delay, 'replyCheck', { replyId, delayMs: delay });
    return { scheduled: true, task };
  }
  function cancelReply(key, reason = 'cancelled') { const ck = canonicalKey(key); if (ck) cancelTasks(ck, 'reply-check', reason); }
  function cancelDive(key, reason = 'cancelled') {
    const ck = canonicalKey(key); if (!ck) return { cancelled: false, reason: 'UNKNOWN_CONVERSATION' };
    const generation = bumpGeneration(ck);
    cancelTasks(ck, 'sleep-wake', reason);
    const st = state.conversations[ck];
    if (st?.wakeConfig?.sleepUntil) { st.wakeConfig.sleepUntil = null; persistState(); }
    return { cancelled: true, key: ck, generation };
  }
  function noteIncoming(key, at = now()) {
    const ck = canonicalKey(key); const st = ck ? state.conversations[ck] : null;
    if (!st) return { noted: false, reason: 'UNKNOWN_CONVERSATION' };
    // 入站是「旧 sleep-wake 任务失效」的强信号：即使调用方忘了 cancelDive，
    // 旧代际的 timer/task 也不能再触发潜水。
    const generation = bumpGeneration(ck);
    st.lastIncomingAt = at;
    cancelTasks(ck, 'proactive-check', 'rescheduled-by-incoming');
    const next = scheduleProactiveTask(ck, at);
    persistState();
    return { noted: true, key: ck, generation, nextProactiveAt: next ? new Date(next.dueAtMs).toISOString() : null };
  }
  function scheduleDive(key, { minMs, maxMs } = {}) {
    if (!diveOn) return { scheduled: false, blocked: 'DIVE_DISABLED' };
    if (state.paused) return { scheduled: false, blocked: 'SOCIAL_V2_PAUSED' };
    const ck = canonicalKey(key); if (!ck || !state.conversations[ck]) return { scheduled: false, blocked: 'UNKNOWN_CONVERSATION' };
    const w = config?.socialV2?.wake ?? {};
    const floorMs = Math.max(0, Number(w.diveMinFloorMs) || 60 * 1000);
    const min = Math.max(floorMs, Number(minMs) || Number(w.recommendedSleepMinMs) || 300000);
    const max = Math.max(min, Number(maxMs) || Number(w.recommendedSleepMaxMs) || 7200000);
    const st = state.conversations[ck];
    const generation = bumpGeneration(ck);
    cancelTasks(ck, 'sleep-wake', 'rescheduled');
    const delay = Math.floor(min + random() * (max - min));
    const dueAt = now() + delay;
    st.wakeConfig.mode = 'diving';
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(dueAt).toISOString();
    const task = addTask('sleep-wake', ck, dueAt, 'timeout', { generation });
    persistState();
    return { scheduled: true, delayMs: delay, sleepUntil: st.wakeConfig.sleepUntil, task, generation };
  }
  /** 显式 wake 配置的唯一落点：更新 state、bump generation、重建同一套 sleep task。 */
  function setWakeConfig(key, patch, { now: atMs = now() } = {}) {
    const ck = canonicalKey(key);
    if (!ck || !state.conversations[ck]) return { ok: false, reason: 'UNKNOWN_CONVERSATION' };
    const at = Number(atMs);
    const { patch: normalized, sleepUntilMs } = normalizeWakeConfigPatch(patch, { nowMs: at });
    const generation = bumpGeneration(ck);
    cancelTasks(ck, 'sleep-wake', 'reconfigured');
    const st = state.conversations[ck];
    const wc = st.wakeConfig && typeof st.wakeConfig === 'object' ? st.wakeConfig : defaultWakeConfig(config);
    if (normalized.mode !== undefined) wc.mode = normalized.mode;
    if (normalized.infinite !== undefined) wc.infinite = normalized.infinite;
    if (normalized.triggers !== undefined) wc.triggers = { ...(wc.triggers ?? {}), ...normalized.triggers };
    if (normalized.batchWindowMs !== undefined) wc.batchWindowMs = normalized.batchWindowMs;
    if (normalized.mode === 'active') {
      wc.triggers = wc.triggers ?? {};
      wc.triggers.anyMessage = true;
    }
    if (sleepUntilMs !== null) {
      wc.sleepUntil = new Date(sleepUntilMs).toISOString();
      // 显式 sleep 是「有限时间」的语义；与 infinite 同时出现时以 infinite 为准（下面的分支处理）。
    }
    wc.confirmedAt = at;
    wc.confirmedBy = 'host-wake-config';
    let task = null;
    let skippedRecord = null;
    let schedulerDispatched = false;
    if (wc.infinite === true) {
      wc.sleepUntil = null;
    } else if (wc.sleepUntil) {
      const dueAt = Date.parse(wc.sleepUntil);
      if (!Number.isFinite(dueAt)) {
        wc.sleepUntil = null;
        skippedRecord = logSkip({ taskId: null, type: 'sleep-wake', key: ck, atMs: at, dueAtMs: null, reason: 'invalid-sleep-until' });
      } else if (dueAt <= at) {
        wc.sleepUntil = null;
        skippedRecord = logSkip({ taskId: `sleep-wake:${ck}:${dueAt}`, type: 'sleep-wake', key: ck, atMs: at, dueAtMs: dueAt, reason: 'expired-at-configure' });
      } else if (diveOn) {
        task = addTask('sleep-wake', ck, dueAt, 'timeout', { generation });
        schedulerDispatched = true;
      }
    }
    st.wakeConfig = wc;
    persistState({ includeConfirmation: true });
    persistTasks();
    return {
      ok: true,
      key: ck,
      generation,
      wakeConfig: clone(wc),
      task: task == null ? null : {
        id: task.id, type: task.type, dueAtMs: task.dueAtMs,
        expiresAtMs: task.expiresAtMs ?? null, generation: task.generation,
      },
      skipped: skippedRecord,
      schedulerDispatched,
    };
  }

  function hasPendingSleep(key, { atMs = now() } = {}) {
    const ck = canonicalKey(key);
    if (!ck) return false;
    for (const task of tasks.values()) {
      // 只把「未来的显式 sleep」视为占用；已经到期、正在被 tick 消费的任务
      // 不应阻止出站成功后的新锚点计时（否则唤醒回复后永远不再自动潜水）。
      if (task.key === ck && task.type === 'sleep-wake' && task.status === 'pending' && Number(task.dueAtMs) > Number(atMs)) return true;
    }
    return false;
  }

  /**
   * 真正消费/发送前的授权复核（#2）：task 仍在、代际未变、未过期、已到期。
   * 失败时把任务标成 skipped-*（除 not-due 外），保证不会二次触发。
   */
  function authorizeWake(ev, atMs = now()) {
    const ck = canonicalKey(ev?.key);
    if (!ck) return { ok: false, reason: 'unknown-key' };
    const task = ev?.id ? tasks.get(ev.id) : null;
    if (!task) return { ok: false, reason: 'task-placeholder' };
    if (task.key !== ck) return { ok: false, reason: 'task-placeholder' };
    if (task.status !== 'pending') return { ok: false, reason: `task-${task.status}` };
    const expectedGeneration = generationFor(ck);
    if (Number(task.generation ?? 0) !== expectedGeneration) {
      logSkip({ taskId: task.id, type: task.type, key: ck, atMs, dueAtMs: task.dueAtMs, reason: 'stale-generation' });
      completeTask(task, 'skipped-stale-generation');
      return { ok: false, reason: 'stale-generation', expectedGeneration, taskGeneration: task.generation };
    }
    const expiresAtMs = Number(task.expiresAtMs);
    if (Number.isFinite(expiresAtMs) && Number(atMs) > expiresAtMs) {
      logSkip({ taskId: task.id, type: task.type, key: ck, atMs, dueAtMs: task.dueAtMs, reason: 'expired' });
      completeTask(task, 'skipped-expired');
      return { ok: false, reason: 'expired', expiresAtMs, atMs: Number(atMs) };
    }
    if (task.type === 'sleep-wake') {
      // 跨介质崩溃可能让任务文件与 state 不一致（两次 atomicWrite 之间退出）。
      // 真正发送前要求 state.sleepUntil 与 task.dueAtMs 对齐；不一致宁可跳过，也不能补发。
      const currentSleepUntil = Date.parse(state.conversations[ck]?.wakeConfig?.sleepUntil ?? '');
      if (!Number.isFinite(currentSleepUntil) || Math.abs(currentSleepUntil - Number(task.dueAtMs)) > 1000) {
        logSkip({ taskId: task.id, type: task.type, key: ck, atMs, dueAtMs: task.dueAtMs, reason: 'state-task-placeholder' });
        completeTask(task, 'skipped-state-task-placeholder');
        return { ok: false, reason: 'state-task-placeholder' };
      }
    }
    const dueAtMs = Number(task.dueAtMs);
    if (Number.isFinite(dueAtMs) && Number(atMs) < dueAtMs - 1000) {
      return { ok: false, reason: 'not-due', dueAtMs };
    }
    return {
      ok: true,
      task: {
        id: task.id, type: task.type, key: ck, generation: task.generation,
        dueAtMs, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
      },
    };
  }

  async function emit(task, nowMs) {
    const ev = {
      id: task.id, type: task.type, reason: task.reason, key: task.key,
      dueAt: new Date(task.dueAtMs).toISOString(), at: new Date(nowMs).toISOString(),
      correlationId: task.correlationId,
      generation: task.generation,
      expiresAt: Number.isFinite(Number(task.expiresAtMs)) ? new Date(Number(task.expiresAtMs)).toISOString() : null,
    };
    await onWake(ev); return ev;
  }
  let tickInFlight = null;
  async function tick(nowMs = now()) {
    if (tickInFlight) return tickInFlight;
    tickInFlight = tickBody(nowMs);
    try { return await tickInFlight; } finally { tickInFlight = null; }
  }
  async function tickBody(nowMs = now()) {
    if (!schedulerEnabled) return { ok: false, blocked: 'AUTONOMOUS_SCHEDULER_DISABLED', events: [] };
    if (state.paused) return { ok: false, blocked: 'SOCIAL_V2_PAUSED', events: [] };
    const dueAll = [...tasks.values()].filter((t) => t.status === 'pending' && t.dueAtMs <= nowMs)
      .sort((a, b) => (TASK_PRIORITY[b.type] ?? 0) - (TASK_PRIORITY[a.type] ?? 0) || a.dueAtMs - b.dueAtMs);
    const picked = new Map();
    for (const t of dueAll) if (!picked.has(t.key)) picked.set(t.key, t);
    const events = [];
    for (const task of picked.values()) {
      if (task.type === 'sleep-wake' && !diveOn) { completeTask(task, 'dive-disabled'); continue; }
      if (task.type === 'proactive-check' && !proactiveOn) { completeTask(task, 'proactive-disabled'); continue; }
      // sleep-wake 是唯一会触发「自主发送」的任务：真正消费前复核 generation / 有效期。
      // 入站/重配已经 bump generation 的任务、或排队期间已过期的任务，只能被跳过。
      if (task.type === 'sleep-wake') {
        const authorization = authorizeWake({ id: task.id, key: task.key }, nowMs);
        if (!authorization.ok) { continue; }
      }
      if (task.type === 'sleep-wake') {
        const st = state.conversations[task.key]; if (!st) { completeTask(task, 'cancelled'); continue; }
        cancelTasks(task.key, 'reply-check', 'superseded-by-timeout');
        // 先 emit（Host 会在真正发送前复核 state/task 一致），再提交 state。
        // 之前先清 sleepUntil 会让 Host 的二次授权误判 state-task-placeholder。
        events.push(await emit({ ...task, reason: 'legacy-timeout' }, nowMs));
        const stillPending = tasks.has(task.id);
        if (stillPending) {
          st.wakeConfig.sleepUntil = null;
          st.wakeConfig.lastWakeAt = nowMs;
          st.wakeConfig.wakeCount = (Number(st.wakeConfig.wakeCount) || 0) + 1;
          completeTask(task);
        }
        persistState();
        nextTaskAt();
      } else if (task.type === 'reply-check') {
        const st = state.conversations[task.key];
        const noNew = Number(st?.lastReadThroughSeq ?? 0) >= Number(st?.lastUnreadSeq ?? 0);
        if (noNew) { completeTask(task, 'skipped-no-unread'); continue; }
        events.push(await emit(task, nowMs));
        if (tasks.has(task.id)) completeTask(task);
      } else if (task.type === 'proactive-check') {
        const st = state.conversations[task.key];
        const p = proactiveConfig();
        if (!st || p.enabled === false) { completeTask(task, 'cancelled'); continue; }
        const idle = nowMs - (Number(st.lastIncomingAt) || 0);
        const threshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
        let prob = Number.isFinite(Number(p.probability)) ? Number(p.probability) : 0.4;
        prob = Math.min(1, Math.max(0, prob));
        const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((x) => x && (!x.expiresAt || nowMs < Number(x.expiresAt))).length : 0;
        if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
        if (duePromises(st, nowMs).length) prob = Math.min(1, prob * 1.6);
        if (st.lastAiReplyAt && nowMs - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
        const hour = new Date(nowMs).getHours(); if (hour >= 23 || hour < 8) prob *= 0.3;
        const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
        if (recent.filter((m) => m && m.isSelf && nowMs - Number(m.time || 0) < 3600000).length >= 5) prob *= 0.3;
        const blocked = proactiveBlocked(config, new Date(nowMs));
        const hit = !blocked && idle >= threshold && random() < prob;
        if (hit) {
          // 必须先 emit（Host 在 onWake 里复核 task 仍 pending），再完成，否则会被判 task-placeholder。
          events.push(await emit({ ...task, reason: 'proactiveCheck', probability: prob }, nowMs));
          if (tasks.has(task.id)) completeTask(task, 'fired');
        } else {
          await completeTask(task, blocked ? 'skipped-blocked' : (idle < threshold ? 'skipped-idle' : 'skipped-probability'));
        }
        scheduleProactiveTask(task.key, nowMs);
      }
    }
    if (events.length) persistState();
    persistTasks();
    return { ok: true, events, nextTaskAt: nextTaskAt(nowMs) };
  }
  function status() {
    const conversations = Object.entries(state.conversations).map(([key, st]) => ({
      key, mode: st.wakeConfig?.mode ?? null, infinite: st.wakeConfig?.infinite ?? null, sleepUntil: st.wakeConfig?.sleepUntil ?? null,
      wakeCount: st.wakeConfig?.wakeCount ?? 0, lastWakeAt: st.wakeConfig?.lastWakeAt ?? 0, safety: computeWakeSafety(st.wakeConfig, now()),
      activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.length : 0, pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.length : 0,
      promises: Array.isArray(st.promises) ? st.promises.length : 0,
    }));
    return {
      schema: LEGACY_STATE_VERSION, stateFile, taskFile: taskPath, paused: state.paused, schedulerEnabled, lockHeld, lockPath, writable,
      diveEnabled: diveOn, proactiveEnabled: proactiveOn,
      stateWriteLock: stateWriter?.lockPath ?? null, stateWriteLockMetrics: stateWriter?.metrics?.() ?? null,
      nextWakeAt: nextWakeAt(state, now()), nextTaskAt: nextTaskAt(now()), conversations,
      tasks: [...tasks.values()].filter((t) => t.status === 'pending').map((t) => ({ id: t.id, type: t.type, key: t.key, dueAtMs: t.dueAtMs, reason: t.reason, correlationId: t.correlationId, generation: t.generation ?? 0, expiresAtMs: t.expiresAtMs ?? null })),
      completedCount: completed.length,
      skippedCount: skipped.length,
      lastSkipped: skipped.length ? skipped[skipped.length - 1] : null,
      generations: Object.fromEntries(generations),
      sourceStateSha256: crypto.createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex'),
      boundary: 'HOST_CALLBACK_ONLY', dshPrompt: false, qqOutbound: false,
    };
  }
  function start() {
    if (!anySchedulerOn) return { started: false, blocked: 'AUTONOMOUS_SCHEDULER_DISABLED' };
    if (state.paused) return { started: false, blocked: 'SOCIAL_V2_PAUSED' };
    if (schedulerEnabled) return { started: true, already: true };
    const lock = acquireLock();
    if (!lock.ok) return { started: false, blocked: lock.reason, lockPath: lock.lockPath };
    schedulerEnabled = true;
    const restored = restoreTasks();
    // 恢复任务也必须服从独立开关：dive 关闭不得复活 sleep-wake，proactive 关闭不得复活 proactive-check。
    for (const t of [...tasks.values()]) {
      if (t.type === 'sleep-wake' && !diveOn) completeTask(t, 'dive-disabled');
      if (t.type === 'proactive-check' && !proactiveOn) completeTask(t, 'proactive-disabled');
    }
    const scheduled = scheduleSleepTasks();
    for (const key of Object.keys(state.conversations)) scheduleProactiveTask(key);
    persistState();
    persistTasks();
    if (intervalMs > 0) timer = setIntervalFn(() => { void tick(); }, intervalMs);
    timer?.unref?.();
    return { started: true, lockPath: lock.lockPath, intervalMs, taskCount: tasks.size, restored, scheduled, diveEnabled: diveOn, proactiveEnabled: proactiveOn };
  }
  function stop() {
    schedulerEnabled = false;
    if (timer) { clearIntervalFn(timer); timer = null; }
    releaseLock(); persistTasks();
    return { stopped: true, stateFile, lockHeld, taskCount: tasks.size };
  }
  return { state, status, due, tick, start, stop, persist: persistState, persistTasks, scheduleReply, cancelReply, scheduleDive, cancelDive, noteIncoming, setWakeConfig, authorizeWake, hasPendingSleep, generationFor, skippedRecords: () => skipped.slice(), nextWakeAt: () => nextWakeAt(state, now()), nextTaskAt };
}

export function planWait(input, config = {}) {
  return computeWaitPlan({ body: input?.body ?? {}, waitCfg: config?.socialV2?.wait ?? config?.wait ?? {}, suggestedQuietMs: input?.suggestedQuietMs ?? null, preSleepWaitMs: input?.preSleepWaitMs ?? 300000 });
}
export { looksLikeUnfinished };
