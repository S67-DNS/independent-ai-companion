// DSH follow 流纯状态机：无 IO、无计时器、无网络，可以逐帧喂给测试。
//
// 为什么单独拆一个状态机：follow / snapshot 对账是整条PROJECT_NAME链路里最容易「静默错」的地方——
// 漏一个快照就丢历史、重复应用一帧就重复回复、快照里的历史 turn/end 被当成新回合就会把
// 早已结束的回复再发一遍。把「seq 门控 + 快照替换 + gap 修补」收敛成一个纯函数式状态机，
// 就能在没有任何真实 DSH 的情况下逐帧验证这些错误形态。
//
// ── 协议帧序列（DSH 0.2.1-rc.5；取证：GLM-DSH-FOLLOW-PROTOCOL-001 §1/§3/§4）────────────
// transport 负责剥掉 remote.mux 的 L1 外壳（{type:'item'|'error'|'end', streamId, value}），
// 本模块只看 L3 帧：
//   1) 首帧 snapshot（**线上帧名就是 snapshot**）：
//        { type:'snapshot', header, cursor, records:[{type:'event',event}], hasMore,
//          projections:{asOfSeq, values} }
//        - cursor = 服务端当前日志尾 seq；records 只是最近约 50 条消息事件的窗口，
//          不是全量历史；更早的记录必须走 page 翻页。
//        - 快照里的历史事件一律 fromSnapshot:true；其中的 turn/end 绝不能被当成新回合，
//          否则会重发回复（桥 dsh-client.js:836-837 明确记录过这个坑）。
//   2) 后续 { type:'event', event }：event.seq 单调；只有 seq === nextSeq 才允许应用。
//   3) 可选 assistant-stream：仅当 follow 请求 assistantStream:true 才下发；本模块 opt-in 关闭，
//      遇到一律 ignored（不建立、不修改任何状态）。
//   4) { type:'end' }：归档/回收/服务端错误都会走到这里；它是**常规事件**，调用方必须 re-follow。
//      新 generation 的新 opening snapshot 会替换已发布窗口；替换只在新快照到达后发生。
//
// 线上帧名是 snapshot。桥内部的 `session/snapshot` 信封名**不是** DSH 线上帧
// （GLM §4.5 / GLM-DSH-READONLY-AUDIT F15）。本模块拒绝把它当快照，只能返回 ignored——
// 这是防「假基线」的硬约束：旧代码正是因为只认 session/event、把 session/snapshot 当快照，
// 才在重连后丢掉了整段历史。
//
// ── 状态迁移（cursor = 已应用日志尾 seq；nextSeq = cursor + 1）─────────────────────────
//   初始：cursor = maxScannedSeq > 0 ? maxScannedSeq : -1；generation = 0；baseline = null
//   applySnapshot(S)          → 校验 S.cursor 不落后于已应用尾 → baseline 被替换；generation+1；
//                               cursor = S.cursor；nextSeq = cursor+1；
//                               回放 records 中 seq > 旧 cursor 的事件（replayedEvents，全部 fromSnapshot）
//   accept(event, seq < nextSeq)  → duplicate（丢弃，不推进 cursor）
//   accept(event, seq == nextSeq) → event（cursor = seq，nextSeq+1）
//   accept(event, seq > nextSeq)  → gap（不推进；记录 pendingGap；必须用 page 修补）
//   applyPage({records})          → 从 nextSeq 起连续合并；pendingGap 未补齐且 hasMore=false ⇒ ERR.CONTRACT
//   accept(end)                   → end（ended = true；generation 不变，等下一份 snapshot 才 +1）
//   accept(其它帧)                 → ignored（**不改任何状态**；snapshot/旧信封/assistant-stream 都在这里）
//
// 一个刻意的取舍：gap 之前的事件不会被「跳过」推进。跳着推进 cursor 会让后续所有 seq 校验
// 变成假阳/假阴，而 gap 本来就是要用 page 从服务端补齐的东西。

import { CandidateError, ERR } from './errors.mjs';

/** DSH 线上快照帧名（不是 `session/snapshot`）。 */
export const WIRE_SNAPSHOT = 'snapshot';
/** 旧桥内部信封名：只在桥自己的 dsh-client.js 里出现，**不是**线上帧。 */
export const LEGACY_SNAPSHOT_ENVELOPE = 'session/snapshot';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * 把 transport 层可能漏出来的 remote.mux L1 帧解成 L3 帧。
 *
 * transport 的契约是「直接 yield L3 帧」，但线上实际是三层：L1 mux 的 item 帧包着 L3 值。
 * 这里容忍一层 item 外壳（解包后递归一次），并把 L1 error 帧显式标记出来；除此之外不做
 * 任何猜测——未知帧原样返回，交给 accept() 判 ignored。
 *
 * depth 上限是防「自引用 item 链」造成无限递归：协议最多三层，超过 4 层必然不是合法帧。
 */
export function normalizeFrame(frame, depth = 0) {
  if (!isPlainObject(frame)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'follow 帧必须是对象', { got: typeof frame });
  }
  if (typeof frame.type !== 'string' || frame.type.length === 0) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'follow 帧缺少字符串 type', { keys: Object.keys(frame).slice(0, 8) });
  }
  if (frame.type === 'item') {
    if (depth >= 4) {
      throw new CandidateError(ERR.CONTRACT, 'remote.mux item 帧嵌套过深（疑似自引用），拒绝继续解包');
    }
    // L1：{ type:'item', streamId, value: <L3 帧> }
    if (!isPlainObject(frame.value)) {
      throw new CandidateError(ERR.CONTRACT, 'remote.mux item 帧缺少 value', { streamId: frame.streamId ?? null });
    }
    return normalizeFrame(frame.value, depth + 1);
  }
  if (frame.type === 'error') {
    return { type: 'error', error: frame.error ?? frame.value ?? null };
  }
  return frame;
}

/**
 * 取出一条 event 记录里的 event 对象。
 * - 协议线格式：{ type:'event', event }
 * - snapshot/page 里的历史条目在桥侧实测里两种形态都出现过（桥用 `entry.type === 'event' ? entry.event : entry`），
 *   这里沿用同样的容忍度，但 event 本身必须合法（见 requireEventRecord）。
 */
export function eventOfRecord(record) {
  if (!isPlainObject(record)) {
    throw new CandidateError(ERR.CONTRACT, '事件记录必须是对象', { got: typeof record });
  }
  return record.type === 'event' ? record.event : record;
}

/** 校验一条事件记录，返回 { event, seq }；不合法一律 ERR.CONTRACT（fail closed）。 */
function requireEventRecord(record, label) {
  const event = eventOfRecord(record);
  if (!isPlainObject(event)) {
    throw new CandidateError(ERR.CONTRACT, `${label} 里的事件必须是对象`);
  }
  if (!isSeq(event.seq)) {
    throw new CandidateError(ERR.CONTRACT, `${label} 里的事件 seq 必须是非负安全整数`, { seq: event.seq ?? null });
  }
  if (typeof event.type !== 'string' || event.type.length === 0) {
    throw new CandidateError(ERR.CONTRACT, `${label} 里的事件缺少字符串 type`);
  }
  return { event, seq: event.seq };
}

/**
 * follow 流状态机。构造函数不对外直接使用；请用 {@link createFollowState}。
 *
 * @param {{ maxScannedSeq?: number }} [opts]
 *   maxScannedSeq：上一次进程已扫描到的最高 seq（持久化恢复用）。>0 时会作为初始
 *   「已应用尾」，于是第一份 snapshot 的 cursor 落后于它就会被判契约违规——这正是
 *   「重连时新流 opening cursor 不得落后于已应用尾」的第一道防线。
 */
export class FollowState {
  #cursor;
  #generation = 0;
  #baseline = null;
  #header = null;
  #pendingGap = null;
  #ended = false;
  #stats = { snapshots: 0, replayed: 0, applied: 0, duplicates: 0, gaps: 0, ignored: 0, pageMerges: 0, pageApplied: 0 };

  constructor({ maxScannedSeq = 0 } = {}) {
    if (!Number.isSafeInteger(maxScannedSeq) || maxScannedSeq < 0) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'maxScannedSeq 必须是非负安全整数', { maxScannedSeq });
    }
    // maxScannedSeq=0 表示「什么都没扫过」，用 -1 表示「已应用尾在第一条事件之前」。
    // 这样 0 基 / 1 基 seq 的两种服务端实现都不会被初始值误伤。
    this.#cursor = maxScannedSeq > 0 ? maxScannedSeq : -1;
  }

  /** 已应用日志尾 seq；-1 表示尚未应用任何事件。 */
  get cursor() { return this.#cursor; }
  /** 下一条期望的事件 seq（= cursor + 1）。 */
  get nextSeq() { return this.#cursor + 1; }
  /** opening snapshot 的代数：每消费一份新快照 +1。 */
  get generation() { return this.#generation; }
  /** 当前已发布的基线（{cursor, projections, hasMore, generation}），未建立时为 null。 */
  get baseline() { return this.#baseline; }
  /** 已发布的 header（不放进 baseline 契约，仅供诊断）。 */
  get header() { return this.#header; }
  /** 待修复的 gap：{expected, got} 或 null。 */
  get pendingGap() { return this.#pendingGap ? { ...this.#pendingGap } : null; }
  /** 流是否已被 end（re-follow 后由新 snapshot 清除）。 */
  get ended() { return this.#ended; }
  /** 计数（测试/诊断用）。 */
  get stats() { return { ...this.#stats }; }

  /**
   * 消费一份 opening snapshot：替换已发布窗口、推进 generation、回放（标记 fromSnapshot 的）历史事件。
   *
   * @param {object} snapshot 线上 snapshot 帧本身，或同字段对象（允许不带 type）。
   * @returns {{baseline:object, replayedEvents:Array<{event:object,seq:number,fromSnapshot:true}>, replaced:boolean, generation:number}}
   */
  applySnapshot(snapshot) {
    // 契约允许直接把 { header, cursor, records, hasMore, projections } 传进来（不带 type）；
    // 带 type 的一律按帧校验收解（含 L1 item 外壳）。
    const bareFields = isPlainObject(snapshot)
      && (typeof snapshot.type !== 'string' || snapshot.type.length === 0);
    const frame = bareFields ? snapshot : normalizeFrame(snapshot);
    if (frame.type === LEGACY_SNAPSHOT_ENVELOPE) {
      throw new CandidateError(ERR.CONTRACT, '拒绝把 session/snapshot 当快照：它是旧桥内部信封名，不是 DSH 线上帧名 snapshot', {
        type: frame.type,
      });
    }
    if (frame.type !== undefined && frame.type !== WIRE_SNAPSHOT) {
      throw new CandidateError(ERR.CONTRACT, `applySnapshot 只接受 type:"${WIRE_SNAPSHOT}"，收到 "${frame.type}"`);
    }

    const cursor = frame.cursor;
    if (!Number.isSafeInteger(cursor) || cursor < -1) {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.cursor 必须是 >= -1 的安全整数', { cursor: cursor ?? null });
    }
    // 重连校验：新流 opening cursor 不得落后于已应用尾（GLM §3「resume cursor 只用于两个校验」之一）。
    if (this.#cursor >= 0 && cursor < this.#cursor) {
      throw new CandidateError(ERR.CONTRACT, `新 opening snapshot 的 cursor(${cursor}) 落后于已应用尾(${this.#cursor})`, {
        incomingCursor: cursor,
        appliedTail: this.#cursor,
      });
    }
    // header 的具体内容取证报告没有枚举（GLM §6 未验证项），所以只校验「字段存在」，
    // 不假设它是哪种 JSON 类型——用未验证的假设去拒绝真实帧，属于自造协议。
    if (frame.header === undefined) {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.header 字段缺失');
    }
    if (!Array.isArray(frame.records)) {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.records 必须是数组');
    }
    if (typeof frame.hasMore !== 'boolean') {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.hasMore 必须是布尔值');
    }
    if (!isPlainObject(frame.projections)) {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.projections 必须是对象');
    }
    if (frame.projections.values !== undefined && !isPlainObject(frame.projections.values)) {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.projections.values 必须是对象');
    }
    if (frame.projections.asOfSeq !== undefined && !Number.isSafeInteger(frame.projections.asOfSeq)) {
      throw new CandidateError(ERR.CONTRACT, 'snapshot.projections.asOfSeq 必须是安全整数');
    }

    // records 必须是「窗口内」的连续历史：seq 严格递增、不越界到 cursor 之后。
    const parsed = [];
    let prevSeq = -1;
    for (const entry of frame.records) {
      const { event, seq } = requireEventRecord(entry, 'snapshot.records');
      if (seq > cursor) {
        throw new CandidateError(ERR.CONTRACT, `snapshot.records 含超出 cursor(${cursor}) 的未来事件 seq=${seq}`, { cursor, seq });
      }
      if (seq <= prevSeq) {
        throw new CandidateError(ERR.CONTRACT, 'snapshot.records 必须按 seq 严格递增', { previous: prevSeq, seq });
      }
      prevSeq = seq;
      parsed.push({ event, seq });
    }

    // 回放过滤：已经应用过的事件不再作为「新事件」回放（重连时窗口会与已发布尾部重叠）。
    const replayFloor = this.#cursor;
    const replayedEvents = parsed
      .filter(({ seq }) => seq > replayFloor)
      .map(({ event, seq }) => Object.freeze({ event, seq, fromSnapshot: true }));

    const replaced = this.#baseline !== null;
    this.#generation += 1;
    this.#cursor = cursor;
    this.#pendingGap = null;
    this.#ended = false;
    this.#header = frame.header;
    this.#baseline = Object.freeze({
      cursor,
      projections: frame.projections,
      hasMore: frame.hasMore,
      generation: this.#generation,
    });
    this.#stats.snapshots += 1;
    this.#stats.replayed += replayedEvents.length;

    return Object.freeze({
      baseline: this.#baseline,
      replayedEvents: Object.freeze(replayedEvents),
      replaced,
      generation: this.#generation,
    });
  }

  /**
   * 消费一条非快照帧。
   *
   * @param {object} frame L3 帧（或带一层 item 外壳的 L1 帧）
   * @returns {{kind:'event'|'duplicate'|'gap'|'end'|'ignored'|'error', event?:object, seq?:number, expected?:number, got?:number, fromSnapshot?:false, reason?:string, type?:string, legacyEnvelope?:boolean, error?:any, generation?:number}}
   */
  accept(frame) {
    const f = normalizeFrame(frame);

    if (f.type === 'error') {
      // L1 mux 的 error 帧：不是 L3 协议事件，原样交给驱动器按「流错误」处理（re-follow）。
      return { kind: 'error', error: f.error ?? null };
    }
    if (f.type === 'end') {
      this.#ended = true;
      return { kind: 'end', generation: this.#generation };
    }

    // 非 event/end 的帧一律 ignored，且**绝不改动状态**。
    // 这正是旧实现最关键的缺陷点：把 `session/snapshot` 当快照会静默建立假基线。
    if (f.type === WIRE_SNAPSHOT) {
      this.#stats.ignored += 1;
      return { kind: 'ignored', reason: 'snapshot-frame-outside-opening', type: f.type, applied: false };
    }
    if (f.type === LEGACY_SNAPSHOT_ENVELOPE) {
      this.#stats.ignored += 1;
      return {
        kind: 'ignored',
        reason: 'legacy-envelope-not-wire-frame',
        type: f.type,
        legacyEnvelope: true,
        applied: false,
      };
    }
    if (f.type === 'assistant-stream') {
      this.#stats.ignored += 1;
      return { kind: 'ignored', reason: 'assistant-stream-opt-in-disabled', type: f.type, applied: false };
    }
    if (f.type !== 'event') {
      this.#stats.ignored += 1;
      return { kind: 'ignored', reason: 'unknown-frame', type: f.type, applied: false };
    }

    // 以下是 event 帧：必须先有快照基线，且流不能处于 ended。
    if (this.#baseline === null) {
      throw new CandidateError(ERR.CONTRACT, '尚未建立 opening snapshot 基线就收到事件帧（follow 必须 snapshot-first）');
    }
    if (this.#ended) {
      throw new CandidateError(ERR.CONTRACT, 'follow 流已 end，不应再收到事件帧');
    }

    const { event, seq } = requireEventRecord(f, 'event 帧');
    if (seq < this.nextSeq) {
      this.#stats.duplicates += 1;
      return { kind: 'duplicate', seq };
    }
    if (seq > this.nextSeq) {
      this.#stats.gaps += 1;
      const expected = this.nextSeq;
      this.#pendingGap = { expected, got: seq };
      return { kind: 'gap', expected, got: seq, seq, event };
    }
    this.#cursor = seq;
    this.#stats.applied += 1;
    return { kind: 'event', event, seq, fromSnapshot: false };
  }

  /**
   * 合并一页 page 结果（gap 修复/历史翻页）。
   *
   * 只从 nextSeq 起连续应用：中间仍有洞就停下，绝不跳着推进 cursor。
   * pendingGap 未补齐时：
   *   - hasMore === true  → 返回 gapCleared:false，调用方继续向更早翻页；
   *   - hasMore !== true  → ERR.CONTRACT（页已经见底还是补不齐，就是协议违约，fail closed）。
   *
   * @param {{records: Array, hasMore?: boolean}} page
   * @returns {{applied:number, cursor:number, appliedEvents:Array<{event:object,seq:number,fromSnapshot:false}>, gapCleared:boolean, holeAt:number|null}}
   */
  applyPage({ records, hasMore = false } = {}) {
    if (this.#baseline === null) {
      throw new CandidateError(ERR.CONTRACT, '尚未建立 opening snapshot 基线，不能应用 page 记录');
    }
    if (this.#ended) {
      throw new CandidateError(ERR.CONTRACT, 'follow 流已 end，不应再应用 page 记录');
    }
    if (!Array.isArray(records)) {
      throw new CandidateError(ERR.CONTRACT, 'applyPage.records 必须是数组');
    }
    if (typeof hasMore !== 'boolean') {
      throw new CandidateError(ERR.CONTRACT, 'applyPage.hasMore 必须是布尔值');
    }

    const parsed = [];
    let prevSeq = -1;
    for (const entry of records) {
      const { event, seq } = requireEventRecord(entry, 'page.records');
      if (seq <= prevSeq) {
        throw new CandidateError(ERR.CONTRACT, 'page.records 必须按 seq 严格递增（同一页内不得重复）', { previous: prevSeq, seq });
      }
      prevSeq = seq;
      parsed.push({ event, seq });
    }

    const appliedEvents = [];
    let holeAt = null;
    for (const { event, seq } of parsed) {
      if (seq <= this.#cursor) continue; // 与已发布尾部重叠：丢弃（防重）
      if (seq !== this.#cursor + 1) { holeAt = seq; break; } // 中间还有洞：停止推进
      this.#cursor = seq;
      appliedEvents.push(Object.freeze({ event, seq, fromSnapshot: false }));
      this.#stats.pageApplied += 1;
    }
    this.#stats.pageMerges += 1;

    const gap = this.#pendingGap;
    if (gap) {
      const target = gap.got - 1; // 只要补到「被跳过的那个事件的前一条」，重放原帧即可接上
      if (this.#cursor >= target) {
        this.#pendingGap = null;
        return { applied: appliedEvents.length, cursor: this.#cursor, appliedEvents, gapCleared: true, holeAt: null };
      }
      if (hasMore !== true) {
        throw new CandidateError(ERR.CONTRACT, `page 已尽仍未补齐 seq ${gap.expected}..${target}（当前尾 ${this.#cursor}）`, {
          expected: gap.expected,
          target,
          got: gap.got,
          cursor: this.#cursor,
          holeAt,
        });
      }
      return { applied: appliedEvents.length, cursor: this.#cursor, appliedEvents, gapCleared: false, holeAt };
    }

    return { applied: appliedEvents.length, cursor: this.#cursor, appliedEvents, gapCleared: false, holeAt };
  }
}

/** 工厂函数（契约 API）。 */
export function createFollowState(options = {}) {
  return new FollowState(options);
}
