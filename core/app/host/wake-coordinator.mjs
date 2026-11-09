// Host 侧唯一 per-key 潜水状态机（#1）。
//
// 为什么需要这一层：
//   旧实现有三套互不知情的时间来源：Host 的 idle setTimeout、legacy lifecycle 的
//   sleep-wake task、以及 MCP 直接写 SnowLuma social-v2.json 的 wakeConfig。三套各自
//   计时、各自触发，结果是「模型设置了无限期潜水，5 分钟后又被 Host 自动潜一次」或
//   「出站失败的尝试也被当成静默起点」。这里把 per-key 状态（锚点、generation、timer）
//   收拢成一个对象，所有入口（入站、可见出站成功、显式 wake 配置）都经过它。
//
// 关键不变量：
//   * 锚点 = max(lastInboundAt, lastSuccessfulOutboundAt)。
//   * 只有**确认成功的可见出站**才更新 lastSuccessfulOutboundAt；被出站闸拒绝/失败/
//     unknown 的投递只计数，不延长静默。
//   * 入站 / 可见出站成功 / 重新配置都会 bump timerGeneration，旧 setTimeout 即使
//     被事件循环延迟执行，也必须在回调里比对 generation 后放弃。
//   * 显式 wake 配置（有限/无限/active）经同一个 lifecycle 调度接口下发；显式
//     有限 sleep 存在时，Host 不再另起 idle timer（避免第二套计时器）。
//   * 自动潜水只通过 lifecycle.scheduleDive() 落任务；时间任务的过期/代际校验由
//     legacy-lifecycle.authorizeWake() 在真正消费前完成（#2）。

export const DEFAULT_IDLE_DIVE_MS = 300000;

/**
 * 出站投递结果的可见性判定（纯函数）。
 * service.dispatchOnce() 返回 { claimed, results: [{ deliveryId, state, receipts }] }。
 * 只有 state==='sent' 表示**所有 part 都确认成功**；partial / retry-pending /
 * unknown_after_send / failed 都不能作为「延长静默」的依据。
 */
export function classifyOutboundResult(dispatchResult) {
  if (!dispatchResult || typeof dispatchResult !== 'object') {
    return { visibleConfirmed: false, states: [], reason: 'no-dispatch-result' };
  }
  const list = Array.isArray(dispatchResult.results)
    ? dispatchResult.results
    : (Array.isArray(dispatchResult) ? dispatchResult : [dispatchResult]);
  const states = list.map((item) => String(item?.state ?? ''));
  const visibleConfirmed = states.includes('sent');
  return {
    visibleConfirmed,
    states,
    reason: visibleConfirmed ? 'sent' : (states.length ? 'not-fully-sent' : 'no-results'),
  };
}

export function createWakeCoordinator({
  lifecycle,
  idleDiveMs = DEFAULT_IDLE_DIVE_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = null,
} = {}) {
  if (!lifecycle || typeof lifecycle !== 'object') throw new Error('lifecycle required');
  const anchorMs = Number(idleDiveMs);
  if (!Number.isFinite(anchorMs) || anchorMs <= 0) throw new Error('idleDiveMs must be positive');

  const lastInboundAt = new Map();
  const lastSuccessfulOutboundAt = new Map();
  const timerGeneration = new Map();
  const timers = new Map();
  const outboundAttempts = new Map();
  const suppressedByExplicitActive = new Set();
  const lastConfig = new Map();

  const log = (entry) => {
    const record = { atMs: Number(now()), ...entry };
    try { logger?.(record); } catch { /* observability must not break scheduling */ }
    return record;
  };
  const bumpTimerGeneration = (key) => {
    const next = (timerGeneration.get(key) ?? 0) + 1;
    timerGeneration.set(key, next);
    return next;
  };
  const cancelTimer = (key) => {
    const timer = timers.get(key);
    if (timer != null) {
      try { clearTimeoutFn(timer); } catch { /* ignore */ }
      timers.delete(key);
    }
  };
  const anchorOf = (key) => Math.max(
    0,
    Number(lastInboundAt.get(key) ?? 0),
    Number(lastSuccessfulOutboundAt.get(key) ?? 0),
  );
  const hasExplicitSleep = (key, atMs = now()) => {
    try { return lifecycle.hasPendingSleep?.(key, { atMs }) === true; } catch { return false; }
  };

  function scheduleIdle(key, atMs = now()) {
    cancelTimer(key);
    if (suppressedByExplicitActive.has(key)) {
      return { scheduled: false, reason: 'explicit-active-or-infinite' };
    }
    if (hasExplicitSleep(key, atMs)) {
      return { scheduled: false, reason: 'explicit-sleep-task-active' };
    }
    const anchor = anchorOf(key);
    if (anchor <= 0) return { scheduled: false, reason: 'no-anchor' };
    const generation = timerGeneration.get(key) ?? 0;
    const dueAt = anchor + anchorMs;
    const delay = Math.max(0, dueAt - atMs);
    const timer = setTimeoutFn(() => {
      timers.delete(key);
      if ((timerGeneration.get(key) ?? 0) !== generation) {
        log({ kind: 'idle-timer-invalidated', key, generation });
        return;
      }
      if (suppressedByExplicitActive.has(key)) return;
      if (hasExplicitSleep(key, now())) return;
      if (Number(now()) - anchorOf(key) < anchorMs) {
        scheduleIdle(key, now());
        return;
      }
      let result = null;
      let error = null;
      try { result = lifecycle.scheduleDive?.(key); } catch (e) { error = String(e?.message ?? e); }
      log({
        kind: 'idle-dive', key, generation, dueAt,
        scheduled: result?.scheduled === true,
        taskId: result?.task?.id ?? null,
        error,
      });
    }, delay);
    timer?.unref?.();
    timers.set(key, timer);
    return { scheduled: true, dueAt, delayMs: delay, generation, anchorAt: anchor };
  }

  /** 入站：更新锚点、使旧 timer/task generation 失效、取消显式/自动 sleep、重新计时。 */
  function noteInbound(key, atMs = now()) {
    lastInboundAt.set(key, Number(atMs));
    suppressedByExplicitActive.delete(key);
    bumpTimerGeneration(key);
    cancelTimer(key);
    let error = null;
    try { lifecycle.cancelDive?.(key, 'inbound'); } catch (e) { error = String(e?.message ?? e); }
    try { lifecycle.noteIncoming?.(key, Number(atMs)); } catch (e) { error = error ?? String(e?.message ?? e); }
    const scheduled = scheduleIdle(key, atMs);
    return {
      key,
      anchorAt: anchorOf(key),
      generation: timerGeneration.get(key) ?? 0,
      scheduled,
      error,
    };
  }

  /**
   * 出站结果：只有确认成功的可见出站才更新锚点。
   * dispatchResult 为 null（outbound disabled / 没有 provider）同样不算成功。
   */
  function noteOutboundResult(key, dispatchResult, atMs = now()) {
    const verdict = classifyOutboundResult(dispatchResult);
    if (verdict.visibleConfirmed) {
      lastSuccessfulOutboundAt.set(key, Number(atMs));
      bumpTimerGeneration(key);
      cancelTimer(key);
      const scheduled = scheduleIdle(key, atMs);
      log({
        kind: 'outbound-visible-confirmed', key, atMs: Number(atMs),
        states: verdict.states, generation: timerGeneration.get(key) ?? 0,
        scheduled: scheduled.scheduled === true,
      });
      return { confirmed: true, ...verdict, anchorAt: anchorOf(key), generation: timerGeneration.get(key) ?? 0, scheduled };
    }
    const attempts = (outboundAttempts.get(key) ?? 0) + 1;
    outboundAttempts.set(key, attempts);
    log({ kind: 'outbound-not-confirmed', key, atMs: Number(atMs), states: verdict.states, attempts });
    return { confirmed: false, ...verdict, anchorAt: anchorOf(key), attempts };
  }

  /** 显式失败入口：只记一次失败尝试，不触碰锚点/定时器。 */
  function noteOutboundFailure(key, reason = 'outbound-failed', atMs = now()) {
    const attempts = (outboundAttempts.get(key) ?? 0) + 1;
    outboundAttempts.set(key, attempts);
    log({ kind: 'outbound-not-confirmed', key, atMs: Number(atMs), states: [], reason, attempts });
    return { confirmed: false, visibleConfirmed: false, states: [], reason, anchorAt: anchorOf(key), attempts };
  }

  /**
   * 显式 wake 配置入口（Host endpoint 唯一调用点）。
   * 重新配置总是使旧 idle timer / 旧 sleep task generation 失效，然后由 lifecycle
   * 在同一套 task 存储里决定是否创建有限 sleep 任务。
   */
  function setWakeConfig(key, config, atMs = now()) {
    bumpTimerGeneration(key);
    cancelTimer(key);
    let result;
    try {
      result = lifecycle.setWakeConfig?.(key, config, { now: Number(atMs) });
    } catch (error) {
      throw error;
    }
    const wc = result?.wakeConfig ?? null;
    lastConfig.set(key, wc);
    const isActive = wc?.mode === 'active';
    const isInfinite = wc?.infinite === true;
    if (isActive || isInfinite) suppressedByExplicitActive.add(key);
    else suppressedByExplicitActive.delete(key);
    log({
      kind: 'wake-config-set', key, atMs: Number(atMs),
      generation: result?.generation ?? null,
      mode: wc?.mode ?? null,
      infinite: wc?.infinite ?? null,
      sleepUntil: wc?.sleepUntil ?? null,
      skipped: result?.skipped?.reason ?? null,
    });
    return result;
  }

  /** 真正消费/发送前的复核（task 是否存在、generation 是否当前、是否已过期）。 */
  function authorizeWake(ev, atMs = now()) {
    let result;
    try {
      result = lifecycle.authorizeWake?.(ev, Number(atMs)) ?? { ok: true };
    } catch (error) {
      result = { ok: false, reason: 'authorize-error', error: String(error?.message ?? error) };
    }
    if (!result.ok) {
      log({ kind: 'wake-skipped', taskId: ev?.id ?? null, type: ev?.type ?? null, key: ev?.key ?? null, reason: result.reason });
    }
    return result;
  }

  function status() {
    const keys = new Set([
      ...lastInboundAt.keys(), ...lastSuccessfulOutboundAt.keys(),
      ...timerGeneration.keys(), ...lastConfig.keys(), ...suppressedByExplicitActive,
    ]);
    return {
      idleDiveMs: anchorMs,
      conversations: [...keys].sort().map((key) => ({
        key,
        anchorAt: anchorOf(key),
        lastInboundAt: lastInboundAt.get(key) ?? null,
        lastSuccessfulOutboundAt: lastSuccessfulOutboundAt.get(key) ?? null,
        timerGeneration: timerGeneration.get(key) ?? 0,
        timerScheduled: timers.has(key),
        outboundFailureAttempts: outboundAttempts.get(key) ?? 0,
        explicitActive: suppressedByExplicitActive.has(key),
        lastWakeConfig: lastConfig.get(key) ?? null,
      })),
    };
  }

  function stop() {
    for (const key of [...timers.keys()]) cancelTimer(key);
  }

  return {
    noteInbound,
    noteOutboundResult,
    noteOutboundFailure,
    setWakeConfig,
    authorizeWake,
    scheduleIdle,
    anchorOf,
    status,
    stop,
  };
}
