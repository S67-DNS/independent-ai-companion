import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A17「无 fence 写入口关闭」的机器可验证版本。
//
// 光靠「我们约定都走 gate」不算边界：以后有人加一个模块直接写 session_event，
// 约定就破了。这里做一次源码静态扫描，把「允许写哪张表」变成可回归的断言。
//
// 允许清单刻意写死在本文件里：
//   * session_event  ← 只有 session-write-gate.mjs
//   * writer_claim   ← 只有 writer-fence.mjs
//   * 其余 delivery/memory/binding 表由各自的模块独占，见 ALLOWED 里的映射。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src', 'candidate');

const ALLOWED = Object.freeze({
  'session_event': ['session-write-gate.mjs'],
  'writer_claim': ['writer-fence.mjs'],
  'writer_audit': ['writer-fence.mjs'],
  'channel_binding': ['session-write-gate.mjs'],
  'binding_audit': ['session-write-gate.mjs'],
  'memory_registry': ['memory-provenance.mjs'],
  'memory_reservation': ['memory-provenance.mjs'],
  'memory_audit': ['memory-provenance.mjs'],
  'delivery': ['delivery-outbox.mjs'],
  'delivery_attempt': ['delivery-outbox.mjs'],
  'delivery_part_receipt': ['delivery-outbox.mjs'],
  'preset_registry': ['preset-registry.mjs'],
  'session_binding': ['preset-registry.mjs'],
});

function sourceFiles() {
  if (!fs.existsSync(SRC)) return [];
  return fs.readdirSync(SRC).filter((n) => n.endsWith('.mjs')).sort();
}

test('A17 静态扫描：写权按表独占，没有第二条无 fence 写入口', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 5, `候选模块数量异常：${files.join(',')}`);

  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    // 只看真正会改数据的语句；注释里提到表名不算违规。
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('--'))
      .join('\n');
    for (const [table, owners] of Object.entries(ALLOWED)) {
      const writeRe = new RegExp(`(INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b|UPDATE\\s+${table}\\b|DELETE\\s+FROM\\s+${table}\\b)`, 'i');
      if (writeRe.test(code) && !owners.includes(file)) {
        violations.push(`${file} 直接写了 ${table}（只允许 ${owners.join('/')}）`);
      }
    }
  }
  assert.deepEqual(violations, [], `发现越权写入：\n${violations.join('\n')}`);
});

test('A18 静态扫描：业务模块不得直接开裸事务（必须用 tx()）', () => {
  const files = sourceFiles().filter((f) => f !== 'db.mjs');
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    if (/db\.exec\(\s*['"`]\s*BEGIN/i.test(text)) violations.push(`${file} 使用了裸 BEGIN`);
    if (/db\.exec\(\s*['"`]\s*COMMIT/i.test(text)) violations.push(`${file} 使用了裸 COMMIT`);
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('A19 静态扫描：候选模块不得把真实凭据/路径写死', () => {
  const files = sourceFiles();
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    if (/\.credentials\.yaml/.test(text)) violations.push(`${file} 提到正式凭据文件`);
    if (/deadbeef/.test(text)) violations.push(`${file} 含哨兵 consoleToken 片段（占位）`);
    if (/\b2000000999\b/.test(text)) violations.push(`${file} 含哨兵 QQ 号（占位）`);
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
