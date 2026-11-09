// `@deepseek-ai/dsh-llm` 的最小替身（仅测试用）。
//
// 为什么需要它：`lib/summarize.js` 顶部 `import { BlockAssembler, createUserMessage } from
// "@deepseek-ai/dsh-llm"`。这个包由 DSH 运行时（app.asar）提供，仓库/profile 的
// node_modules 里没有；所以在 DSH 进程之外 import 该文件必然 ERR_MODULE_NOT_FOUND。
// 蒸馏守卫的判定发生在**调用 LLM 之前**（只在 turn/end 入口做身份判定），所以这两个
// 符号在守卫测试里一次都不会被调用——用替身把模块加载顶起来即可。
//
// 任何替身被真正调到 = 测试走到了不该走的 LLM 路径，直接抛错而不是静默通过。

export class BlockAssembler {
  constructor() {
    throw new Error('BlockAssembler stub: 守卫测试不应该走到 LLM 组装路径');
  }
}

export function createUserMessage() {
  throw new Error('createUserMessage stub: 守卫测试不应该走到 LLM 组装路径');
}

export default { BlockAssembler, createUserMessage };
