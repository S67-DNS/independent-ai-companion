// 投递 Provider 抽象 + 可注入行为的 mock（candidate）。
//
// 为什么要有这一层：Outbox 只负责「该不该发、发过没有」，真正把字节送到通道的是 provider。
// 把发送/对账收成一个小接口，崩溃语义才能在测试里被精确注入——尤其是最危险的形态：
// **上游已经收到了，但我们这边没拿到成功回执**（ack-lost）。这种时候既不能当成功（我们
// 没有证据），更不能当失败重发（会重复投递），唯一正确的处理是 unknown_after_send。
//
// 接口：
//   { name, reconcileSupport,
//     send({ delivery, attempt, part }) → { ok, receipt } | throws,
//     reconcile({ delivery, attempt }) → 'sent' | 'not-sent' | 'unknown' }
//
// 调用方必须遵守的时序（顺序本身就是正确性的一部分）：
//   claim → markSendStarted（落库）→ provider.send() → recordPartReceipt / ack
//   · send 抛错且**确定没被上游接受** → fail({ retryable })；
//   · send 抛出「响应丢失/超时/可能已接受」→ markUnknownAfterSend()，**不得重发**。
//
// reconcile_support 是能力声明，不是建议：
//   'query' = 可以按业务幂等键问上游「这条到底发出去没有」；
//   'none'  = 问不了。此时 unknown 就永远停在 unknown，这是声明 none 必须接受的代价。

import { CandidateError, ERR } from './errors.mjs';

/** provider.reconcile() 的合法回答。 */
export const RECONCILE_ANSWER = Object.freeze({ SENT: 'sent', NOT_SENT: 'not-sent', UNKNOWN: 'unknown' });

/** mock 可注入的行为。 */
export const PROVIDER_BEHAVIOR = Object.freeze({
  OK: 'ok',
  THROW: 'throw',
  ACK_LOST: 'ack-lost',
  PARTIAL: 'partial',
  SLOW: 'slow',
  HANG: 'hang',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 构造 provider 侧错误。`ambiguous` 是给调用方看的语义标签：
 * true ⇒ 上游可能已经接受，必须走 markUnknownAfterSend；false ⇒ 确定没接受，可安全重试。
 */
function providerError(code, { retryable = false, ambiguous = false, detail = {} } = {}) {
  const error = new Error(`mock provider error: ${code}`);
  error.code = code;
  error.retryable = Boolean(retryable);
  error.ambiguous = Boolean(ambiguous);
  error.detail = Object.freeze({ ...detail });
  return error;
}

function pickIds(request) {
  const delivery = request?.delivery ?? null;
  const attempt = request?.attempt ?? null;
  const part = request?.part ?? null;
  return {
    deliveryId: delivery?.deliveryId ?? delivery?.delivery_id ?? null,
    attemptId: attempt?.attemptId ?? attempt?.attempt_id ?? null,
    // 兼容两种传参：{ part: { partNo } } 与直接在请求顶层给 partNo（service 层就是这么传的）
    partNo: Number(part?.partNo ?? part?.part_no ?? request?.partNo ?? request?.part_no ?? 1),
  };
}

/**
 * 带可注入行为的 mock provider。
 *
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {'query'|'none'} [options.reconcileSupport]
 * @param {'ok'|'throw'|'ack-lost'|'partial'|'slow'|'hang'} [options.behavior]
 * @param {number} [options.failFromPart]  behavior=partial 时，partNo >= 该值的分片返回 ok:false
 * @param {boolean} [options.retryableThrown] behavior=throw 时抛出的错误是否标记 retryable
 * @param {number} [options.delayMs] behavior=slow 的延迟
 * @param {number} [options.hangMs]  behavior=hang 的挂起时长（到点后按超时抛错）
 * @param {'sent'|'not-sent'|'unknown'|((request:object)=>any)|null} [options.reconcileAnswer]
 *        不传时：上游接受过分片的 delivery ⇒ 'sent'，否则 'not-sent'（对账由 provider 自己的账本回答）
 */
export function createMockProvider(options = {}) {
  const {
    name = 'mock-provider',
    reconcileSupport = 'none',
    behavior = PROVIDER_BEHAVIOR.OK,
    failFromPart = 2,
    retryableThrown = true,
    delayMs = 20,
    hangMs = 250,
    reconcileAnswer = null,
  } = options;

  if (reconcileSupport !== 'query' && reconcileSupport !== 'none') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `reconcileSupport 只能是 query | none`, { reconcileSupport });
  }
  if (!Object.values(PROVIDER_BEHAVIOR).includes(behavior)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `未知的 behavior：${behavior}`, { behavior });
  }

  // 上游自己的账本：它到底接受过哪些分片。用来模拟「外部世界已经变了，本地还不知道」。
  const acceptedParts = new Map(); // `${deliveryId}#${partNo}` -> { deliveryId, partNo, atMs, transportId }
  const calls = [];
  let seq = 0;

  function accept({ deliveryId, attemptId, partNo }) {
    seq += 1;
    const record = {
      deliveryId,
      attemptId,
      partNo,
      transportId: `mocktr_${seq}_${Math.random().toString(36).slice(2, 8)}`,
      atMs: Date.now(),
    };
    acceptedParts.set(`${deliveryId}#${partNo}`, record);
    return { provider: name, ...record };
  }

  /**
   * 发送一个分片（单分片投递时 part 可以省略）。
   * 返回 { ok:true, receipt } 表示上游确认接受；{ ok:false, receipt } 表示上游明确拒绝这一片。
   * 抛错表示「这次调用的结果需要调用方自己判断」——见错误上的 retryable / ambiguous。
   */
  async function send(request = {}) {
    const ids = pickIds(request);
    const call = { kind: 'send', atMs: Date.now(), behavior, ...ids };
    calls.push(call);

    switch (behavior) {
      case PROVIDER_BEHAVIOR.OK: {
        const receipt = accept(ids);
        call.outcome = 'ok';
        return { ok: true, retryable: false, receipt };
      }
      case PROVIDER_BEHAVIOR.SLOW: {
        await sleep(delayMs);
        const receipt = accept(ids);
        call.outcome = 'ok-after-delay';
        return { ok: true, retryable: false, receipt };
      }
      case PROVIDER_BEHAVIOR.PARTIAL: {
        if (ids.partNo >= failFromPart) {
          call.outcome = 'rejected';
          // 明确拒绝（例如某一片过大）：确定没被接受，可以让上层按 partial 收口
          return {
            ok: false,
            retryable: false,
            receipt: { provider: name, deliveryId: ids.deliveryId, attemptId: ids.attemptId, partNo: ids.partNo, rejected: true },
          };
        }
        const receipt = accept(ids);
        call.outcome = 'ok';
        return { ok: true, retryable: false, receipt };
      }
      case PROVIDER_BEHAVIOR.THROW: {
        call.outcome = 'threw';
        throw providerError('mock-send-error', { retryable: retryableThrown, ambiguous: false });
      }
      case PROVIDER_BEHAVIOR.ACK_LOST: {
        // 最危险的一种：上游**已经接受**（账本里记下了），但本地只看到异常。
        // 调用方必须把它当成 unknown，绝不能重发。
        accept(ids);
        call.outcome = 'accepted-then-lost';
        throw providerError('mock-ack-lost', { retryable: false, ambiguous: true });
      }
      case PROVIDER_BEHAVIOR.HANG: {
        await sleep(hangMs);
        call.outcome = 'timeout';
        // 超时同样属于「可能已接受」：语义上必须走 unknown
        throw providerError('mock-timeout', { retryable: false, ambiguous: true });
      }
      default:
        throw new CandidateError(ERR.INTERNAL, `未实现的 behavior：${behavior}`);
    }
  }

  /** 问上游「这条到底发出去没有」。只有 reconcileSupport==='query' 才允许回答。 */
  async function reconcile(request = {}) {
    const ids = pickIds(request);
    const call = { kind: 'reconcile', atMs: Date.now(), ...ids };
    calls.push(call);
    if (reconcileSupport !== 'query') {
      throw new CandidateError(ERR.DELIVERY_NOT_RECONCILABLE, `provider ${name} 不支持对账`, { provider: name });
    }
    let answer;
    if (typeof reconcileAnswer === 'function') {
      answer = await reconcileAnswer(request);
    } else if (reconcileAnswer !== null && reconcileAnswer !== undefined) {
      answer = reconcileAnswer;
    } else {
      answer = acceptedParts.has(`${ids.deliveryId}#1`) || acceptedParts.has(`${ids.deliveryId}#${ids.partNo}`)
        ? RECONCILE_ANSWER.SENT
        : RECONCILE_ANSWER.NOT_SENT;
    }
    call.answer = answer;
    return answer;
  }

  return {
    name,
    reconcileSupport,
    behavior,
    send,
    reconcile,
    // ── 诊断/断言用（测试可以直接读）──────────────────────────────────────────
    get calls() { return calls; },
    get sendCalls() { return calls.filter((call) => call.kind === 'send'); },
    get reconcileCalls() { return calls.filter((call) => call.kind === 'reconcile'); },
    get accepted() { return [...acceptedParts.values()]; },
    acceptedFor(deliveryId) { return [...acceptedParts.values()].filter((item) => item.deliveryId === deliveryId); },
    reset() { calls.length = 0; },
  };
}

/**
 * 记录型包装：把每次 send / reconcile 调用按顺序记下来，供「调用了几次」的断言使用。
 * 可以包一个 mock，也可以只传 mock 的配置（会内部建一个 mock）。
 *
 * @param {object} [innerOrOptions]
 */
export function createRecordingProvider(innerOrOptions = {}) {
  const inner = innerOrOptions && typeof innerOrOptions.send === 'function'
    ? innerOrOptions
    : createMockProvider(innerOrOptions);
  const calls = [];

  function record(kind, request) {
    const ids = pickIds(request);
    const entry = { kind, atMs: Date.now(), ...ids, ok: null };
    calls.push(entry);
    return entry;
  }

  return {
    name: inner.name,
    reconcileSupport: inner.reconcileSupport,
    get calls() { return calls; },
    get sendCalls() { return calls.filter((call) => call.kind === 'send'); },
    get reconcileCalls() { return calls.filter((call) => call.kind === 'reconcile'); },
    get sendCount() { return calls.reduce((n, call) => n + (call.kind === 'send' ? 1 : 0), 0); },
    get reconcileCount() { return calls.reduce((n, call) => n + (call.kind === 'reconcile' ? 1 : 0), 0); },
    async send(request) {
      const entry = record('send', request);
      const result = await inner.send(request);
      entry.ok = result.ok === true;
      return result;
    },
    async reconcile(request) {
      const entry = record('reconcile', request);
      const answer = await inner.reconcile(request);
      entry.answer = answer;
      return answer;
    },
    reset() { calls.length = 0; },
    inner,
  };
}
