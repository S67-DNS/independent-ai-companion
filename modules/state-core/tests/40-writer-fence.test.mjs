import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openDb } from '../src/candidate/db.mjs';
import { createWriterFence } from '../src/candidate/writer-fence.mjs';
import { CandidateError, ERR } from '../src/candidate/errors.mjs';
import { tempDir } from './support/tmp.mjs';

function freshDb(tag) {
  const dir = tempDir(tag);
  return { dir, dbPath: path.join(dir, 'opencore.db'), db: openDb(path.join(dir, 'opencore.db')) };
}

const ctx = (sessionId) => ({ sessionId });

test('A1 首次 claim 建立所有权，revision 从 1 开始', () => {
  const { db } = freshDb('fence-a1');
  const fence = createWriterFence({ db });
  assert.equal(fence.snapshot('s1'), null);
  const res = fence.claim({ sessionId: 's1', writerIdentity: 'authority' });
  assert.equal(res.revision, 1);
  assert.match(res.runId, /^run_/);
  const snap = fence.snapshot('s1');
  assert.equal(snap.state, 'active');
  assert.equal(snap.runId, res.runId);
  assert.equal(snap.revision, 1);
  db.close();
});

test('A2 同一 session 第二个 writer 被拒绝（WRITER_BUSY），不推高 revision', () => {
  const { db } = freshDb('fence-a2');
  const fence = createWriterFence({ db });
  const first = fence.claim({ sessionId: 's1', writerIdentity: 'writer-A' });
  assert.throws(
    () => fence.claim({ sessionId: 's1', writerIdentity: 'writer-B' }),
    (error) => error instanceof CandidateError && error.code === ERR.WRITER_BUSY,
  );
  const snap = fence.snapshot('s1');
  assert.equal(snap.revision, first.revision);
  assert.equal(snap.runId, first.runId);
  // 被拒绝的事实必须留审计。
  const audit = fence.audit('s1');
  assert.ok(audit.some((a) => a.kind === 'denied'));
  db.close();
});

test('A3 assertFence：runId 不符 / revision 不符 / 租约过期 三种失权都要报出来', () => {
  let clock = 1_000_000;
  const { db } = freshDb('fence-a3');
  const fence = createWriterFence({ db, now: () => clock });
  const claim = fence.claim({ sessionId: 's1', writerIdentity: 'w', ttlMs: 1000 });
  assert.doesNotThrow(() => fence.assertFence({ sessionId: 's1', runId: claim.runId, revision: claim.revision }));

  assert.throws(
    () => fence.assertFence({ sessionId: 's1', runId: 'run_other', revision: claim.revision }),
    (e) => e.code === ERR.FENCE_LOST,
  );
  assert.throws(
    () => fence.assertFence({ sessionId: 's1', runId: claim.runId, revision: claim.revision + 1 }),
    (e) => e.code === ERR.FENCE_LOST,
  );
  clock += 1001;
  assert.throws(
    () => fence.assertFence({ sessionId: 's1', runId: claim.runId, revision: claim.revision }),
    (e) => e.code === ERR.LEASE_EXPIRED,
  );
  db.close();
});

test('A4 租约过期后可 takeover，revision 单调递增，旧 token 永久失效', () => {
  let clock = 2_000_000;
  const { db } = freshDb('fence-a4');
  const fence = createWriterFence({ db, now: () => clock });
  const old = fence.claim({ sessionId: 's1', writerIdentity: 'old', ttlMs: 1000 });
  clock += 1001;
  const fresh = fence.claim({ sessionId: 's1', writerIdentity: 'new', ttlMs: 1000 });
  assert.equal(fresh.revision, old.revision + 1);
  assert.notEqual(fresh.runId, old.runId);
  assert.throws(
    () => fence.assertFence({ sessionId: 's1', runId: old.runId, revision: old.revision }),
    (e) => e.code === ERR.FENCE_LOST,
  );
  assert.ok(fence.audit('s1').some((a) => a.kind === 'takeover'));
  db.close();
});

test('A5 withFence：正常提交落库；fn 抛错则整事务回滚（不落半条）', () => {
  const { db } = freshDb('fence-a5');
  const fence = createWriterFence({ db });
  const claim = fence.claim({ sessionId: 's1', writerIdentity: 'w' });
  const insert = (txdb, kind) => txdb.prepare(
    'INSERT INTO session_event(session_id, run_id, revision, kind, payload, at_ms) VALUES (?,?,?,?,?,?)',
  ).run('s1', claim.runId, claim.revision, kind, '{}', Date.now());

  fence.withFence({ sessionId: 's1', ...claim }, (txdb) => insert(txdb, 'ok'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_event').get().c, 1);

  assert.throws(
    () => fence.withFence({ sessionId: 's1', ...claim }, (txdb) => { insert(txdb, 'boom'); throw new Error('业务失败'); }),
    /业务失败/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_event').get().c, 1, '失败事务不能留下半条记录');
  db.close();
});

test('A6 withFence：事务中失权（fn 里释放所有权）必须在 COMMIT 前被拦下', () => {
  const { db } = freshDb('fence-a6');
  const fence = createWriterFence({ db });
  const claim = fence.claim({ sessionId: 's1', writerIdentity: 'w' });
  assert.throws(
    () => fence.withFence({ sessionId: 's1', ...claim }, (txdb) => {
      txdb.prepare('INSERT INTO session_event(session_id, run_id, revision, kind, payload, at_ms) VALUES (?,?,?,?,?,?)')
        .run('s1', claim.runId, claim.revision, 'mid', '{}', Date.now());
      // 事务体自己把所有权弄丢：COMMIT 前复核必须发现。
      db.prepare("UPDATE writer_claim SET state='idle', active_writer_run_id=NULL WHERE session_id='s1'").run();
    }),
    (e) => e.code === ERR.FENCE_LOST,
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_event').get().c, 0, '失权事务必须回滚');
  db.close();
});

test('A7 renew：只有当前 owner 能续租；续租后过期时间前移', () => {
  let clock = 3_000_000;
  const { db } = freshDb('fence-a7');
  const fence = createWriterFence({ db, now: () => clock });
  const claim = fence.claim({ sessionId: 's1', writerIdentity: 'w', ttlMs: 10_000 });
  clock += 5000; // 仍在租约内，续租应当成功
  const renewed = fence.renew({ sessionId: 's1', runId: claim.runId, revision: claim.revision, ttlMs: 10_000 });
  assert.equal(renewed.leaseExpiresAtMs, clock + 10_000);
  assert.throws(
    () => fence.renew({ sessionId: 's1', runId: 'run_other', revision: claim.revision, ttlMs: 1000 }),
    (e) => e.code === ERR.FENCE_LOST,
  );
  db.close();
});

test('A8 release：非 owner 释放失败；owner 释放后无主，再 claim 拿到 revision+1', () => {
  const { db } = freshDb('fence-a8');
  const fence = createWriterFence({ db });
  const claim = fence.claim({ sessionId: 's1', writerIdentity: 'w' });
  assert.throws(
    () => fence.release({ sessionId: 's1', runId: 'run_other', revision: claim.revision }),
    (e) => e.code === ERR.FENCE_LOST,
  );
  const rel = fence.release({ sessionId: 's1', ...claim });
  assert.equal(rel.released, true);
  assert.equal(fence.snapshot('s1').state, 'idle');
  const second = fence.claim({ sessionId: 's1', writerIdentity: 'w2' });
  assert.equal(second.revision, claim.revision + 1);
  db.close();
});

test('A9 无 fence 写入口必须关闭：denyUnfenced 抛 NO_FENCE 且留审计', () => {
  const { db } = freshDb('fence-a9');
  const fence = createWriterFence({ db });
  assert.throws(
    () => fence.denyUnfenced('s1', 'direct-write'),
    (e) => e.code === ERR.NO_FENCE,
  );
  assert.ok(fence.audit('s1').some((a) => a.kind === 'unfenced-write-denied'));
  db.close();
});

test('A10 重启恢复：新进程重新打开同一 DB 能读到所有权与审计', () => {
  const { dir, dbPath } = freshDb('fence-a10');
  const db1 = openDb(dbPath);
  const fence1 = createWriterFence({ db: db1 });
  const claim = fence1.claim({ sessionId: 's1', writerIdentity: 'w' });
  db1.close();

  const db2 = openDb(dbPath);
  const fence2 = createWriterFence({ db: db2 });
  const snap = fence2.snapshot('s1');
  assert.equal(snap.runId, claim.runId);
  assert.equal(snap.revision, claim.revision);
  // 同一进程 pid 已死？这里是同进程重开：pid 相同，所以 lease 未过期就仍然 busy。
  assert.throws(() => fence2.claim({ sessionId: 's1', writerIdentity: 'w2' }), (e) => e.code === ERR.WRITER_BUSY);
  assert.ok(fence2.audit('s1').length >= 1, `${dir} 里应有审计`);
  db2.close();
});
