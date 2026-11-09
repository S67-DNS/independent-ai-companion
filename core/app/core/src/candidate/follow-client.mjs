// follow 驱动器：把 `AsyncIterable<frame>` 的 follow 流、page 修补与重连粘成一个可用客户端。
//
// 分层边界（与契约 §D 一致）：
//   - `follow-protocol.mjs` 只管「帧 → 状态」，纯函数式、可逐帧单测；
//   - 本文件只管「流 → 帧 → 状态机 → 回调」的驱动：重连、generation、gap 修复、stop。
//
// transport 契约（由集成方注入，真实实现由 Lead 的适配层提供）：
//   transport.openFollow({ sessionId })                     → AsyncIterable<frame>
//   transport.page({ sessionId, throughSeq, beforeSeq, maxMessages }) → { records, hasMore }
//   frame 是 L3 帧（snapshot / event / end）；本文件也容忍 remote.mux 的 L1 item 外壳。
//
// 驱动语义（GLM-DSH-FOLLOW-PROTOCOL-001 §3/§4）：
//   1. 每条流的**首帧必须是 snapshot**，否则 ERR.CONTRACT（fail closed：没有基线就不能开始）。
//   2. snapshot 到达 → onBaseline({cursor, projections, hasMore, generation})；
//      随后逐条回放 replayedEvents，onEvent({..., fromSnapshot:true})。
//      历史 turn/end 就是这样被显式打上 fromSnapshot 的——下游据此**不得**把它当新回合。
//   3. 后续 event 帧：== nextSeq 应用；< nextSeq 丢弃（duplicate）；> nextSeq → gap。
//   4. gap → 调 page 修补；修补出来的事件按 live 事件（fromSnapshot:false）交付，
//      再重放触发 gap 的那一帧（若已被 page 覆盖则变成 duplicate，自然去重）。
//   5. `end` 帧（归档/回收/错误）是常规事件：退出当前流并 re-follow。新流的 opening snapshot
//      替换已发布窗口，generation 由状态机 +1；cursor 落后于已应用尾 → ERR.CONTRACT。
//   6. 传输层抛错（非协议违约）同样按「流结束」处理并 re-follow。
//      协议违约（CONTRACT/INVALID_ARGUMENT/INTERNAL）**不重试**：重试只会把同一份坏数据再喂一遍。
//
// 边界：本文件只消费 per-session follow 流。host 级 control 流（opening baseline + replacement 帧）
// 是另一条流，不在这里解析；若上游误把 `baseline` 等 control 帧混进 follow，状态机会把它当
// unknown-frame ignored，**不会**误当成会话事件。
//
// 为什么协议错误不当作传输错误重试：传输错误是「这条管道断了」，换一条还能对上；
// 协议违约是「两边对协议的理解不一致」，重试只会无限放大错误。fail closed 是这里的硬约束。

import { CandidateError, ERR, isCode } from './errors.mjs';
import { createFollowState, normalizeFrame } from './follow-protocol.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 这些 code 表示「协议/调用方式有问题」，重试无意义，直接终止。 */
const FATAL_CODES = Object.freeze([ERR.CONTRACT, ERR.INVALID_ARGUMENT, ERR.INTERNAL]);

function fatal(error) {
  return isCode(error, ...FATAL_CODES);
}

function asAsyncIterator(stream, sessionId) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new CandidateError(ERR.CONTRACT, 'transport.openFollow 必须返回 AsyncIterable', {
      sessionId,
      got: stream === null ? 'null' : typeof stream,
    });
  }
  return stream[Symbol.asyncIterator]();
}

/**
 * 创建一个 follow 客户端。
 *
 * @param {object} opts
 * @param {{openFollow:Function,page:Function}} opts.transport 注入的 transport（真实/脚本化均可）
 * @param {() => number} [opts.now] 时间源（测试可注入；目前只用于诊断戳）
 * @param {number} [opts.reconnectDelayMs] 两条流之间的退避；测试可传 0
 * @param {number} [opts.pageSize] 传给 page 的 maxMessages
 * @param {number} [opts.maxFollowAttempts] 最多尝试打开多少条流（防对死会话无限重连）
 */
export function createFollowClient({
  transport,
  now = Date.now,
  reconnectDelayMs = 100,
  pageSize = 50,
  maxFollowAttempts = Infinity,
} = {}) {
  if (transport === null || typeof transport !== 'object') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'createFollowClient 需要 transport 对象');
  }
  if (typeof transport?.openFollow !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'transport.openFollow 必须是函数');
  }
  if (typeof transport?.page !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'transport.page 必须是函数');
  }
  if (typeof now !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'now 必须是函数');
  }
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'reconnectDelayMs 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'pageSize 必须是正整数');
  }
  if (maxFollowAttempts !== Infinity && (!Number.isSafeInteger(maxFollowAttempts) || maxFollowAttempts < 1)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'maxFollowAttempts 必须是正整数或 Infinity');
  }

  /**
   * 订阅一个会话的 follow 流。
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {(ev:{sessionId:string,event:object,seq:number,fromSnapshot:boolean}) => void} [opts.onEvent]
   * @param {(baseline:{cursor:number,projections:object,hasMore:boolean,generation:number}) => void} [opts.onBaseline]
   * @param {number} [opts.maxGapRepair] 单个 gap 最多翻几页 page
   * @returns {{stop:Function, done:Promise<object>, state:object, stats:object}}
   */
  return {
    follow({ sessionId, onEvent = () => {}, onBaseline = () => {}, maxGapRepair = 5 } = {}) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'follow.sessionId 必须是非空字符串');
      }
      if (typeof onEvent !== 'function' || typeof onBaseline !== 'function') {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'onEvent / onBaseline 必须是函数');
      }
      if (!Number.isSafeInteger(maxGapRepair) || maxGapRepair < 1) {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'maxGapRepair 必须是正整数');
      }

      // 状态机跨「流」存活：re-follow 时 generation/cursor 必须连续，否则重连校验就形同虚设。
      const state = createFollowState();
      const stats = {
        streamsOpened: 0,
        baselines: 0,
        events: 0,
        replayed: 0,
        duplicates: 0,
        gaps: 0,
        pages: 0,
        pageApplied: 0,
        ignored: 0,
        endFrames: 0,
        transportErrors: 0,
        lastFrameAtMs: null,
      };
      const controller = { stopped: false, iterator: null, settled: false };
      let resolveDone;
      let rejectDone;
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // 调用方即使不处理 done，也不该让 Node 把拒绝当成未处理异常崩溃；
      // 但 await done 依然能拿到同一个拒绝（异常不会被吞掉，只是没人听时不吵）。
      done.catch(() => {});

      const settle = (payload) => {
        if (controller.settled) return;
        controller.settled = true;
        if (payload.ok) resolveDone(payload);
        else rejectDone(payload.error);
      };

      const deliver = (event, seq, fromSnapshot) => {
        if (controller.stopped) return;
        stats.events += 1;
        stats.lastFrameAtMs = now();
        try {
          onEvent({ sessionId, event, seq, fromSnapshot });
        } catch (error) {
          // 回调是调用方的代码；它抛错时若当成传输错误重连，会无限重放同一批事件。
          throw new CandidateError(ERR.INTERNAL, 'onEvent 回调抛错', { cause: String(error?.stack ?? error) });
        }
      };

      const emitBaseline = (baseline) => {
        if (controller.stopped) return;
        stats.baselines += 1;
        stats.lastFrameAtMs = now();
        try {
          onBaseline({
            cursor: baseline.cursor,
            projections: baseline.projections,
            hasMore: baseline.hasMore,
            generation: baseline.generation,
          });
        } catch (error) {
          throw new CandidateError(ERR.INTERNAL, 'onBaseline 回调抛错', { cause: String(error?.stack ?? error) });
        }
      };

      /**
       * 用 page API 修补 gap。
       *
       * **YYYY-MM-DD 实测修正（DSH 0.2.1-rc.5 隔离实例，见 reports/DSH-RC5-PROTOCOL-CAPTURE.md）**：
       * `session/page` 的 `throughSeq` 是**闭区间上界**——返回记录的 max seq 恒等于 throughSeq，
       * 从不越界（`throughSeq=-1` 返回空，`throughSeq>cursor` 报 `gateway/bad-request`）。
       * 因此补洞锚点是「触发 gap 的那条事件的 seq - 1」，而不是「已应用尾 - 1」。
       *
       * 分页是**向后**的：一页可能只给到 4、5 而缺 3。所以这里累积多页原始记录，
       * 按 seq 升序去重后一次性交给状态机；逐页 apply 会把缺口前的记录直接丢掉。
       */
      const repairGap = async (gap) => {
        const bySeq = new Map(); // seq -> record（跨页累积）
        let throughSeq = Number.isInteger(gap.got) ? gap.got - 1 : state.cursor - 1;
        let lastMin = null;
        for (let attempt = 1; attempt <= maxGapRepair; attempt += 1) {
          if (controller.stopped) return [];
          let response;
          try {
            response = await transport.page({ sessionId, throughSeq, beforeSeq: null, maxMessages: pageSize });
          } catch (error) {
            if (controller.stopped) return [];
            throw error; // 传输错误交给外层按流结束处理（re-follow）
          }
          if (!isPlainObject(response) || !Array.isArray(response.records) || typeof response.hasMore !== 'boolean') {
            throw new CandidateError(ERR.CONTRACT, 'transport.page 必须返回 { records:Array, hasMore:boolean }', {
              throughSeq,
              got: gap.got,
            });
          }
          stats.pages += 1;
          for (const record of response.records) {
            const seq = Number(record?.event?.seq ?? record?.seq);
            if (Number.isInteger(seq) && !bySeq.has(seq)) bySeq.set(seq, record);
          }
          const seqs = [...bySeq.keys()];
          const minSeq = seqs.length ? Math.min(...seqs) : null;

          if (minSeq !== null && minSeq <= gap.expected && Math.max(...seqs) >= gap.got - 1) {
            const records = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
            const merged = state.applyPage({ records, hasMore: false });
            stats.pageApplied += merged.applied;
            if (merged.gapCleared) {
              return [...merged.appliedEvents].sort((a, b) => a.seq - b.seq);
            }
            if (!response.hasMore) {
              throw new CandidateError(ERR.CONTRACT, `page 已尽仍未补齐 seq ${gap.expected}..${gap.got - 1}`, {
                expected: gap.expected, got: gap.got, cursor: state.cursor, throughSeq,
              });
            }
          } else if (!response.hasMore) {
            throw new CandidateError(ERR.CONTRACT, `page 已尽仍未覆盖缺口 seq ${gap.expected}..${gap.got - 1}`, {
              expected: gap.expected, got: gap.got, throughSeq, minSeq,
            });
          }

          if (minSeq === null) throw new CandidateError(ERR.CONTRACT, 'page 返回空记录，无法补齐缺口', { throughSeq });
          if (lastMin !== null && minSeq >= lastMin) {
            throw new CandidateError(ERR.CONTRACT, 'page 修复没有取得进展（窗口未继续向前）', {
              expected: gap.expected, got: gap.got, throughSeq, minSeq, lastMin,
            });
          }
          lastMin = minSeq;
          throughSeq = minSeq - 1; // 继续往更早翻
        }
        throw new CandidateError(ERR.CONTRACT, `page 修复达到 maxGapRepair=${maxGapRepair} 仍未补齐`, {
          expected: gap.expected,
          got: gap.got,
          cursor: state.cursor,
          maxGapRepair,
        });
      };

/** 处理一条已经通过 normalizeFrame 的 L3 帧；返回 'continue' 或 'stream-end'。 */
      const handleFrame = async (frame) => {
        if (controller.stopped) return 'stream-end';
        if (frame.type === 'error') {
          throw new CandidateError(ERR.UPSTREAM, 'follow 流收到 transport error 帧', {
            detail: typeof frame.error === 'object' ? JSON.stringify(frame.error).slice(0, 300) : String(frame.error ?? ''),
          });
        }
        if (frame.type === 'snapshot') {
          // 正常情况下每个 flow() 只消费首帧快照；同一条流里再出现快照说明服务端/transport 违约。
          throw new CandidateError(ERR.CONTRACT, '同一条 follow 流内出现第二个 opening snapshot');
        }
        const result = state.accept(frame);
        switch (result.kind) {
          case 'event':
            // accept() 只会返回 live 事件（快照回放走 runStream 的首帧分支），fromSnapshot 恒为 false。
            deliver(result.event, result.seq, false);
            return 'continue';
          case 'duplicate':
            stats.duplicates += 1;
            return 'continue';
          case 'gap': {
            stats.gaps += 1;
            const repaired = await repairGap(result);
            for (const item of repaired) {
              if (controller.stopped) return 'stream-end';
              deliver(item.event, item.seq, false);
            }
            // page 可能已经把触发 gap 的那一帧也补进来了；重新 accept 一次：
            // 已覆盖 → duplicate（自然去重）；仍未覆盖 → 正常应用。
            const replay = state.accept(frame);
            if (replay.kind === 'event') deliver(replay.event, replay.seq, false);
            else if (replay.kind !== 'duplicate') {
              throw new CandidateError(ERR.CONTRACT, `gap 修复后重放该帧仍无法应用：${replay.kind}`, {
                expected: result.expected,
                got: result.got,
              });
            }
            return 'continue';
          }
          case 'end':
            stats.endFrames += 1;
            return 'stream-end';
          case 'ignored':
            stats.ignored += 1;
            return 'continue';
          case 'error':
            throw new CandidateError(ERR.UPSTREAM, 'follow 流收到 transport error 帧');
          default:
            throw new CandidateError(ERR.CONTRACT, `状态机返回未知结果：${String(result.kind)}`);
        }
      };

      const runStream = async (iterator) => {
        let sawSnapshot = false;
        for (;;) {
          if (controller.stopped) return;
          const step = await iterator.next();
          if (controller.stopped) return;
          if (step.done) {
            if (!sawSnapshot) {
              throw new CandidateError(ERR.CONTRACT, 'follow 流在 opening snapshot 之前结束（无法建立基线）');
            }
            return; // 传输层直接结束：按流结束处理，外层 re-follow
          }
          const frame = normalizeFrame(step.value);
          if (!sawSnapshot) {
            if (frame.type !== 'snapshot') {
              throw new CandidateError(ERR.CONTRACT, `follow 首帧必须是 snapshot，实际收到 "${frame.type}"`, {
                type: frame.type,
              });
            }
            const applied = state.applySnapshot(frame);
            sawSnapshot = true;
            stats.lastFrameAtMs = now();
            emitBaseline(applied.baseline);
            for (const item of applied.replayedEvents) {
              if (controller.stopped) return;
              stats.replayed += 1;
              deliver(item.event, item.seq, true);
            }
            continue;
          }
          const outcome = await handleFrame(frame);
          if (outcome === 'stream-end') return;
        }
      };

      const run = async () => {
        let attempts = 0;
        for (;;) {
          if (controller.stopped) break;
          attempts += 1;
          if (attempts > maxFollowAttempts) {
            throw new CandidateError(ERR.CONTRACT, `follow 重连次数超过上限 maxFollowAttempts=${maxFollowAttempts}`);
          }
          let stream;
          try {
            stats.streamsOpened += 1;
            stream = transport.openFollow({ sessionId });
          } catch (error) {
            if (controller.stopped) break;
            if (fatal(error)) throw error;
            stats.transportErrors += 1;
            if (reconnectDelayMs > 0) await sleep(reconnectDelayMs);
            continue;
          }
          let iterator;
          try {
            iterator = asAsyncIterator(stream, sessionId);
            controller.iterator = iterator;
            await runStream(iterator);
          } catch (error) {
            if (controller.stopped) break;
            if (fatal(error)) throw error;
            stats.transportErrors += 1;
          } finally {
            controller.iterator = null;
            try { await iterator?.return?.(); } catch { /* transport 关闭失败不影响状态机 */ }
          }
          if (controller.stopped) break;
          if (reconnectDelayMs > 0) await sleep(reconnectDelayMs);
        }
        settle({ ok: true, reason: controller.stopped ? 'stopped' : 'ended' });
      };

      const settleError = (error) => {
        settle({ ok: false, error });
      };
      void run().catch(settleError);

      const stop = () => {
        if (controller.stopped) return;
        controller.stopped = true;
        // 主动让当前流结束：挂起的 next() 在 transport 支持时会立刻 done；
        // 不支持立刻中断的 transport 最多等它当前那次 await 返回（见 done 的说明）。
        const iterator = controller.iterator;
        if (iterator && typeof iterator.return === 'function') {
          try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* ignore */ }
        }
      };

      return {
        stop,
        done,
        /** 诊断用：当前状态机（只读意图，勿改）。 */
        get state() { return state; },
        get stats() { return { ...stats }; },
      };
    },
  };
}
