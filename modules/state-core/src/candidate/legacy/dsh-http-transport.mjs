// DSH 0.2.1-rc.5 的 **HTTP/WS transport 适配层**：把「线上真实协议」收敛成两条契约 API，
// 供 follow-protocol.mjs 的纯状态机消费。本模块**只做 IO**，不含任何 seq 门控/快照对账逻辑
// （那些全部在 follow-protocol.mjs 里，不重复实现、不越界）。
//
// ── 契约（与 OPENCORE-CONSTRUCTION-002 任务 B 的接口定义一致）──────────────────────────
//   createDshHttpTransport({ baseUrl, client })            // client = src/dsh-client.js 的 NodeApiClient
//   createDshHttpTransport({ openFollow, page })           // 或直接注入两个函数（测试用）
//   → { openFollow({ sessionId, maxMessages?, assistantStream?, signal? }) : AsyncIterable<frame>
//       page({ sessionId, throughSeq, beforeSeq?, maxMessages? }) : Promise<{ records, hasMore }>
//       close() }
//
// openFollow 产出的是**线上 L3 帧**（已剥掉 remote.mux 的 L1 外壳）：
//   { type:'snapshot', header, cursor, records, hasMore, projections }
//   { type:'event', event:{seq,type,time,data} }
//   { type:'assistant-stream', ... }   （仅当请求 assistantStream:true；状态机一律 ignored）
//   { type:'end' }                     （流结束：归档/回收/服务端 fail-fast/WS 断开）
//   { type:'error', error:{code,message,details} }
//
// ── 全部结论均已在本机隔离实例（18990）实测，证据见 ──────────────────────────────────
//   reports/DSH-RC5-PROTOCOL-CAPTURE.md
//   reports/dsh-rc5-capture/（02/03/05/06/07/08/09/10/11 号原始帧）
// 关键实测点（写在这里是为了让后来改这个文件的人不必重跑抓包）：
//   1. 传输层：WS `/api/remote.mux`，多路复用帧 {type:'item'|'error'|'end', streamId, value}。
//      L1 end 帧实测**没有** payload；服务端主动结束的形态在归档场景下 15s 内未观测到（UNVERIFIED）。
//   2. 打开 follow：`{type:'open', streamId, endpoint:'session/follow',
//                    payload:{args:{request:{address:{kind:'session',sessionId}, maxMessages?}}}}`
//      首帧**恒为** {type:'snapshot'}（会话存在时）；会话不存在时首帧是 L1 `error` 帧
//      （code=session/not-found），绝不是 snapshot。
//   3. page：`session/page` 的线上 request 形状是
//      `{address:{kind:'session',sessionId}, throughSeq, beforeSeq?, maxMessages?}` ——
//      **不是** {sessionId}（桥 dsh-client.js 的 METHOD_ARG_WRAPPERS 写的是 request:{...}，
//      若照它拼 {sessionId} 会被 gateway/input-invalid 拒）。throughSeq **必填**。
//   4. throughSeq = 闭区间上界（含）；beforeSeq = 开区间上界（不含）；两者同时给时取更小的那个界限。
//      throughSeq > cursor → gateway/bad-request；throughSeq < -1 → gateway/bad-request。
//   5. maxMessages 只数 `user/message` + `assistant/message`；窗口会向外扩到包住这些消息周围的
//      非消息事件（turn/start、step/end…），默认 50 条消息实测（196 条 records / msgN=50 / hasMore=true）。
//
// 为什么这里不 import dsh-client.js 也不改它：该文件是**生产桥**在用的活客户端，改它的行为
// 等于改生产协议路径。本模块只通过它的公开面（callUnary / ensureAuth / cookie）复用它，
// 语义完全由本模块自己的实测结论驱动。

/** transport 层错误：带上 DSH 的服务端错误码（如 gateway/bad-request），便于上层分类。 */
export class TransportError extends Error {
  constructor(code, message, { details = null, cause = undefined } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = (value) => Number.isSafeInteger(value) && value >= -1;

/**
 * 创建 transport。
 *
 * @param {object} options
 * @param {string} [options.baseUrl] DSH 基址，如 http://127.0.0.1:18990
 * @param {object} [options.client] 提供 callUnary/ensureAuth/cookie 的客户端（NodeApiClient 即满足）
 * @param {string} [options.cookie] 直接给会话 Cookie（与 client 二选一）
 * @param {string} [options.token] 直接给 launch token（会用它换 Cookie）
 * @param {Function} [options.WebSocketImpl] WebSocket 实现（默认 globalThis.WebSocket；测试注入假实现）
 * @param {number} [options.firstFrameTimeoutMs] 首帧超时（默认 30s）
 * @param {Function} [options.openFollow] / [options.page] 直接注入实现（测试/回放用）
 */
export function createDshHttpTransport(options = {}) {
  if (!isPlainObject(options)) {
    throw new TransportError('transport/invalid-argument', 'createDshHttpTransport 需要一个对象参数');
  }
  // 注入式：调用方自己给 openFollow/page（离线回放、或别处已经有实现）
  if (typeof options.openFollow === 'function' && typeof options.page === 'function') {
    return {
      openFollow: options.openFollow,
      page: options.page,
      close: typeof options.close === 'function' ? options.close : () => {},
      mode: 'injected',
    };
  }

  const client = options.client ?? null;
  const baseUrl = String(options.baseUrl ?? client?.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new TransportError('transport/invalid-argument', 'createDshHttpTransport 需要 baseUrl（或带 baseUrl 的 client）');
  }
  if (!client && !options.cookie && !options.token) {
    throw new TransportError('transport/invalid-argument', 'createDshHttpTransport 需要 client / cookie / token 之一');
  }
  if (client && typeof client.callUnary !== 'function') {
    throw new TransportError('transport/invalid-argument', 'client 必须提供 callUnary(method, payload)（NodeApiClient 满足）');
  }

  const WS = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof WS !== 'function') {
    throw new TransportError('transport/invalid-argument', '当前运行时没有 WebSocket；请传入 WebSocketImpl');
  }
  const firstFrameTimeoutMs = Number(options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS);
  /** 所有在飞的 follow 的 AbortController（close() 用）。 */
  const active = new Set();

  /** 拿会话 Cookie：优先复用 client 自己的鉴权路径（token 换 cookie / 离线铸造都由它决定）。 */
  async function resolveCookie(signal) {
    if (typeof options.cookie === 'string' && options.cookie.length > 0) return options.cookie;
    if (client && typeof client.ensureAuth === 'function') {
      await client.ensureAuth(signal);
      if (typeof client.cookie === 'string' && client.cookie.length > 0) return client.cookie;
    }
    if (client && typeof client.cookie === 'string' && client.cookie.length > 0) return client.cookie;
    if (typeof options.token === 'string' && options.token.length > 0) {
      const url = new URL(baseUrl);
      url.searchParams.set('token', options.token);
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(firstFrameTimeoutMs) });
      await response.body?.cancel();
      const setCookie = response.headers.get('set-cookie');
      if (!setCookie) {
        throw new TransportError('transport/auth', `token 换 Cookie 失败：HTTP ${response.status} 没有 set-cookie`);
      }
      return setCookie.split(';')[0];
    }
    throw new TransportError('transport/auth', '没有可用的会话 Cookie（client/cookie/token 都没给出有效鉴权）');
  }

  /**
   * 打开一条 session/follow 流，逐帧产出 L3 帧。
   *
   * 语义承诺（与实测一致）：
   *   · 第一帧是 snapshot（会话存在时）；调用方必须消费它，不能只处理 event。
   *   · 之后是 event 帧，seq 单调递增。
   *   · 流结束（服务端 end / WS 断开）时产出一帧 {type:'end'} 并结束迭代——**这是常规事件**，
   *     调用方必须 re-follow，新流的新 snapshot 会替换窗口。
   *   · L1 error 帧转成 {type:'error', error} 后结束迭代。
   *
   * @param {{sessionId: string, maxMessages?: number, assistantStream?: boolean, signal?: AbortSignal}} params
   * @returns {AsyncIterable<object>}
   */
  async function* openFollow({ sessionId, maxMessages, assistantStream = false, signal } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TransportError('transport/invalid-argument', 'openFollow 需要非空 sessionId');
    }
    if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages < 1)) {
      throw new TransportError('transport/invalid-argument', 'maxMessages 必须是 >=1 的安全整数', { details: { maxMessages } });
    }
    const cookie = await resolveCookie(signal);
    signal?.throwIfAborted();

    const url = new URL('/api/remote.mux', baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const controller = new AbortController();
    active.add(controller);
    const abortOuter = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortOuter, { once: true });

    const streamId = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
    const incoming = [];
    let wake = null;
    let finished = false;
    let sawFrame = false;
    let firstFrameTimer = null;

    const push = (frame) => {
      incoming.push(frame);
      sawFrame = true;
      wake?.();
      wake = null;
    };

    let socket;
    try {
      socket = new WS(url, { headers: { cookie } });
    } catch (error) {
      active.delete(controller);
      signal?.removeEventListener('abort', abortOuter);
      throw new TransportError('transport/connect', `remote.mux 连接失败: ${error?.message ?? error}`, { cause: error });
    }

    const finish = (frame) => {
      if (finished) return;
      finished = true;
      if (frame) push(frame);
      else wake?.();
      wake = null;
    };

    socket.addEventListener('message', (event) => {
      if (finished) return;
      let parsed;
      try {
        if (typeof event.data !== 'string') throw new Error('binary frame');
        parsed = JSON.parse(event.data);
      } catch (error) {
        // 单帧坏掉不该让整条流静默卡死：显式报成 stream error，交由上层 re-follow。
        finish({ type: 'error', error: { code: 'transport/malformed-frame', message: String(error?.message ?? error) } });
        return;
      }
      if (!isPlainObject(parsed) || typeof parsed.type !== 'string' || typeof parsed.streamId !== 'string') {
        finish({ type: 'error', error: { code: 'transport/malformed-frame', message: 'unexpected remote stream frame' } });
        return;
      }
      if (parsed.streamId !== streamId) return; // 同一 socket 上的别的流（本模块一 socket 一流，防御式处理）
      if (parsed.type === 'item') {
        if (!isPlainObject(parsed.value) || typeof parsed.value.type !== 'string') {
          finish({ type: 'error', error: { code: 'transport/malformed-frame', message: 'item 帧缺少 value.type' } });
          return;
        }
        push(parsed.value);
        return;
      }
      if (parsed.type === 'error') {
        finish({ type: 'error', error: parsed.error ?? null });
        return;
      }
      if (parsed.type === 'end') {
        finish({ type: 'end' });
        return;
      }
      finish({ type: 'error', error: { code: 'transport/unknown-frame', message: `未知 L1 帧类型 ${parsed.type}` } });
    });
    socket.addEventListener('open', () => {
      try {
        const request = { address: { kind: 'session', sessionId } };
        if (maxMessages !== undefined) request.maxMessages = maxMessages;
        if (assistantStream) request.assistantStream = true;
        socket.send(JSON.stringify({
          type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request } },
        }));
      } catch (error) {
        finish({ type: 'error', error: { code: 'transport/connect', message: `follow 请求发送失败: ${error?.message ?? error}` } });
      }
    });
    socket.addEventListener('close', () => {
      // 本端主动 close 后不会再收到服务端 end；WS 断开对上层就是「流结束」，必须 re-follow。
      finish({ type: 'end' });
    });
    socket.addEventListener('error', () => {
      finish({ type: 'error', error: { code: 'transport/socket-error', message: 'remote.mux socket error' } });
    });
    controller.signal.addEventListener('abort', () => {
      try { socket.close(); } catch { /* ignore */ }
      finish(null);
    }, { once: true });

    firstFrameTimer = setTimeout(() => {
      if (!sawFrame && !finished) {
        finish({ type: 'error', error: { code: 'transport/first-frame-timeout', message: `${firstFrameTimeoutMs}ms 内没收到任何帧` } });
      }
    }, firstFrameTimeoutMs);
    firstFrameTimer.unref?.();

    try {
      while (true) {
        while (incoming.length > 0) {
          const frame = incoming.shift();
          yield frame;
        }
        if (finished) return;
        await new Promise((resolve) => { wake = resolve; });
        if (finished && incoming.length === 0) return;
      }
    } finally {
      if (firstFrameTimer) clearTimeout(firstFrameTimer);
      active.delete(controller);
      signal?.removeEventListener('abort', abortOuter);
      if (!controller.signal.aborted) controller.abort('follow-consumer-stopped');
      try { socket.close(); } catch { /* ignore */ }
    }
  }

  /**
   * 读一页历史（gap 修补 / 往前翻历史）。
   *
   * 实测语义（务必按此使用）：
   *   · throughSeq **必填**，是**闭区间上界（含）**：返回记录的最大 seq 恒等于 throughSeq。
   *   · beforeSeq 是**开区间上界（不含）**：只返回 seq < beforeSeq 的记录。
   *   · 两者同时给时服务器取更小的那个界限；一般只给 throughSeq 即可。
   *   · throughSeq > 当前 cursor → TransportError(gateway/bad-request)；
   *     throughSeq < -1 → TransportError(gateway/bad-request)。所以「补洞」时要用
   *     throughSeq = 目标洞的前一条（<= 服务端当前尾），不要凭客户端 nextSeq 直接往前冲。
   *   · maxMessages 只数 user/message + assistant/message，缺省 50。
   *
   * @returns {Promise<{records: Array, hasMore: boolean}>}
   */
  async function page({ sessionId, throughSeq, beforeSeq, maxMessages } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TransportError('transport/invalid-argument', 'page 需要非空 sessionId');
    }
    // throughSeq 在服务端是必填（缺了会 gateway/input-invalid），这里提前拦，省一次网络往返。
    if (!isSeq(throughSeq)) {
      throw new TransportError('transport/invalid-argument',
        'page.throughSeq 必填且必须是 >= -1 的安全整数（DSH session/page 的边界校验强制要求；实测缺省会 gateway/input-invalid）',
        { details: { throughSeq: throughSeq ?? null } });
    }
    // 归一化「没给」：调用方（follow-client）习惯用 null 表示「无此锚点」，
    // 把它和 undefined 视为同一件事，别让一个显式 null 变成参数错误。
    const normalizedBeforeSeq = beforeSeq === null ? undefined : beforeSeq;
    const normalizedMaxMessages = maxMessages === null ? undefined : maxMessages;
    if (normalizedBeforeSeq !== undefined && (!Number.isSafeInteger(normalizedBeforeSeq) || normalizedBeforeSeq < 0)) {
      throw new TransportError('transport/invalid-argument', 'page.beforeSeq 必须是 >=0 的安全整数', { details: { beforeSeq } });
    }
    if (normalizedMaxMessages !== undefined && (!Number.isSafeInteger(normalizedMaxMessages) || normalizedMaxMessages < 1)) {
      throw new TransportError('transport/invalid-argument', 'page.maxMessages 必须是 >=1 的安全整数', { details: { maxMessages } });
    }
    if (!client) {
      throw new TransportError('transport/invalid-argument', 'page 需要带 callUnary 的 client');
    }

    // 线上 request 形状：{ address, throughSeq, beforeSeq?, maxMessages? }
    // （实测：写成 {sessionId} 会被 gateway/input-invalid 拒）
    const request = { address: { kind: 'session', sessionId }, throughSeq };
    if (normalizedBeforeSeq !== undefined) request.beforeSeq = normalizedBeforeSeq;
    if (normalizedMaxMessages !== undefined) request.maxMessages = normalizedMaxMessages;

    let response;
    try {
      response = await client.callUnary('session/page', request);
    } catch (error) {
      throw new TransportError('transport/page-failed', `session/page 调用失败: ${error?.message ?? error}`, { cause: error });
    }
    const result = response?.result;
    if (!isPlainObject(result)) {
      throw new TransportError('transport/bad-response', 'session/page 没有返回 result 信封');
    }
    if (!result.ok) {
      throw new TransportError(result.error?.code ?? 'gateway/internal',
        result.error?.message ?? 'session/page 失败', { details: result.error?.details ?? null });
    }
    const value = result.value;
    if (!isPlainObject(value) || !Array.isArray(value.records)) {
      throw new TransportError('transport/bad-response', 'session/page 的 value.records 不是数组', { details: value ?? null });
    }
    if (typeof value.hasMore !== 'boolean') {
      throw new TransportError('transport/bad-response', 'session/page 的 value.hasMore 不是布尔值', { details: { hasMore: value.hasMore ?? null } });
    }
    return { records: value.records, hasMore: value.hasMore };
  }

  /** 关掉所有在飞的 follow（不会影响 client 本身的 HTTP 会话）。 */
  function close() {
    for (const controller of [...active]) {
      try { controller.abort('transport-closed'); } catch { /* ignore */ }
    }
    active.clear();
  }

  return { openFollow, page, close, mode: 'live', baseUrl, closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS };
}

export default createDshHttpTransport;
