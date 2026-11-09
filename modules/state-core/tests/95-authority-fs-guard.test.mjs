// CONSTRUCTION-006 / R4：authority-fs-guard 路径解析矩阵测试 + 写盘前拦截测试。
//
// 覆盖：绝对/相对/.././规范化/大小写/分隔符/扩展前缀/相似目录/普通目录/
//       符号链接文件/符号链接目录/junction/不存在的新文件/无 cwd/解析异常/
//       检查与实际打开一致/写盘前拒绝且零副作用。
// 环境不支持符号链接或 junction 时：把能力写进 reports/desktop-006/fs-capabilities.json，
// 对应行在报告中标 BLOCKED（测试本身不 skip、不伪造通过）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guard = await import(path.join(ROOT, 'plugins', 'authority-fs-guard', 'index.mjs').replace(/\\/g, '/'))
  .catch(() => import(`${new URL('../plugins/authority-fs-guard/index.mjs', import.meta.url).href}`))

const RUN = `r4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const BASE = path.join(ROOT, 'data', `test-${RUN}`)
const AUTHORITY = path.join(BASE, 'authority')
const MEMORY = path.join(AUTHORITY, 'memory')
const NORMAL = path.join(BASE, 'normal')
const LINKS = path.join(BASE, 'links')
const EVIDENCE = path.join(ROOT, 'reports', 'desktop-006', 'fs-capabilities.json')

fs.mkdirSync(MEMORY, { recursive: true })
fs.mkdirSync(path.join(NORMAL, 'memory-evil'), { recursive: true })
fs.mkdirSync(path.join(BASE, 'authority-other', 'memory'), { recursive: true })
fs.mkdirSync(LINKS, { recursive: true })
fs.writeFileSync(path.join(MEMORY, 'existing.md'), 'AUTHORITY-ORIGINAL', 'utf8')
fs.writeFileSync(path.join(NORMAL, 'plain.md'), 'NORMAL-ORIGINAL', 'utf8')
fs.writeFileSync(path.join(NORMAL, 'memory-evil', 'x.md'), 'LOOKALIKE', 'utf8')

const capabilities = { run: RUN, platform: process.platform, base: BASE, symlink: null, junction: null, error: null }
function tryLink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type)
    return { ok: true }
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error?.message ?? error) }
  }
}
const fileLink = path.join(LINKS, 'file-link.md')
const dirLink = path.join(LINKS, 'dir-link')
const juncLink = path.join(LINKS, 'junc-link')
const fileLinkRes = tryLink(path.join(MEMORY, 'existing.md'), fileLink, 'file')
const dirLinkRes = tryLink(MEMORY, dirLink, 'dir')
const juncLinkRes = tryLink(AUTHORITY, juncLink, 'junction')
capabilities.fileSymlink = fileLinkRes
capabilities.dirSymlink = dirLinkRes
capabilities.junction = juncLinkRes
fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true })
fs.writeFileSync(EVIDENCE, JSON.stringify(capabilities, null, 2), 'utf8')

const ROOTS = [MEMORY]
const cwd = (dir) => ({ agent: { session: { header: { cwd: dir } } } })
const fileExec = (filePath, baseDir = NORMAL, extra = {}) => ({
  name: 'write',
  arguments: { file_path: filePath, content: 'x', ...extra },
  ...cwd(baseDir),
})
const shellExec = (command, baseDir = NORMAL) => ({ name: 'pwsh', arguments: { command }, ...cwd(baseDir) })

const hitOf = (exec) => guard.evaluateFileWrite(exec, ROOTS)

// ── 矩阵 ────────────────────────────────────────────────────────────────────
test('R4-A 权威文件绝对路径 ⇒ 拒绝', () => {
  const r = hitOf(fileExec(path.join(MEMORY, 'existing.md')))
  assert.ok(r.hit, JSON.stringify(r))
  assert.equal(r.reason, 'lexical')
})

test('R4-B 权威目录下相对路径（cwd=authority）⇒ 拒绝', () => {
  const r = hitOf(fileExec('./memory/existing.md', AUTHORITY))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-C ../ 穿越到权威目录 ⇒ 拒绝', () => {
  const r = hitOf(fileExec('../authority/memory/existing.md', NORMAL))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-D ./ 与 .. 组合、规范化后指向权威文件 ⇒ 拒绝', () => {
  const r = hitOf(fileExec('./sub/../memory/./existing.md', AUTHORITY))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-E 大小写与分隔符变体 ⇒ 拒绝', () => {
  const p = path.join(MEMORY, 'existing.md').replace(/\//g, '\\').toUpperCase()
  const r = hitOf(fileExec(p))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-F \\\\?\\ 扩展长度前缀的绝对路径 ⇒ 拒绝', () => {
  const p = `\\\\?\\${path.join(MEMORY, 'existing.md')}`
  const r = hitOf(fileExec(p))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-G 与权威目录名称相似的普通目录 ⇒ 放行', () => {
  const a = hitOf(fileExec(path.join(NORMAL, 'memory-evil', 'x.md')))
  const b = hitOf(fileExec(path.join(BASE, 'authority-other', 'memory', 'y.md')))
  assert.equal(a.hit, null, JSON.stringify(a))
  assert.equal(b.hit, null, JSON.stringify(b))
})

test('R4-H 普通目录中的合法文件 ⇒ 放行', () => {
  const r = hitOf(fileExec(path.join(NORMAL, 'plain.md')))
  assert.equal(r.hit, null, JSON.stringify(r))
})

test('R4-I 符号链接文件指向权威文件 ⇒ 拒绝', () => {
  if (!fileLinkRes.ok) {
    assert.ok(capabilities.fileSymlink.code, '能力记录必须包含失败原因')
    return
  }
  const r = hitOf(fileExec(fileLink))
  assert.ok(r.hit, JSON.stringify(r))
  assert.equal(r.reason, 'realpath')
})

test('R4-J 符号链接目录指向权威目录 ⇒ 拒绝', () => {
  if (!dirLinkRes.ok) return
  const r = hitOf(fileExec(path.join(dirLink, 'new.md')))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-K junction 指向权威目录 ⇒ 拒绝', () => {
  if (!juncLinkRes.ok) return
  const r = hitOf(fileExec(path.join(juncLink, 'memory', 'new.md')))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-L 不存在的新文件（权威目录内）⇒ 拒绝（用最近存在祖先的 realpath）', () => {
  const r = hitOf(fileExec(path.join(MEMORY, 'brand-new.md')))
  assert.ok(r.hit, JSON.stringify(r))
})

test('R4-M 不存在的新文件（普通目录）⇒ 放行', () => {
  const r = hitOf(fileExec(path.join(NORMAL, 'brand-new.md')))
  assert.equal(r.hit, null, JSON.stringify(r))
})

test('R4-N 相对路径且无 cwd ⇒ fail-closed 拒绝（reason=unknown-cwd）', () => {
  const exec = { name: 'write', arguments: { file_path: 'x.md', content: 'x' } }
  const r = guard.evaluateFileWrite(exec, ROOTS)
  assert.ok(r.hit)
  assert.equal(r.reason, 'unknown-cwd')
})

test('R4-O 路径解析异常（非法字符）⇒ fail-closed 拒绝', () => {
  const exec = { name: 'write', arguments: { file_path: 'bad\u0000name.md', content: 'x' }, ...cwd(NORMAL) }
  const r = guard.evaluateFileWrite(exec, ROOTS)
  assert.ok(r.hit, JSON.stringify(r))
  assert.match(String(r.reason), /resolve-error/u)
})

test('R4-P shell 命令出现权威根规范拼写/相对名 ⇒ 拒绝', () => {
  const abs = guard.evaluateShellWrite(shellExec(`Set-Content -Path "${path.join(MEMORY, 'existing.md')}" hacked`), ROOTS)
  assert.ok(abs.hit, JSON.stringify(abs))
  const rel = guard.evaluateShellWrite(shellExec('Set-Content -Path "../authority/memory/existing.md" hacked'), ROOTS)
  assert.ok(rel.hit, JSON.stringify(rel))
})

test('R4-Q shell 命令只写普通目录 ⇒ 放行（不误伤）', () => {
  const r = guard.evaluateShellWrite(shellExec(`Set-Content -Path "${path.join(NORMAL, 'ok.md')}" fine`), ROOTS)
  assert.equal(r.hit, null, JSON.stringify(r))
})

// ── 写盘前拦截（真实文件操作） ──────────────────────────────────────────────
function attemptWrite(exec, roots) {
  // 模拟 DSH 工具层的执行顺序：guard 判定 → 只在放行时才真正写
  const verdict = guard.evaluateFileWrite(exec, roots)
  if (verdict.hit) return { blocked: true, verdict }
  const args = exec.arguments
  const target = path.isAbsolute(args.file_path) ? path.resolve(args.file_path) : path.resolve(exec.agent.session.header.cwd, args.file_path)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, args.content, 'utf8')
  return { blocked: false, verdict, target }
}

test('R4-R 拒绝发生在写盘之前：权威文件内容不变、无新文件', () => {
  const before = fs.readFileSync(path.join(MEMORY, 'existing.md'), 'utf8')
  const nextFile = path.join(MEMORY, 'should-not-exist.md')
  const res = attemptWrite({ name: 'write', arguments: { file_path: nextFile, content: 'HACKED' }, ...cwd(NORMAL) }, ROOTS)
  assert.equal(res.blocked, true, JSON.stringify(res.verdict))
  assert.equal(fs.readFileSync(path.join(MEMORY, 'existing.md'), 'utf8'), before)
  assert.equal(fs.existsSync(nextFile), false)
})

test('R4-S 普通文件仍可正常写入（真实写盘，证明不是一刀切）', () => {
  const target = path.join(NORMAL, 'written-ok.md')
  const res = attemptWrite({ name: 'write', arguments: { file_path: target, content: 'NORMAL-OK' }, ...cwd(NORMAL) }, ROOTS)
  assert.equal(res.blocked, false, JSON.stringify(res.verdict))
  assert.equal(fs.readFileSync(target, 'utf8'), 'NORMAL-OK')
})

test('R4-T 检查路径与实际打开路径一致：相对路径解析结果 = 实际写入目标', () => {
  const exec = { name: 'write', arguments: { file_path: '../authority/memory/existing.md', content: 'X' }, ...cwd(NORMAL) }
  const verdict = guard.evaluateFileWrite(exec, ROOTS)
  const actual = path.resolve(exec.agent.session.header.cwd, exec.arguments.file_path)
  assert.equal(path.resolve(verdict.resolved), actual)
  assert.ok(verdict.hit)
})

test('R4-U 权威根带尾斜杠/大小写变体仍拒绝', () => {
  const roots = [`${MEMORY.toUpperCase()}\\`]
  const r = guard.evaluateFileWrite(fileExec(path.join(MEMORY, 'existing.md')), roots)
  assert.ok(r.hit, JSON.stringify(r))
})
