// 注入装配：只收 authority/trusted、拒绝 untrusted/drift、稳定排序、超限截断有标记。
// 纯离线单测 + 与 store.listForInjection 的 fresh read 集成。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { openDb } from '../src/candidate/db.mjs';
import { CandidateError, ERR } from '../src/candidate/errors.mjs';
import { createMemoryStore, TRUST } from '../src/candidate/memory-provenance.mjs';
import { buildInjection, TRUNCATION_MARKER } from '../src/candidate/memory-inject.mjs';
import { sha256Hex } from '../src/candidate/util.mjs';
import { createSandbox, seedMemory } from './support/memory-fixture.mjs';

const sandboxes = [];
function sandbox(label) {
  const created = createSandbox(label);
  sandboxes.push(created);
  return created;
}
after(() => {
  for (const created of sandboxes) created.dispose();
});

function makeEntry(relPath, { trust = TRUST.AUTHORITY, generation = 1, content, hash } = {}) {
  const body = content === undefined ? `# ${relPath}\n正文\n` : content;
  return {
    relPath,
    trust,
    generation,
    content: body,
    hash: hash ?? sha256Hex(`${relPath}:${generation}:${body}`),
    registered: true,
    externalChange: false,
  };
}

test('正常注入：只收 authority/trusted，按 generation 稳定排序', () => {
  const entries = [
    makeEntry('b/trusted.md', { trust: TRUST.TRUSTED, generation: 2, content: 'B 记忆正文' }),
    makeEntry('a/authority.md', { trust: TRUST.AUTHORITY, generation: 1, content: 'A 记忆正文' }),
    makeEntry('c/later.md', { trust: TRUST.AUTHORITY, generation: 3, content: 'C 记忆正文' }),
  ];
  const injection = buildInjection({ entries, maxChars: 6000, now: () => 1234 });
  assert.deepEqual(injection.included.map((item) => item.relPath), ['a/authority.md', 'b/trusted.md', 'c/later.md']);
  assert.equal(injection.rejected.length, 0);
  assert.equal(injection.truncated, false);
  assert.equal(injection.builtAtMs, 1234);
  const posA = injection.text.indexOf('A 记忆正文');
  const posB = injection.text.indexOf('B 记忆正文');
  const posC = injection.text.indexOf('C 记忆正文');
  assert.ok(posA >= 0 && posA < posB && posB < posC, '注入文本必须与 included 顺序一致');
  assert.ok(injection.text.includes('generation 1'));
  assert.ok(injection.text.includes(injection.included[0].hash.slice(0, 12)), '带 hash 前缀便于追溯');
  assert.ok(injection.usedChars <= 6000);
});

test('排除 untrusted / drift / 外部改动 / 无正文 / 重复路径', () => {
  const entries = [
    makeEntry('ok/authority.md', { generation: 1 }),
    makeEntry('ok/trusted.md', { trust: TRUST.TRUSTED, generation: 2 }),
    makeEntry('bad/untrusted.md', { trust: TRUST.UNTRUSTED }),
    makeEntry('bad/drift.md', { trust: TRUST.DRIFT }),
    { ...makeEntry('bad/external.md'), externalChange: true },
    { relPath: 'bad/nocontent.md', trust: TRUST.TRUSTED, generation: 3, hash: 'deadbeef' },
    { relPath: '', trust: TRUST.AUTHORITY, generation: 4, content: 'x' },
    makeEntry('ok/dup.md', { generation: 5 }),
    makeEntry('ok/dup.md', { generation: 6 }),
  ];
  const injection = buildInjection({ entries });
  assert.deepEqual(
    injection.included.map((item) => item.relPath),
    ['ok/authority.md', 'ok/trusted.md', 'ok/dup.md'],
  );
  const reasonFor = (relPath) => injection.rejected
    .filter((item) => item.relPath === relPath)
    .map((item) => item.reason);
  assert.deepEqual(reasonFor('bad/untrusted.md'), ['untrusted']);
  assert.deepEqual(reasonFor('bad/drift.md'), ['drift']);
  assert.deepEqual(reasonFor('bad/external.md'), ['external-change']);
  assert.deepEqual(reasonFor('bad/nocontent.md'), ['missing-content']);
  assert.deepEqual(reasonFor(''), ['invalid-entry']);
  assert.deepEqual(reasonFor('ok/dup.md'), ['duplicate-path']);
  assert.ok(!injection.text.includes('bad/untrusted.md'));
  assert.ok(!injection.text.includes('bad/drift.md'));
});

test('超限截断：必须带 […截断…] 标记，没装下的条目记为 over-budget', () => {
  const longBody = 'X'.repeat(400);
  const entries = [
    makeEntry('a.md', { generation: 1, content: longBody }),
    makeEntry('b.md', { generation: 2, content: longBody }),
    makeEntry('c.md', { generation: 3, content: longBody }),
  ];
  const maxChars = 220;
  const injection = buildInjection({ entries, maxChars });

  assert.ok(injection.text.length <= maxChars, `text 长度 ${injection.text.length} 必须 <= ${maxChars}`);
  assert.equal(injection.usedChars, injection.text.length);
  assert.ok(injection.text.includes(TRUNCATION_MARKER), '超限截断必须有明确标记');
  assert.equal(injection.truncated, true);
  assert.equal(injection.included.length, 1);
  assert.equal(injection.included[0].relPath, 'a.md');
  assert.equal(injection.included[0].truncated, true);
  assert.deepEqual(injection.rejected.map((item) => [item.relPath, item.reason]), [
    ['b.md', 'over-budget'],
    ['c.md', 'over-budget'],
  ]);
  assert.equal(injection.text.slice(-TRUNCATION_MARKER.length), TRUNCATION_MARKER, '标记在文本末尾');

  // 预算连标记都放不下：宁可一条都不加，也不写没有标记的残缺内容。
  const tiny = buildInjection({ entries, maxChars: 5 });
  assert.equal(tiny.included.length, 0);
  assert.equal(tiny.text, '');
  assert.ok(tiny.rejected.every((item) => item.reason === 'over-budget'));
});

test('排序稳定：输入顺序打乱不影响输出', () => {
  const entries = [
    makeEntry('z.md', { generation: 2, content: 'Z' }),
    makeEntry('a.md', { generation: 2, content: 'A' }),
    makeEntry('m.md', { generation: 1, content: 'M' }),
    makeEntry('b.md', { generation: 3, content: 'B' }),
  ];
  const forward = buildInjection({ entries });
  const backward = buildInjection({ entries: [...entries].reverse() });
  const interleaved = buildInjection({ entries: [entries[2], entries[0], entries[3], entries[1]] });

  assert.deepEqual(forward.included.map((item) => item.relPath), ['m.md', 'a.md', 'z.md', 'b.md']);
  assert.equal(forward.text, backward.text);
  assert.equal(forward.text, interleaved.text);
  assert.deepEqual(forward.included, backward.included);
  assert.deepEqual(forward.included, interleaved.included);
});

test('非法参数：entries 非数组 / maxChars 非正数 ⇒ INVALID_ARGUMENT', () => {
  const isInvalid = (action, label) => {
    let caught;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CandidateError, `${label}：期望 CandidateError`);
    assert.equal(caught.code, ERR.INVALID_ARGUMENT, label);
  };
  isInvalid(() => buildInjection({ entries: 'nope' }), 'entries 非数组');
  isInvalid(() => buildInjection({ entries: [], maxChars: 0 }), 'maxChars=0');
  isInvalid(() => buildInjection({ entries: [], maxChars: Number.NaN }), 'maxChars=NaN');
});

test('集成：listForInjection 走 fresh read，外部改动后该条自动从注入中消失', () => {
  const created = sandbox('inject-integration');
  const db = openDb(created.dbPath);
  try {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 长期记忆\n喜欢安静\n');
    seedMemory(created.memoryDir, 'notes/trusted.md', '# 备注\n周末写代码\n');
    seedMemory(created.memoryDir, 'notes/unknown.md', '# 未登记\n');
    const store = createMemoryStore({ root: created.memoryDir, db });
    store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    store.adopt({ relPath: 'notes/trusted.md', writerIdentity: 'authority', trust: TRUST.TRUSTED });

    const first = buildInjection({ entries: store.listForInjection(), maxChars: 4000 });
    assert.deepEqual(first.included.map((item) => item.relPath), ['MEMORY.md', 'notes/trusted.md']);
    assert.ok(first.text.includes('喜欢安静'));
    assert.ok(first.text.includes('周末写代码'));
    assert.ok(!first.text.includes('未登记'), '未登记文件绝不进入注入');

    // 外部（不经过 store）改掉一个已登记文件：注入时必须当场发现并排除。
    fs.writeFileSync(created.abs('notes/trusted.md'), '# 被外部改掉\n', 'utf8');
    const second = buildInjection({ entries: store.listForInjection(), maxChars: 4000 });
    assert.deepEqual(second.included.map((item) => item.relPath), ['MEMORY.md']);
    assert.ok(!second.text.includes('周末写代码'));

    const verify = store.verify('notes/trusted.md');
    assert.equal(verify.trust, TRUST.DRIFT);
    assert.equal(verify.externalChange, true);
    assert.equal(verify.ok, false);
  } finally {
    db.close();
  }
});
