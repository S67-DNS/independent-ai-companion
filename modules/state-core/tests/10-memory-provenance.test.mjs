// Memory provenance / CAS 的行为证据（离线、隔离）。
//
// 每个 test 用独立临时目录 data/test-memory-*，绝不读写真实 ~/.dsh/memory。
// 覆盖：越权写入、Shell 外部修改、同路径替换、同字节重建、旧 reservation 回滚新写入、
//       并发 CAS（真实子进程）、文件与 DB 不一致的 reconcile、未登记记忆拒绝注入。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { openDb } from '../src/candidate/db.mjs';
import { CandidateError, ERR } from '../src/candidate/errors.mjs';
import { createMemoryStore, TRUST } from '../src/candidate/memory-provenance.mjs';
import { buildInjection } from '../src/candidate/memory-inject.mjs';
import { sha256Hex } from '../src/candidate/util.mjs';
import {
  SUPPORT_DIR,
  auditRows,
  countRows,
  createSandbox,
  seedMemory,
  spawnChild,
  waitForFile,
} from './support/memory-fixture.mjs';

const sandboxes = [];
function sandbox(label) {
  const created = createSandbox(label);
  sandboxes.push(created);
  return created;
}
after(() => {
  for (const created of sandboxes) created.dispose();
});

// 让 NTFS 的 birthtimeNs 拉开差距；用同步等待避免把测试写成 async。
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function expectCode(action, code, label = '') {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `${label}：期望抛出 ${code}，但没有抛错`);
  assert.ok(caught instanceof CandidateError, `${label}：期望 CandidateError，实际是 ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, code, `${label}：期望 ${code}，实际 ${caught.code}（${caught.message}）`);
  return caught;
}

function withStore(label, fn) {
  const created = sandbox(label);
  const db = openDb(created.dbPath);
  const store = createMemoryStore({ root: created.memoryDir, db });
  try {
    return fn({ sandbox: created, db, store });
  } finally {
    db.close();
  }
}

function parseAuditDetail(row) {
  return row?.detail ? JSON.parse(row.detail) : null;
}

test('越权写入：非 authority 且无 reservation 被拒绝，文件与 generation 不变', () => {
  withStore('authz', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 权威记忆\n第一版\n');
    const absPath = created.abs('MEMORY.md');
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    assert.equal(adopted.generation, 1);
    assert.equal(adopted.trust, TRUST.AUTHORITY);
    const before = fs.readFileSync(absPath, 'utf8');

    const privilege = expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# 越权改写\n',
      writerIdentity: 'agent:intruder',
      expectedHash: adopted.hash,
    }), ERR.UNTRUSTED_MEMORY, 'agent 无 reservation 写入');
    assert.equal(privilege.detail.writerIdentity, 'agent:intruder');
    assert.equal(parseAuditDetail(auditRows(db, { path: 'MEMORY.md', kind: 'cas-reject' }).at(-1)).problem,
      'no-reservation-for-non-authority');

    expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# 无凭证的权威覆盖\n',
      writerIdentity: 'authority',
      expectedHash: adopted.hash,
    }), ERR.CAS_MISMATCH, 'authority 缺 reservation');

    assert.equal(fs.readFileSync(absPath, 'utf8'), before, '被拒绝的写入绝不能落盘');
    const current = store.read('MEMORY.md');
    assert.equal(current.generation, 1);
    assert.equal(current.trust, TRUST.AUTHORITY);
    assert.equal(current.externalChange, false);
    assert.ok(auditRows(db, { path: 'MEMORY.md', kind: 'cas-reject' }).length >= 2, '拒绝必须留下审计');
    assert.equal(countRows(db, 'memory_registry'), 1);
  });
});

test('Shell 外部修改：read 检测 externalChange 并判 drift，write 抛 MEMORY_DRIFT 且不落盘', () => {
  withStore('shell', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 权威记忆\n第一版\n');
    const absPath = created.abs('MEMORY.md');
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    const reservation = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority', ttlMs: 60000 });
    assert.equal(reservation.expectedHash, adopted.hash);
    assert.equal(reservation.expectedGeneration, 1);

    const shellContent = '# 被 shell 直接改掉\n';
    fs.writeFileSync(absPath, shellContent, 'utf8'); // 绕过 store 的 shell/exec 修改

    const readResult = store.read('MEMORY.md');
    assert.equal(readResult.externalChange, true);
    assert.equal(readResult.trust, TRUST.DRIFT);
    assert.equal(readResult.generation, 1);
    assert.equal(readResult.content, shellContent);

    const registry = db.prepare('SELECT * FROM memory_registry WHERE path = ?').get('MEMORY.md');
    assert.equal(registry.trust, TRUST.DRIFT, 'drift 必须落到 registry，而不是只在返回值里');
    assert.equal(registry.content_hash, adopted.hash, '登记事实不得被外部内容覆盖');

    const audit = auditRows(db, { path: 'MEMORY.md', kind: 'external-change' });
    assert.equal(audit.length, 1);
    const detail = parseAuditDetail(audit[0]);
    assert.equal(detail.hashSame, false);
    assert.equal(detail.contentChanged, true);
    assert.equal(detail.changeKind, 'content-change');
    assert.equal(detail.expectedHash, adopted.hash);
    assert.equal(detail.actualHash, sha256Hex(Buffer.from(shellContent, 'utf8')));

    expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# 想覆盖\n',
      writerIdentity: 'authority',
      reservationId: reservation.reservationId,
      expectedHash: reservation.expectedHash,
    }), ERR.MEMORY_DRIFT, 'drift 后写入');
    assert.equal(fs.readFileSync(absPath, 'utf8'), shellContent, 'drift 后 write 不得落盘');

    assert.deepEqual(store.listForInjection(), [], 'drift 记忆不得进入注入列表');
    assert.equal(buildInjection({ entries: store.listForInjection() }).text, '');
    // drift 之后也不能再签发新的 reservation（否则等于给不可信内容重新开写入口）。
    expectCode(() => store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' }), ERR.MEMORY_DRIFT, 'drift 后申请 reservation');
  });
});

test('同路径替换：内容 hash 相同但文件身份变化 ⇒ 判外部修改（audit hashSame:true）', () => {
  withStore('replace', ({ sandbox: created, db, store }) => {
    const content = '# 权威记忆\n第一版\n';
    // 覆盖用的临时文件先创建（登记之前），这样 rename 之后 birthtimeNs 会早于登记时间；
    // 与「删除后重建」（birthtimeNs 必然晚于登记）在审计证据上可区分。
    const replacement = created.abs('.MEMORY.md.replacement');
    fs.writeFileSync(replacement, content, 'utf8');
    sleepSync(10);
    seedMemory(created.memoryDir, 'MEMORY.md', content);
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });

    fs.renameSync(replacement, created.abs('MEMORY.md')); // 同路径替换：inode/birthtime 变

    const readResult = store.read('MEMORY.md');
    assert.equal(readResult.hash, adopted.hash, '内容字节应当完全相同');
    assert.equal(readResult.externalChange, true);
    assert.equal(readResult.trust, TRUST.DRIFT);
    assert.notEqual(readResult.identity, adopted.identity, '文件身份必须变化');

    const detail = parseAuditDetail(auditRows(db, { path: 'MEMORY.md', kind: 'external-change' }).at(-1));
    assert.equal(detail.hashSame, true);
    assert.equal(detail.contentChanged, false);
    assert.equal(detail.identityChanged, true);
    assert.equal(detail.changeKind, 'same-bytes-file-identity-change');
    assert.notEqual(detail.expectedIdentity, detail.actualIdentity);
    assert.ok(
      BigInt(detail.actualBirthtimeNs) < BigInt(detail.expectedBirthtimeNs),
      'rename 覆盖沿用被移动文件的创建时间（早于登记）',
    );
  });
});

test('同字节重建：删除后重建同样内容 ⇒ 身份变化，仍判外部修改', () => {
  withStore('rebuild', ({ sandbox: created, db, store }) => {
    const content = '# 权威记忆\n第一版\n';
    seedMemory(created.memoryDir, 'MEMORY.md', content);
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    const absPath = created.abs('MEMORY.md');

    fs.unlinkSync(absPath);
    sleepSync(10);
    fs.writeFileSync(absPath, content, 'utf8'); // 同字节重建

    const readResult = store.read('MEMORY.md');
    assert.equal(readResult.hash, adopted.hash, '字节仍相同');
    assert.equal(readResult.externalChange, true);
    assert.equal(readResult.trust, TRUST.DRIFT);
    assert.notEqual(readResult.identity, adopted.identity);

    const detail = parseAuditDetail(auditRows(db, { path: 'MEMORY.md', kind: 'external-change' }).at(-1));
    assert.equal(detail.hashSame, true);
    assert.equal(detail.changeKind, 'same-bytes-file-identity-change');
    // Windows 上 NTFS 文件隧道可能把同名新文件的创建时间还原成旧值，所以这里只断言
    // 「文件身份确实变了」，并用 ino/birthtime 两个分量留下可核对证据。
    assert.notEqual(detail.expectedIdentity, detail.actualIdentity);
    assert.ok(detail.inoChanged || detail.birthtimeChanged, '文件对象必须发生变化（ino 或 birthtime）');
    assert.equal(store.listForInjection().length, 0);
  });
});

test('CAS：过期 reservation / 旧 expectedHash 一律 CAS_MISMATCH，且一个字节都不写盘', () => {
  const created = sandbox('cas-stale');
  const db = openDb(created.dbPath);
  let clock = 1_800_000_000_000;
  const store = createMemoryStore({
    root: created.memoryDir,
    db,
    now: () => clock,
    reservationTtlMs: 1000,
  });
  try {
    seedMemory(created.memoryDir, 'MEMORY.md', '# v1\n');
    const absPath = created.abs('MEMORY.md');
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    const first = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' });
    assert.equal(first.expiresAtMs, clock + 1000);

    clock += 5000; // 越过 TTL
    expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# v2\n',
      writerIdentity: 'authority',
      reservationId: first.reservationId,
      expectedHash: first.expectedHash,
    }), ERR.CAS_MISMATCH, '过期 reservation');
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# v1\n');
    assert.equal(store.read('MEMORY.md').generation, 1);
    assert.equal(
      db.prepare('SELECT state FROM memory_reservation WHERE reservation_id = ?').get(first.reservationId).state,
      'expired',
      '过期 reservation 必须被收口，不能继续可用',
    );

    const second = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' });
    assert.equal(second.expectedGeneration, 1);
    const wrongHash = adopted.hash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# v3\n',
      writerIdentity: 'authority',
      reservationId: second.reservationId,
      expectedHash: wrongHash,
    }), ERR.CAS_MISMATCH, 'expectedHash 不符');
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# v1\n');

    const problems = parseAuditDetail(auditRows(db, { path: 'MEMORY.md', kind: 'cas-reject' }).at(-1)).problems;
    assert.deepEqual(problems, ['expected-hash-mismatch']);
  } finally {
    db.close();
  }
});

test('旧 reservation 回滚新写入：拒绝 RESERVATION_INVALID，新内容完好', () => {
  withStore('rollback', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# v1\n');
    const absPath = created.abs('MEMORY.md');
    store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });

    const first = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' });
    const firstWrite = store.write({
      relPath: 'MEMORY.md',
      content: '# v2\n',
      writerIdentity: 'authority',
      reservationId: first.reservationId,
      expectedHash: first.expectedHash,
    });
    assert.equal(firstWrite.generation, 2);

    const second = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' });
    const secondWrite = store.write({
      relPath: 'MEMORY.md',
      content: '# v3\n',
      writerIdentity: 'authority',
      reservationId: second.reservationId,
      expectedHash: second.expectedHash,
    });
    assert.equal(secondWrite.generation, 3);
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# v3\n');

    // 旧 reservation 再拿来写（generation 已前移、状态已 committed）⇒ CAS 拒绝。
    const staleWrite = expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# 用旧凭证覆盖\n',
      writerIdentity: 'authority',
      reservationId: first.reservationId,
      expectedHash: first.expectedHash,
    }), ERR.CAS_MISMATCH, '旧 reservation 写入');
    assert.ok(staleWrite.detail.problems.includes('reservation-superseded'));
    assert.ok(staleWrite.detail.problems.includes('reservation-state-committed'));
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# v3\n');

    const rejected = expectCode(() => store.rollback(first.reservationId), ERR.RESERVATION_INVALID, '旧 reservation 回滚');
    assert.ok(rejected.detail.problems.includes('reservation-superseded'));
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# v3\n', '被拒绝的回滚不得破坏新内容');
    const afterReject = store.read('MEMORY.md');
    assert.equal(afterReject.generation, 3);
    assert.equal(afterReject.trust, TRUST.AUTHORITY);
    assert.equal(afterReject.externalChange, false);

    // 允许的回滚（自己就是当前 generation 的源头）也不能按字节恢复：
    // DB 不存正文 pre-image，只能撤回登记并把该条标 drift，交人工核对。
    const rolledBack = store.rollback(second.reservationId);
    assert.equal(rolledBack.rolledBack, true);
    assert.equal(rolledBack.restored, false);
    assert.equal(rolledBack.trust, TRUST.DRIFT);
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# v3\n', '回滚绝不删改权威文件');
    const afterRollback = store.read('MEMORY.md');
    assert.equal(afterRollback.trust, TRUST.DRIFT);
    assert.equal(afterRollback.externalChange, false, '文件没变，变的是「这次写入被撤回」');
    assert.equal(store.listForInjection().length, 0);
  });
});

test('并发 CAS：两个真实子进程抢同一张 reservation，恰好一个成功', async () => {
  const created = sandbox('race');
  const setupDb = openDb(created.dbPath);
  const setupStore = createMemoryStore({ root: created.memoryDir, db: setupDb });
  seedMemory(created.memoryDir, 'MEMORY.md', '# v1 并发前\n');
  const adopted = setupStore.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
  const reservation = setupStore.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority', ttlMs: 120000 });
  setupDb.close();

  const contents = ['# 队伍A写入\n', '# 队伍B写入\n'];
  const statuses = await Promise.all(contents.map(async (content, index) => {
    const childDir = path.join(created.dir, `race-${index}`);
    fs.mkdirSync(childDir, { recursive: true });
    return { index, childDir, content };
  }));

  const children = statuses.map(({ index, childDir, content }) => {
    const readyPath = path.join(childDir, 'ready');
    const goPath = path.join(childDir, 'go');
    const resultPath = path.join(childDir, 'result.json');
    const spawned = spawnChild(path.join(SUPPORT_DIR, 'memory-cas-child.mjs'), {
      MEMORY_CAS_ROOT: created.memoryDir,
      MEMORY_CAS_DB: created.dbPath,
      MEMORY_CAS_REL: 'MEMORY.md',
      MEMORY_CAS_RESERVATION: reservation.reservationId,
      MEMORY_CAS_EXPECTED_HASH: reservation.expectedHash,
      MEMORY_CAS_WRITER: 'authority',
      MEMORY_CAS_CONTENT_B64: Buffer.from(content, 'utf8').toString('base64'),
      MEMORY_CAS_READY: readyPath,
      MEMORY_CAS_GO: goPath,
      MEMORY_CAS_RESULT: resultPath,
      MEMORY_CAS_ATTEMPT: String(index),
    });
    return { ...spawned, readyPath, goPath, resultPath, index, content };
  });

  for (const child of children) await waitForFile(child.readyPath);
  for (const child of children) fs.writeFileSync(child.goPath, 'go', 'utf8');
  const exits = await Promise.all(children.map((child) => child.done));
  for (const exit of exits) assert.equal(exit.code, 0, '子进程必须正常退出');

  const results = children.map((child) => {
    assert.equal(fs.existsSync(child.resultPath), true, `子进程 ${child.index} 没写结果`);
    return { ...JSON.parse(fs.readFileSync(child.resultPath, 'utf8')), index: child.index };
  });

  const winners = results.filter((result) => result.ok === true);
  const losers = results.filter((result) => result.ok !== true);
  assert.equal(winners.length, 1, `必须恰好一个成功，实际：${JSON.stringify(results)}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, ERR.CAS_MISMATCH, `失败方必须是 CAS_MISMATCH，实际：${JSON.stringify(losers[0])}`);

  const winnerContent = children[winners[0].index].content;
  assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), winnerContent, '磁盘只留成功者的内容');

  const verifyDb = openDb(created.dbPath);
  try {
    const store = createMemoryStore({ root: created.memoryDir, db: verifyDb });
    const current = store.read('MEMORY.md');
    assert.equal(current.generation, 2);
    assert.equal(current.externalChange, false, '只有一次提交，磁盘与 registry 必须一致');
    assert.equal(current.trust, TRUST.AUTHORITY);
    assert.equal(current.hash, sha256Hex(Buffer.from(winnerContent, 'utf8')));
    assert.equal(current.hash, winners[0].hash);
    assert.equal(auditRows(verifyDb, { path: 'MEMORY.md', kind: 'write' }).length, 1, '只能有一条写成功审计');
    assert.ok(auditRows(verifyDb, { path: 'MEMORY.md', kind: 'cas-reject' }).length >= 1, '失败方必须留下拒绝审计');
    assert.notEqual(adopted.hash, current.hash);
  } finally {
    verifyDb.close();
  }
});

test('文件与 DB 不一致：reconcile 报 drift、保持 fail-closed、注入排除', () => {
  withStore('reconcile', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 登记内容\n');
    seedMemory(created.memoryDir, 'STABLE.md', '# 稳定内容\n');
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    store.adopt({ relPath: 'STABLE.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });

    fs.writeFileSync(created.abs('MEMORY.md'), '# 外部改写\n', 'utf8'); // 只改文件，不动 DB
    const report = store.reconcile();

    assert.deepEqual(report.drifted.map((row) => row.relPath), ['MEMORY.md']);
    assert.equal(report.drifted[0].reason, 'content-change');
    assert.equal(report.drifted[0].newlyMarked, true);
    assert.deepEqual(report.ok.map((row) => row.relPath), ['STABLE.md']);

    const registry = db.prepare('SELECT * FROM memory_registry WHERE path = ?').get('MEMORY.md');
    assert.equal(registry.trust, TRUST.DRIFT);
    assert.equal(registry.content_hash, adopted.hash, 'DB 里的登记 hash 不得被外部内容覆盖');
    assert.equal(Number(registry.generation), 1);
    const driftAudit = auditRows(db, { path: 'MEMORY.md', kind: 'drift' });
    assert.equal(driftAudit.length, 1);
    assert.equal(parseAuditDetail(driftAudit[0]).hashSame, false);

    assert.deepEqual(store.listForInjection().map((row) => row.relPath), ['STABLE.md']);
    assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), '# 外部改写\n', 'reconcile 不得用旧 hash 覆盖文件');

    // 第二次 reconcile 不重复刷审计（newlyMarked=false），但仍然报 drift（不自动恢复）
    const second = store.reconcile();
    assert.deepEqual(second.drifted.map((row) => row.relPath), ['MEMORY.md']);
    assert.equal(second.drifted[0].reason, 'content-change');
    assert.equal(second.drifted[0].newlyMarked, false);
    assert.equal(auditRows(db, { path: 'MEMORY.md', kind: 'drift' }).length, 1);
  });
});

test('未登记记忆一律 untrusted：正文可读，但不进注入、不自动登记、不可写', () => {
  withStore('unregistered', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'notes/raw.md', '# 未登记的记忆\n');
    const readResult = store.read('notes/raw.md');
    assert.equal(readResult.registered, false);
    assert.equal(readResult.trust, TRUST.UNTRUSTED);
    assert.equal(readResult.content, '# 未登记的记忆\n');
    assert.equal(readResult.generation, 0);
    assert.equal(countRows(db, 'memory_registry'), 0, 'read 不得自动登记未登记文件');

    assert.deepEqual(store.listForInjection(), []);
    const injection = buildInjection({ entries: [readResult] });
    assert.deepEqual(injection.included, []);
    assert.deepEqual(injection.rejected.map((row) => row.reason), ['untrusted']);

    expectCode(() => store.write({
      relPath: 'notes/raw.md',
      content: '# 想接管\n',
      writerIdentity: 'agent:x',
      expectedHash: sha256Hex(Buffer.from('# 未登记的记忆\n', 'utf8')),
    }), ERR.UNTRUSTED_MEMORY, '未登记文件写入');

    const report = store.reconcile();
    assert.deepEqual(report.unregistered, ['notes/raw.md']);
    assert.equal(fs.readFileSync(created.abs('notes/raw.md'), 'utf8'), '# 未登记的记忆\n');
  });
});

test('quarantine：已登记记忆可降级为 untrusted 并留审计', () => {
  withStore('quarantine', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 作者记忆\n');
    store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    const result = store.quarantine('MEMORY.md', '人工复核：来源存疑');
    assert.equal(result.trust, TRUST.UNTRUSTED);
    assert.equal(result.previousTrust, TRUST.AUTHORITY);
    const audit = auditRows(db, { path: 'MEMORY.md', kind: 'quarantine' });
    assert.equal(audit.length, 1);
    const detail = parseAuditDetail(audit[0]);
    assert.equal(detail.reason, '人工复核：来源存疑');
    assert.equal(detail.hashSame, true);
    assert.deepEqual(store.listForInjection(), []);
    expectCode(() => store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' }), ERR.UNTRUSTED_MEMORY, 'quarantine 后申请 reservation');
  });
});

test('写入者身份：reservation 是授权凭证，凭别人的凭证写被拒', () => {
  withStore('writer-identity', ({ sandbox: created, db, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 权威记忆\n第一版\n');
    seedMemory(created.memoryDir, 'NOTES.md', '# 备注\n第一版\n');
    const absPath = created.abs('MEMORY.md');
    store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    store.adopt({ relPath: 'NOTES.md', writerIdentity: 'authority', trust: TRUST.TRUSTED });

    // 1) 非 authority 写者申请到自己的 reservation 后可以写（且只影响这一条路径）。
    const agentReservation = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'agent:assistant' });
    const thief = expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# 别人代写\n',
      writerIdentity: 'agent:thief',
      reservationId: agentReservation.reservationId,
      expectedHash: agentReservation.expectedHash,
    }), ERR.CAS_MISMATCH, '拿别人的 reservation 写');
    assert.ok(thief.detail.problems.includes('reservation-writer-mismatch'));
    assert.equal(fs.readFileSync(absPath, 'utf8'), '# 权威记忆\n第一版\n');
    assert.ok(auditRows(db, { path: 'MEMORY.md', kind: 'cas-reject' }).length >= 1);

    const authorized = store.write({
      relPath: 'MEMORY.md',
      content: '# agent 授权写入\n',
      writerIdentity: 'agent:assistant',
      reservationId: agentReservation.reservationId,
      expectedHash: agentReservation.expectedHash,
    });
    assert.equal(authorized.generation, 2);
    assert.equal(authorized.writerIdentity, 'agent:assistant');
    const registry = db.prepare('SELECT * FROM memory_registry WHERE path = ?').get('MEMORY.md');
    assert.equal(registry.writer_identity, 'agent:assistant');
    // trust 是「这条记忆的登记等级」，不因为写入者不是 authority 就被抬高或降低。
    assert.equal(registry.trust, TRUST.AUTHORITY);
    assert.equal(store.read('MEMORY.md').trust, TRUST.AUTHORITY);
    // 别的路径没有被连带修改。
    assert.equal(fs.readFileSync(created.abs('NOTES.md'), 'utf8'), '# 备注\n第一版\n');
  });
});

test('写入保留正文与格式原样：不归一化换行、尾随空格、BOM', () => {
  withStore('format', ({ sandbox: created, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 标题\r\n\r\n原始\n');
    store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    const next = '\uFEFF# 标题\r\n\r\n- 条目一  \r\n- 条目二\t\n尾随空格 \r\n';
    const reservation = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority' });
    const written = store.write({
      relPath: 'MEMORY.md',
      content: next,
      writerIdentity: 'authority',
      reservationId: reservation.reservationId,
      expectedHash: reservation.expectedHash,
    });
    assert.deepEqual(fs.readFileSync(created.abs('MEMORY.md')), Buffer.from(next, 'utf8'), '磁盘字节必须与传入内容完全一致');
    assert.equal(written.hash, sha256Hex(Buffer.from(next, 'utf8')));
    const readBack = store.read('MEMORY.md');
    assert.equal(readBack.content, next, '读回不得改写正文/格式');
    assert.equal(readBack.hash, written.hash);
    assert.equal(readBack.externalChange, false);
  });
});

test('路径越界：绝对路径与 .. 一律 INVALID_ARGUMENT', () => {
  withStore('escape', ({ sandbox: created, store }) => {
    seedMemory(created.memoryDir, 'MEMORY.md', '# 正常\n');
    store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    expectCode(() => store.read(path.join(created.dir, 'outside.md')), ERR.INVALID_ARGUMENT, '绝对路径');
    expectCode(() => store.read('../outside.md'), ERR.INVALID_ARGUMENT, '父目录越界');
    expectCode(() => store.adopt({ relPath: '..\\evil.md', writerIdentity: 'authority' }), ERR.INVALID_ARGUMENT, '反斜杠越界');
  });
});
