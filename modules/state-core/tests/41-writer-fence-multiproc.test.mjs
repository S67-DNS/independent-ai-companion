import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { openDb } from '../src/candidate/db.mjs';
import { createWriterFence } from '../src/candidate/writer-fence.mjs';
import { ERR } from '../src/candidate/errors.mjs';
import { tempDir, spawnChild, parseArgs } from './support/tmp.mjs';

const CHILD = 'fence-child.mjs';

function dbAt(dir, name = 'opencore.db') {
  return path.join(dir, name);
}

test('A11 两进程竞争：子进程持有未过期租约时，父进程 claim 必须 WRITER_BUSY', async () => {
  const dir = tempDir('fence-a11');
  const dbPath = dbAt(dir);
  const sid = 'session-shared';

  const child = spawnChild(CHILD, ['claim-and-hold', ...parseArgs({ db: dbPath, sid, ttl: 30000, hold: 4000 })]);
  const claimed = await child.next();
  assert.equal(claimed.ok, true, `子进程应成功 claim：${JSON.stringify(claimed)}`);

  const db = openDb(dbPath, { busyTimeoutMs: 3000 });
  const fence = createWriterFence({ db });
  const snap = fence.snapshot(sid);
  assert.equal(snap.runId, claimed.runId);
  assert.throws(
    () => fence.claim({ sessionId: sid, writerIdentity: 'parent' }),
    (e) => e.code === ERR.WRITER_BUSY,
    '父进程不该能拿到子进程仍持有且未过期的租约',
  );
  db.close();
  child.closeStdin();
  await child.waitExit(8000);
});

test('A12 旧 Writer 延迟提交：接管后旧 token 提交必须 FENCE_LOST，且不落任何事件', async () => {
  const dir = tempDir('fence-a12');
  const dbPath = dbAt(dir);
  const sid = 'session-delayed';

  // 旧 writer 用 800ms 租约 claim，然后停住等指令提交。
  const child = spawnChild(CHILD, ['delayed-commit', ...parseArgs({ db: dbPath, sid, ttl: 800 })]);
  const claimed = await child.next();
  assert.equal(claimed.ok, true);
  assert.equal(claimed.revision, 1);

  await new Promise((r) => setTimeout(r, 1100)); // 让租约过期

  const db = openDb(dbPath, { busyTimeoutMs: 3000 });
  const fence = createWriterFence({ db });
  const takeover = fence.claim({ sessionId: sid, writerIdentity: 'new-writer', ttlMs: 30000 });
  assert.equal(takeover.revision, claimed.revision + 1, '接管必须推高 lifecycleRevision');
  assert.notEqual(takeover.runId, claimed.runId);

  // 现在让旧 writer 用旧 revision 提交。
  child.send('commit');
  const result = await child.next();
  assert.equal(result.ok, false, `旧 writer 不应提交成功：${JSON.stringify(result)}`);
  assert.equal(result.code, ERR.FENCE_LOST);
  assert.equal(result.phase, 'commit');

  const rows = db.prepare('SELECT COUNT(*) c FROM session_event WHERE session_id = ?').get(sid).c;
  assert.equal(rows, 0, '旧 writer 的延迟写入绝不能落库');
  const takeoverAudit = fence.audit(sid).filter((a) => a.kind === 'takeover');
  assert.equal(takeoverAudit.length, 1);
  db.close();
  await child.waitExit(8000);
});

test('A13 进程强杀（事务中）：事务回滚、无半条记录、可重新接管', async () => {
  const dir = tempDir('fence-a13');
  const dbPath = dbAt(dir);
  const sid = 'session-kill';

  const child = spawnChild(CHILD, ['kill-in-tx', ...parseArgs({ db: dbPath, sid, ttl: 60000, crash: 'inside-tx' })]);
  const claimed = await child.next();
  assert.equal(claimed.ok, true);
  const exit = await child.waitExit(10000);
  // Windows 上 Node 的 SIGKILL 自杀会以 exit code 1（无 signal 标记）收场；
  // 断言「不是正常退出」而不是死磕 signal 名，避免把平台差异当成功能失败。
  const abnormal = exit.signal === 'SIGKILL' || exit.code === 1 || exit.code === 137 || exit.code === null;
  assert.ok(abnormal, `应当是被强杀的进程，实际 exit=${JSON.stringify(exit)}`);

  const db = openDb(dbPath, { busyTimeoutMs: 5000 });
  const integrity = db.prepare('PRAGMA integrity_check').get();
  assert.equal(Object.values(integrity)[0], 'ok', 'WAL 恢复后数据库必须完好');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_event').get().c, 0, '未提交事务不得留下任何行');

  const fence = createWriterFence({ db });
  const after = fence.claim({ sessionId: sid, writerIdentity: 'rescuer', ttlMs: 30000 });
  assert.equal(after.revision, claimed.revision + 1, 'owner 进程已死 → 可以直接接管，且 revision 必须递增');
  db.close();
});

test('A14 持有者被杀后立刻 takeover（不必等租约自然过期）', async () => {
  const dir = tempDir('fence-a14');
  const dbPath = dbAt(dir);
  const sid = 'session-dead-owner';

  const child = spawnChild(CHILD, ['claim-and-hold', ...parseArgs({ db: dbPath, sid, ttl: 120000 })]);
  const claimed = await child.next();
  assert.equal(claimed.ok, true);

  child.kill();
  await child.waitExit(10000);

  const db = openDb(dbPath, { busyTimeoutMs: 5000 });
  const fence = createWriterFence({ db });
  const t0 = Date.now();
  const takeover = fence.claim({ sessionId: sid, writerIdentity: 'rescuer', ttlMs: 30000 });
  const elapsed = Date.now() - t0;
  assert.equal(takeover.revision, claimed.revision + 1);
  assert.ok(elapsed < 5000, `owner 进程已死应立即接管，实际用了 ${elapsed}ms`);
  assert.ok(fence.audit(sid).some((a) => a.kind === 'takeover' && a.detail?.reason === 'lease-expired-or-owner-dead'));
  db.close();
});

test('A15 多进程 SQLite 锁竞争：并发 claim/release 不产生非预期错误、不变量不被破坏', async () => {
  const dir = tempDir('fence-a15');
  const dbPath = dbAt(dir);
  const sid = 'session-stress';

  const children = Array.from({ length: 3 }, () => spawnChild(CHILD, [
    'stress-claim', ...parseArgs({ db: dbPath, sid, rounds: 15 }),
  ]));
  const results = await Promise.all(children.map(async (c) => {
    const line = await c.next(30000);
    await c.waitExit(30000);
    return line;
  }));
  for (const r of results) {
    assert.equal(r.ok, true, `压力子进程失败：${JSON.stringify(r)}`);
    assert.equal(r.other, 0, `只允许 writer-busy，不允许其它错误：${JSON.stringify(r)}`);
  }
  const totalOk = results.reduce((n, r) => n + r.succeeded, 0);
  const totalBusy = results.reduce((n, r) => n + r.busy, 0);
  assert.ok(totalOk > 0);
  assert.equal(totalOk + totalBusy, 3 * 15, '每一轮都必须有明确结果（成功或被拒），不允许静默丢失');

  const db = openDb(dbPath, { busyTimeoutMs: 5000 });
  assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_event').get().c, 0, 'stress 只 claim/release，不应写事件');
  const fence = createWriterFence({ db });
  const snap = fence.snapshot(sid);
  assert.equal(snap.state, 'idle', 'stress 结束时应已释放（idle）');
  db.close();
});

test('A16 重启恢复：崩溃后重开 DB，审计与 revision 连续、claim 不重复建行', async () => {
  const dir = tempDir('fence-a16');
  const dbPath = dbAt(dir);
  const sid = 'session-recover';

  const child = spawnChild(CHILD, ['kill-in-tx', ...parseArgs({ db: dbPath, sid, ttl: 5000, crash: 'inside-tx' })]);
  await child.next();
  await child.waitExit(10000);
  await new Promise((r) => setTimeout(r, 200)); // 等租约过期

  const db = openDb(dbPath);
  const fence = createWriterFence({ db });
  const c1 = fence.claim({ sessionId: sid, writerIdentity: 'recover-1', ttlMs: 5000 });
  fence.release({ sessionId: sid, ...c1 });
  db.close();

  const db2 = openDb(dbPath);
  const fence2 = createWriterFence({ db: db2 });
  const c2 = fence2.claim({ sessionId: sid, writerIdentity: 'recover-2', ttlMs: 5000 });
  assert.equal(c2.revision, c1.revision + 1);
  const rowCount = db2.prepare('SELECT COUNT(*) c FROM writer_claim WHERE session_id = ?').get(sid).c;
  assert.equal(rowCount, 1, '每个 session 只允许一行 claim');
  assert.ok(fs.existsSync(dbPath));
  db2.close();
});
