// 脚本化假 transport：给 follow-client 的端到端测试用，不碰网络、不碰真实 DSH。
//
// 为什么要一个「可编程的流」而不是直接喂数组：follow 驱动器的正确性主要在**时序**上——
// 流被 end、传输层抛错、gap 修复期间 stop()、重连后再开一条流。只有把「每次 openFollow
// 对应一段脚本」显式写出来，测试才能证明「re-follow 真的发生了」而不是数组恰好被读了两遍。
//
// 用法：
//   const transport = createFakeTransport({
//     follows: [
//       [{ frame: snapshot }, { frame: event }, { frame: { type: 'end' } }], // 第 1 次 openFollow
//       [{ wait: gate }, { frame: lateEvent }],                              // 第 2 次 openFollow
//     ],
//     pages: [{ records: [...], hasMore: false }],                           // 依次响应 page 调用
//   });
//
// 步骤语法（数组元素）：
//   { frame: <L3 帧> }   yield 一帧（也可直接写裸帧对象：{ type:'end' }）
//   { frames: [<帧>...] } 连续 yield 多帧（展开）
//   { throw: <Error> }   让当前流的 next() 抛错（模拟传输层中断）
//   { wait: <promise|毫秒> } 等待（用于和 stop() 交错）
//   { end: true }        正常结束当前流（transport 层 done，没有 L3 end 帧）
//   脚本耗尽等价于 { end: true }。
//
// transport 记录：
//   transport.followCalls  [{sessionId}]
//   transport.pageCalls    [{sessionId, throughSeq, beforeSeq, maxMessages}]
//   transport.followStreams 每次 openFollow 产出的迭代器（可看 returned 次数）

function normalizeSteps(input) {
  const steps = [];
  const pushFrame = (frame) => steps.push({ kind: 'frame', value: frame });
  for (const step of input) {
    if (step === null || typeof step !== 'object') {
      throw new TypeError('fake transport: 步骤必须是对象');
    }
    if (Object.prototype.hasOwnProperty.call(step, 'frames')) {
      if (!Array.isArray(step.frames)) throw new TypeError('fake transport: frames 必须是数组');
      for (const frame of step.frames) pushFrame(frame);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(step, 'frame')) {
      pushFrame(step.frame);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(step, 'throw')) {
      steps.push({ kind: 'throw', value: step.throw });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(step, 'wait')) {
      steps.push({ kind: 'wait', value: step.wait });
      continue;
    }
    if (step.end === true) {
      steps.push({ kind: 'end', value: undefined });
      continue;
    }
    if (typeof step.type === 'string') {
      // 裸帧（例如 { type:'end' }）
      pushFrame(step);
      continue;
    }
    throw new TypeError(`fake transport: 无法识别的步骤 ${JSON.stringify(step).slice(0, 120)}`);
  }
  return steps;
}

function makeIterator(steps) {
  let index = 0;
  let closed = false;
  let returned = 0;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    async next() {
      if (closed) return { done: true, value: undefined };
      while (index < steps.length) {
        if (closed) return { done: true, value: undefined };
        const step = steps[index];
        index += 1;
        if (step.kind === 'frame') return { done: false, value: step.value };
        if (step.kind === 'throw') throw step.value;
        if (step.kind === 'wait') {
          const wait = step.value;
          await (typeof wait === 'number' ? new Promise((resolve) => { setTimeout(resolve, wait); }) : wait);
          continue;
        }
        if (step.kind === 'end') return { done: true, value: undefined };
      }
      return { done: true, value: undefined };
    },
    async return(value) {
      closed = true;
      returned += 1;
      return { done: true, value };
    },
    async throw(error) {
      closed = true;
      throw error;
    },
    get returned() { return returned; },
  };
  return iterator;
}

/**
 * @param {{follows?: Array<Array<object>|{throwAtOpen:Error}>, pages?: Array<object|Error|Function>}} [scripts]
 */
export function createFakeTransport({ follows = [], pages = [] } = {}) {
  const followCalls = [];
  const pageCalls = [];
  const followStreams = [];
  let followIndex = 0;
  let pageIndex = 0;

  const transport = {
    followCalls,
    pageCalls,
    followStreams,

    openFollow({ sessionId } = {}) {
      followCalls.push({ sessionId });
      const entry = follows[followIndex];
      followIndex += 1;
      if (entry && !Array.isArray(entry) && entry.throwAtOpen) {
        throw entry.throwAtOpen;
      }
      const steps = normalizeSteps(Array.isArray(entry) ? entry : []);
      const iterator = makeIterator(steps);
      followStreams.push(iterator);
      return iterator;
    },

    async page(request) {
      pageCalls.push({ ...request });
      const handler = pages[pageIndex];
      pageIndex += 1;
      if (handler === undefined) {
        throw new Error(`fake transport: 第 ${pageIndex} 次 page 调用未被脚本化`);
      }
      if (handler instanceof Error) throw handler;
      if (typeof handler === 'function') return await handler(request, pageIndex - 1);
      return handler;
    },
  };

  return transport;
}
