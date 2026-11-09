// 跨介质原子性：文件已原子落盘、memory_registry 尚未提交时进程死掉。
//
// 用真实子进程（node:child_process.spawn 跑 tests/support/memory-crash-child.mjs）在
// hooks.beforeRegistryCommit 处 SIGKILL 自己，父进程随后 reconcile()，断言：
//   * 该条被判 drift、注入被拒；
//   * DB 没有被伪造成「已提交」（旧 hash / 旧 generation / reservation 仍 open）；
//   * 文件侧的新内容仍然在磁盘上（reconcile 不拿 DB 旧 hash 去覆盖文件）。

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
  createSandbox,
  runChild,
  seedMemory,
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

test('真实子进程在 beforeRegistryCommit 被 SIGKILL ⇒ reconcile 判 drift 且 fail-closed', async () => {
  const created = sandbox('crash');
  seedMemory(created.memoryDir, 'MEMORY.md', '# 崩溃前\n');

  // 父进程先完成 adopt + reserve，再关闭连接，避免和子进程抢锁。
  const setupDb = openDb(created.dbPath);
  const setupStore = createMemoryStore({ root: created.memoryDir, db: setupDb });
  const adopted = setupStore.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
  const reservation = setupStore.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority', ttlMs: 600000 });
  setupDb.close();

  const newContent = '# 崩溃窗口里的新内容\n';
  const marker = path.join(created.dir, 'hook-reached.json');
  const exit = await runChild(path.join(SUPPORT_DIR, 'memory-crash-child.mjs'), {
    MEMORY_CRASH_ROOT: created.memoryDir,
    MEMORY_CRASH_DB: created.dbPath,
    MEMORY_CRASH_REL: 'MEMORY.md',
    MEMORY_CRASH_RESERVATION: reservation.reservationId,
    MEMORY_CRASH_EXPECTED_HASH: reservation.expectedHash,
    MEMORY_CRASH_WRITER: 'authority',
    MEMORY_CRASH_CONTENT_B64: Buffer.from(newContent, 'utf8').toString('base64'),
    MEMORY_CRASH_MARKER: marker,
    MEMORY_CRASH_MODE: 'kill',
  });

  assert.equal(fs.existsSync(marker), true, '子进程必须真的执行到 hooks.beforeRegistryCommit');
  // Windows 上 SIGKILL 走 TerminateProcess，退出码非 0 且没有 signal；POSIX 上 signal 是 SIGKILL。
  assert.ok(exit.code !== 0 || exit.signal === 'SIGKILL', `子进程应被强杀，实际 code=${exit.code} signal=${exit.signal}`);
  // 崩溃点在「落盘之后」：磁盘已经是新内容。
  assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), newContent);

  const db = openDb(created.dbPath);
  try {
    // DB 必须仍然是未提交状态：旧 hash / 旧 generation / reservation 仍 open。
    const registry = db.prepare('SELECT * FROM memory_registry WHERE path = ?').get('MEMORY.md');
    assert.equal(registry.content_hash, adopted.hash, 'DB 不得把这次写入伪造成已提交');
    assert.equal(Number(registry.generation), 1);
    assert.equal(registry.trust, TRUST.AUTHORITY);
    const reservationRow = db.prepare('SELECT * FROM memory_reservation WHERE reservation_id = ?')
      .get(reservation.reservationId);
    assert.equal(reservationRow.state, 'open', '崩溃窗口里的 reservation 不应是 committed');

    const store = createMemoryStore({ root: created.memoryDir, db });
    const report = store.reconcile();
    assert.deepEqual(report.drifted.map((row) => row.relPath), ['MEMORY.md']);
    assert.equal(report.drifted[0].reason, 'content-change');
    assert.equal(report.drifted[0].hashSame, false);
    assert.deepEqual(report.ok, []);
    assert.equal(store.read('MEMORY.md').trust, TRUST.DRIFT);
    assert.equal(
      db.prepare('SELECT trust FROM memory_registry WHERE path = ?').get('MEMORY.md').trust,
      TRUST.DRIFT,
    );

    // 注入被排除（listForInjection 与 buildInjection 双重确认）。
    assert.deepEqual(store.listForInjection(), []);
    const injection = buildInjection({ entries: store.listForInjection() });
    assert.equal(injection.text, '');
    assert.deepEqual(injection.included, []);

    // reconcile 不得用 DB 的旧 hash 覆盖文件，也不得把文件当成已提交内容。
    assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), newContent);

    // 之后仍然拒绝写入（drift）。
    expectCode(() => store.write({
      relPath: 'MEMORY.md',
      content: '# 崩溃后再写\n',
      writerIdentity: 'authority',
      expectedHash: sha256Hex(Buffer.from(newContent, 'utf8')),
    }), ERR.MEMORY_DRIFT, '崩溃后写入');
    assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), newContent);

    const driftAudit = auditRows(db, { path: 'MEMORY.md', kind: 'drift' });
    assert.equal(driftAudit.length, 1);
    assert.equal(JSON.parse(driftAudit[0].detail).hashSame, false);
  } finally {
    db.close();
  }
});

test('提交前 hook 抛错（进程存活）⇒ 同样留下跨介质中间态，由 reconcile 判 drift', () => {
  const created = sandbox('hook-throw');
  seedMemory(created.memoryDir, 'MEMORY.md', '# 提交前\n');
  const db = openDb(created.dbPath);
  try {
    const store = createMemoryStore({
      root: created.memoryDir,
      db,
      hooks: {
        beforeRegistryCommit: () => { throw new Error('注入的 registry 提交失败'); },
      },
    });
    const adopted = store.adopt({ relPath: 'MEMORY.md', writerIdentity: 'authority', trust: TRUST.AUTHORITY });
    const reservation = store.reserve({ relPath: 'MEMORY.md', writerIdentity: 'authority', ttlMs: 600000 });
    const newContent = '# 落盘成功但提交失败\n';

    assert.throws(() => store.write({
      relPath: 'MEMORY.md',
      content: newContent,
      writerIdentity: 'authority',
      reservationId: reservation.reservationId,
      expectedHash: reservation.expectedHash,
    }), /注入的 registry 提交失败/);

    // write 失败 → 事务回滚：registry 保持登记时的旧事实。
    const registry = db.prepare('SELECT * FROM memory_registry WHERE path = ?').get('MEMORY.md');
    assert.equal(registry.content_hash, adopted.hash);
    assert.equal(Number(registry.generation), 1);
    assert.equal(registry.trust, TRUST.AUTHORITY);
    assert.equal(
      db.prepare('SELECT state FROM memory_reservation WHERE reservation_id = ?').get(reservation.reservationId).state,
      'open',
    );
    assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), newContent, '文件已换是这条路径的真实后果');

    const report = store.reconcile();
    assert.deepEqual(report.drifted.map((row) => row.relPath), ['MEMORY.md']);
    assert.equal(store.read('MEMORY.md').trust, TRUST.DRIFT);
    assert.deepEqual(store.listForInjection(), []);
    assert.equal(fs.readFileSync(created.abs('MEMORY.md'), 'utf8'), newContent);
  } finally {
    db.close();
  }
});
