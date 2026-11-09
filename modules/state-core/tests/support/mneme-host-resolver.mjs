// Node ESM 解析钩子（仅测试用）：把 DSH 运行时才有的宿主包映射到本地替身，
// 这样就能在 DSH 之外 import 打过补丁的 `lib/summarize.js` 并真实驱动它。
//
// 只拦截白名单里的宿主包，其余 specifier 一律交给默认解析器（绝不改变项目自身解析）。

const HOST_STUBS = new Map([
  ['@deepseek-ai/dsh-llm', new URL('./dsh-llm-stub.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const stub = HOST_STUBS.get(specifier);
  if (stub) return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
