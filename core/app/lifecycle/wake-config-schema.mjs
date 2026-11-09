// 显式 wake 配置的字段白名单与规范化（#1）。
// 独立成模块的原因：Host HTTP 端点与 lifecycle.setWakeConfig 必须共用同一套校验，
// 不能让「端点收下的字段」和「调度器理解的字段」出现第二套口径。

const WAKE_CONFIG_KEYS = new Set(['mode', 'infinite', 'sleepMs', 'sleepUntil', 'triggers', 'batchWindowMs']);
const WAKE_TRIGGER_KEYS = new Set(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);

function wakeConfigError(message, field) {
  const error = new Error(message);
  error.code = 'WAKE_CONFIG_INVALID';
  error.field = field;
  return error;
}

/**
 * 校验/规范化显式 wake 配置 patch。
 * - 只接受 MCP 工具暴露的字段；未知字段拒绝（避免 wakeConfig 变成任意对象写入口）。
 * - sleepMs / sleepUntil 统一折算成绝对 sleepUntil；两者同时给时 sleepUntil 优先。
 * - 返回值里的 patch 只含规范化后的字段；sleepUntilMs 为绝对毫秒（无则 null）。
 */
export function normalizeWakeConfigPatch(patch = {}, { nowMs = Date.now() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw wakeConfigError('wake config 必须是普通对象', 'config');
  for (const key of Object.keys(patch)) {
    if (!WAKE_CONFIG_KEYS.has(key)) throw wakeConfigError(`未知的 wake 配置字段：${key}`, key);
  }
  const out = {};
  if (patch.mode !== undefined) {
    if (patch.mode !== 'diving' && patch.mode !== 'active') throw wakeConfigError('mode 只能是 diving / active', 'mode');
    out.mode = patch.mode;
  }
  if (patch.infinite !== undefined) {
    if (typeof patch.infinite !== 'boolean') throw wakeConfigError('infinite 必须是布尔值', 'infinite');
    out.infinite = patch.infinite;
  }
  let sleepUntilMs = null;
  if (patch.sleepUntil !== undefined) {
    if (typeof patch.sleepUntil !== 'string') throw wakeConfigError('sleepUntil 必须是 ISO 字符串', 'sleepUntil');
    const parsed = Date.parse(patch.sleepUntil);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8.64e15) throw wakeConfigError('sleepUntil 不是可解析的时间', 'sleepUntil');
    sleepUntilMs = parsed;
  }
  if (patch.sleepMs !== undefined) {
    const ms = Number(patch.sleepMs);
    if (!Number.isFinite(ms) || ms < 0) throw wakeConfigError('sleepMs 必须是非负有限数', 'sleepMs');
    if (patch.sleepUntil === undefined) {
      const computed = Number(nowMs) + ms;
      if (!Number.isFinite(computed) || computed > 8.64e15) throw wakeConfigError('sleepMs 超出可表示时间范围', 'sleepMs');
      sleepUntilMs = computed;
    }
  }
  if (patch.triggers !== undefined) {
    const triggers = patch.triggers;
    if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) throw wakeConfigError('triggers 必须是普通对象', 'triggers');
    for (const key of Object.keys(triggers)) {
      if (!WAKE_TRIGGER_KEYS.has(key)) throw wakeConfigError(`未知的 trigger 字段：${key}`, `triggers.${key}`);
    }
    const normalized = {};
    for (const key of ['atMention', 'nameMention', 'question', 'poke', 'anyMessage']) {
      if (triggers[key] === undefined) continue;
      if (typeof triggers[key] !== 'boolean') throw wakeConfigError(`triggers.${key} 必须是布尔值`, `triggers.${key}`);
      normalized[key] = triggers[key];
    }
    if (triggers.probability !== undefined) {
      const p = Number(triggers.probability);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw wakeConfigError('triggers.probability 必须是 0..1', 'triggers.probability');
      normalized.probability = p;
    }
    if (triggers.speakerIds !== undefined) {
      if (!Array.isArray(triggers.speakerIds) || triggers.speakerIds.length > 20) throw wakeConfigError('triggers.speakerIds 必须是最多 20 项的数组', 'triggers.speakerIds');
      normalized.speakerIds = triggers.speakerIds.map((id) => {
        const s = String(id);
        if (!/^\d+$/.test(s)) throw wakeConfigError('triggers.speakerIds 只能包含 QQ 号', 'triggers.speakerIds');
        return s;
      });
    }
    if (triggers.keywords !== undefined) {
      if (!Array.isArray(triggers.keywords)) throw wakeConfigError('triggers.keywords 必须是字符串数组', 'triggers.keywords');
      normalized.keywords = triggers.keywords.map((k) => {
        if (typeof k !== 'string' || k === '') throw wakeConfigError('triggers.keywords 只能包含非空字符串', 'triggers.keywords');
        return k;
      });
    }
    out.triggers = normalized;
  }
  if (patch.batchWindowMs !== undefined) {
    const ms = Number(patch.batchWindowMs);
    if (!Number.isFinite(ms) || ms < 1000) throw wakeConfigError('batchWindowMs 必须 >= 1000', 'batchWindowMs');
    out.batchWindowMs = Math.round(ms);
  }
  return { patch: out, sleepUntilMs };
}

export { wakeConfigError };
