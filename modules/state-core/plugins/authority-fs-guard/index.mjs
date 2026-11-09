// 权威记忆路径的「事前写入」守卫（CONSTRUCTION-005 引入；CONSTRUCTION-006 / R4 修复路径绕过）。
//
// 背景：DSH 没有写入者 lease，Desktop UI / qq-admin 的 file/shell 工具可以**先写盘**，
// 桥接发现时已经晚了（provenance 只能防止桥接随后静默覆盖，不能撤销破坏）。
//
// 旧实现（005）用**子串匹配**：`haystack.includes(root)`。GLM-READONLY-AUDIT-005 的 R4 指出：
// 相对路径（`../memory/x`、`./x`）不会包含权威根的绝对拼写，因此直接绕过；相似目录
// （`memory-evil`）也会被误杀。**字符串匹配不是路径语义**。
//
// 本版（006）按 DSH 真实文件操作语义做**解析后比较**：
//   1. 取 DSH 实际使用的路径参数（`exec.arguments.file_path` 等）与基准目录
//      （`exec.agent.session.header.cwd`，即 dsh-tool-fs 的 session cwd 语义）；
//   2. 用与 `dsh-fs-local.localDisplayPath()` 相同的规则解析：`path.resolve(cwd, requested)`
//      （Windows；含盘符、大小写、`/` 与 `\`、`.`/`..` 规范化）；
//   3. 对解析结果做**realpath 身份解析**（存在则 realpath；不存在则对最近存在的祖先
//      realpath 再拼缺失后缀 —— 与 `dsh-fs-local.resolveLocalTarget()` 的 targetKey 语义一致），
//      从而覆盖符号链接 / junction；
//   4. 用**路径段前缀**比较（`target === root || target.startsWith(root + '/')`），
//      不是子串比较，杜绝 `memory-evil` 误杀；
//   5. 无法解析（无 cwd 的相对路径、EACCES/ELOOP/异常）⇒ **fail-closed 拒绝**。
//
// 明确边界（不声称已解决）：
//   - **TOCTOU**：guard 检查与 DSH 真正 open 之间存在竞态；本实现只把窗口缩小到与
//     `dsh-fs-local` 自身 resolve 同级的程度，无法消除。真正的消除需要 OS/ACL 或
//     在 provider 内做写入授权（不在候选范围）。
//   - **shell 工具**（pwsh/bash 等）无法静态解析任意命令；只做"命令文本中出现权威根
//     规范拼写/realpath 拼写"的保守检测，动态计算路径（变量、管道、编码）仍可能绕过。
//     这是已声明的 R4 残余，权威目录仍必须靠 OS/ACL/运行纪律保护。
//   - 只约束「经 DSH 工具」的写入；外部进程直接改文件不在覆盖内。
//   - read 不拦（只读展示允许）。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'authority-fs-guard'

export const inject = ['tools']

// 文件写入类工具：参数里是路径。
const FILE_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',
  'fs_write',
])

// 命令执行类工具：参数里是命令文本（无法可靠解析，做保守文本检测）。
const SHELL_TOOLS = new Set([
  'pwsh',
  'bash',
  'shell',
  'terminal',
  'job_start',
])

const WRITE_TOOLS = new Set([...FILE_WRITE_TOOLS, ...SHELL_TOOLS])

// DSH write/edit 的路径键（file_path 优先；不同工具/版本可能用 path）
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'targetPath']
const SHELL_TEXT_KEYS = ['command', 'cmd', 'script']

export function rootsFromEnv() {
  const raw = String(process.env.OPENCORE_AUTHORITY_ROOTS ?? '')
  return raw
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/** 支持 profile patch 的 config.roots（字符串或数组）以及环境变量两种来源。 */
export function rootsFromConfig(config) {
  const raw = config?.roots
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[;\n]/).map((x) => x.trim()).filter(Boolean)
  }
  return rootsFromEnv()
}

// ── 路径规范化与比较 ────────────────────────────────────────────────────────

/**
 * 统一成可比较的规范形式：
 * - 反斜杠 → 正斜杠；去掉 `\\?\` 扩展前缀；折叠重复分隔符；去掉尾部分隔符；
 * - Windows 大小写不敏感 → 全部小写。
 * 注意：这不是用于打开文件的路径，只用于**比较**；实际判定前还会做 realpath。
 */
export function normalizeForCompare(value) {
  let s = String(value ?? '')
  if (!s) return ''
  s = s.replace(/\\/g, '/')
  s = s.replace(/^\/\/\?\/+/, '')
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 路径段级包含：candidate 等于 root 或位于 root 之下（不是子串）。 */
export function isWithin(candidate, root) {
  const c = normalizeForCompare(candidate)
  const r = normalizeForCompare(root)
  if (!c || !r) return false
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * 求"真实身份路径"：存在则 realpath；不存在则对最近存在的祖先 realpath 再拼缺失后缀。
 * 与 dsh-fs-local.resolveLocalTarget() 的 targetKey 语义一致（符号链接/junction 会被解析）。
 * 遇到 ENOENT 继续向上；其它错误（EACCES/ELOOP/……）返回 error ⇒ 调用方 fail-closed。
 */
export function realpathNearest(input) {
  let current = path.resolve(String(input))
  const missing = []
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      const real = fs.realpathSync.native(current)
      return { path: missing.length > 0 ? path.join(real, ...missing.slice().reverse()) : real }
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        const parent = path.dirname(current)
        if (parent === current) return { error }
        missing.push(path.basename(current))
        current = parent
        continue
      }
      return { error }
    }
  }
  return { error: new Error('too many missing path segments') }
}

/** 从 exec 取基准目录：与 dsh-tool-fs 的 session cwd 同源（agent session header.cwd）。 */
export function baseDirFrom(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim()) return cwd
  return undefined
}

/** 取第一次出现的非空字符串参数。 */
function firstString(args, keys) {
  for (const key of keys) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/**
 * 解析一次文件工具调用的**实际目标路径**，并判断是否落在任一权威根内。
 * 返回 { hit, resolved, realResolved, reason }：
 *   - hit: 命中的权威根（字符串）或 null；
 *   - reason: 命中原因（lexical / realpath / resolve-error / unknown-cwd）；
 *   - resolved / realResolved: 便于测试和审计。
 */
export function evaluateFileWrite(exec, roots = rootsFromEnv(), options = {}) {
  const args = exec?.arguments ?? exec?.args ?? exec?.input ?? {}
  const requested = firstString(args, FILE_PATH_KEYS)
  if (requested === undefined) return { hit: null, resolved: null, realResolved: null, reason: 'no-path-argument' }
  if (roots.length === 0) return { hit: null, resolved: null, realResolved: null, reason: 'no-roots' }

  const base = options.baseDir ?? baseDirFrom(exec)
  const isAbs = path.isAbsolute(requested)
  if (!isAbs && !base) {
    // 相对路径 + 无法确定基准目录 ⇒ 不能解析 ⇒ fail-closed（需求：不确定就拒绝权威写入）
    return { hit: roots[0], resolved: null, realResolved: null, reason: 'unknown-cwd' }
  }
  let resolved
  try {
    resolved = isAbs ? path.resolve(requested) : path.resolve(base, requested)
  } catch (error) {
    // 路径本身非法（NUL 字节等）⇒ 无法解析 ⇒ fail-closed
    return { hit: roots[0], resolved: null, realResolved: null, reason: `resolve-error:${error?.code ?? error?.message ?? 'invalid-path'}` }
  }

  // 1) 词法比较（快速路径）
  for (const root of roots) {
    if (isWithin(resolved, root)) return { hit: root, resolved, realResolved: null, reason: 'lexical' }
  }

  // 2) realpath 身份比较（覆盖符号链接 / junction；不存在的目标用最近祖先）
  const real = realpathNearest(resolved)
  if (real.error) {
    return { hit: roots[0], resolved, realResolved: null, reason: `resolve-error:${real.error?.code ?? real.error?.message ?? 'unknown'}` }
  }
  for (const root of roots) {
    const realRoot = realpathNearest(root)
    const rootPath = realRoot.error ? root : realRoot.path
    if (isWithin(real.path, rootPath)) {
      return { hit: root, resolved, realResolved: real.path, reason: 'realpath' }
    }
  }
  return { hit: null, resolved, realResolved: real.path, reason: 'outside' }
}

/** shell 工具：命令文本中的权威根规范拼写保守检测（无法可靠解析命令，见文件头边界）。 */
export function evaluateShellWrite(exec, roots = rootsFromEnv()) {
  const args = exec?.arguments ?? exec?.args ?? exec?.input ?? {}
  const text = firstString(args, SHELL_TEXT_KEYS)
  if (text === undefined) return { hit: null, reason: 'no-command-argument' }
  if (roots.length === 0) return { hit: null, reason: 'no-roots' }
  const hay = normalizeForCompare(text)
  for (const root of roots) {
    const candidates = []
    candidates.push(normalizeForCompare(root))
    const realRoot = realpathNearest(root)
    if (!realRoot.error) candidates.push(normalizeForCompare(realRoot.path))
    for (const candidate of candidates) {
      if (!candidate) continue
      // 段边界：避免 "memory2" 之类误杀；同时接受引号包裹形式
      if (hay.includes(candidate)) return { hit: root, reason: 'shell-text' }
      // 相对路径形式（cd 到父目录后 memory/x）：用根的最后一段做保守匹配
      const tail = candidate.split('/').filter(Boolean).pop()
      if (tail && tail.length >= 4) {
        const re = new RegExp(`(^|[\\s'"/\\\\])${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/\\\\]|$)`, 'u')
        if (re.test(hay)) return { hit: root, reason: 'shell-relative-name' }
      }
    }
  }
  return { hit: null, reason: 'outside' }
}

/**
 * 兼容 005 的导出：返回命中的根或 null（内部走新的解析逻辑）。
 * 保留该函数便于旧调用方/测试过渡；新代码请用 evaluateFileWrite / evaluateShellWrite。
 */
export function protectedPathHit(exec, roots = rootsFromEnv()) {
  if (!exec || typeof exec.name !== 'string') return null
  if (!WRITE_TOOLS.has(exec.name)) return null
  if (roots.length === 0) return null
  const result = SHELL_TOOLS.has(exec.name) ? evaluateShellWrite(exec, roots) : evaluateFileWrite(exec, roots)
  return result.hit ? result.hit : null
}

export function apply(ctx, config) {
  const roots = rootsFromConfig(config)
  if (typeof console?.info === 'function') {
    console.info(`[authority-fs-guard] ${roots.length > 0 ? `保护 ${roots.length} 个权威根（解析式判定 / realpath / fail-closed）` : '未配置 OPENCORE_AUTHORITY_ROOTS（本次不拦截）'}`)
  }
  ctx.tools.guard((exec) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !WRITE_TOOLS.has(toolName)) return undefined
    const result = SHELL_TOOLS.has(toolName)
      ? evaluateShellWrite(exec, roots)
      : evaluateFileWrite(exec, roots)
    if (!result.hit) return undefined
    const detail = result.resolved
      ? `resolved=${result.resolved}${result.realResolved ? ` real=${result.realResolved}` : ''}`
      : `target=${String(firstString(exec?.arguments ?? exec?.args ?? exec?.input ?? {}, SHELL_TEXT_KEYS) ?? '(unknown)').slice(0, 200)}`
    return `工具 "${toolName}" 的目标位于权威记忆路径（${result.hit}，reason=${result.reason}，${detail}）：权威写入只能由PROJECT_NAME桥接经 Writer Fence + Provenance/CAS 完成；桌面 UI / 工具直改一律拒绝。`
  })
}
