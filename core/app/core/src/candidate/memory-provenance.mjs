// PROJECT_NAME候选版本 B：权威记忆的 provenance（来源可信度）与 CAS（比较并交换）层。
//
// 为什么需要这一层：
//   记忆正文是权威内容，必须继续只住在 Markdown 文件里。把它复制进 SQLite 会立刻变成
//   「第二套权威记忆」：两份都可能被改，出问题时说不清哪一份是真身。所以数据库只记录
//   「上一次被授权写入时，磁盘上那份文件长什么样」——content_hash + file_identity
//   (dev:ino:birthtimeNs) + generation + writer_identity。之后任何与登记不一致的状态
//   一律 fail-closed：不猜测、不自动接受、不自动修复。
//
// 为什么拒绝也要先提交再抛错：
//   拒绝证据（memory_audit 的 cas-reject / external-change / drift）是事后排查的唯一凭据。
//   如果「写审计 → 抛异常」都发生在同一个事务里，事务回滚会把审计一起抹掉。
//   所以校验失败时先把结果作为返回值提交，出了事务再抛 CandidateError。
//
// 为什么 read/verify 也要写盘（写 trust=drift + 审计）：
//   光在返回值里说一句「externalChange」不够 —— 别的调用方（注入、服务层）读的是
//   registry。必须把「这条已经不可信」落进数据库，后续 write 才真的会被拦住。
//
// 为什么所有写路径都包在 BEGIN IMMEDIATE 里（连 fsync 一起）：
//   文件和 SQLite 不可能有跨介质的单一原子事务。如果先校验、放锁、再落盘、再落库，
//   两个候选写入者可能都通过 CAS 校验，然后先后 rename，最终磁盘与 registry 互相矛盾。
//   把「fresh read → CAS 校验 → 原子落盘 → 提交 registry」全部关进数据库写锁里，可以
//   保证同一时刻只有一个写入者改一条路径。代价是持锁期间包含一次 fsync，可接受。
//
// 跨介质崩溃窗口（顺序固定：先落盘、后落库）：
//   write 的顺序是 writeFileAtomic() → hooks.beforeRegistryCommit → UPDATE registry。
//   如果进程在两步之间死掉，结果是「磁盘是新内容、DB 还是旧 hash」。这里故意不做补偿：
//   reconcile() 把它判成 drift 并继续拒绝注入；绝不拿 DB 的旧 hash 当真相去覆盖文件，
//   也绝不把这份未提交的文件当成已提交内容。
//
// 不缓存正文：每次 read/verify/write/injection 都重新 stat + 读盘、重新计 hash。
//   任何缓存都会让「文件在两次调用之间被 shell 改掉」这个最关键的信号消失。

import fs from 'node:fs';
import path from 'node:path';
import { CandidateError, ERR } from './errors.mjs';
import { fileIdentity, newId, nowMs, sha256Hex, writeFileAtomic, ensureDir } from './util.mjs';
import { tx } from './db.mjs';

export const TRUST = Object.freeze({
  AUTHORITY: 'authority',
  TRUSTED: 'trusted',
  UNTRUSTED: 'untrusted',
  DRIFT: 'drift',
});

/** 唯一被承认的权威写入者标识；其余身份必须凭 reservation 才能写。 */
export const AUTHORITY_WRITER = 'authority';

const INJECTABLE = new Set([TRUST.AUTHORITY, TRUST.TRUSTED]);
const ALL_TRUST = new Set(Object.values(TRUST));

const isAuthorityWriter = (writerIdentity) => writerIdentity === AUTHORITY_WRITER;

function requireString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是非空字符串`, { field });
  }
  return value;
}

/** 文件身份形如 dev:ino:birthtimeNs（见 util.fileIdentity）。拆出两侧 birthtime 才能核对替换/重建。 */
function parseIdentity(identity) {
  const parts = String(identity ?? '').split(':');
  if (parts.length !== 3) return { dev: null, ino: null, birthtimeNs: null };
  return { dev: parts[0], ino: parts[1], birthtimeNs: parts[2] };
}

/**
 * fresh read：一次调用内 stat → 读字节 → 再 stat。前后不一致说明读的时候文件正在被改，
 * 这种快照不可信，宁可重试/报错也不返回（否则会把半新半旧的字节记进 registry）。
 * hash 按**原始字节**计算：Markdown 正文与格式原样保存，不做任何归一化。
 */
function readFileSnapshot(absPath) {
  let problem = 'unknown';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before;
    try {
      before = fileIdentity(absPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new CandidateError(ERR.NOT_FOUND, `记忆文件不存在：${absPath}`, { absPath });
      }
      throw error;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(absPath);
    } catch (error) {
      if (error?.code === 'ENOENT') { problem = 'vanished-during-read'; continue; }
      throw error;
    }
    let after;
    try {
      after = fileIdentity(absPath);
    } catch {
      problem = 'vanished-during-read';
      continue;
    }
    const stable = before.identity === after.identity
      && before.size === after.size
      && before.mtimeMs === after.mtimeMs
      && bytes.length === after.size;
    if (stable) {
      return {
        content: bytes.toString('utf8'),
        hash: sha256Hex(bytes),
        size: after.size,
        identity: after.identity,
        mtimeMs: after.mtimeMs,
      };
    }
    problem = 'changed-during-read';
  }
  throw new CandidateError(
    ERR.CONFLICT,
    '读取期间文件被外部改动（前后 stat 不一致），拒绝返回不可信快照',
    { absPath, problem },
  );
}

/**
 * 把 registry 登记与磁盘快照的差异算成证据。
 *
 * 关键点：hashSame=true 但 identityChanged=true 表示「字节一样、文件对象换了」——
 * 可能是同路径替换（写临时文件再 rename 覆盖），也可能是删除后同字节重建。
 * 两者都必须按外部修改处理（不能因为 hash 没变就放行）。
 *
 * 能不能把两者分开？在 Windows 上不可靠：NTFS 的文件隧道（file tunneling）会在短时间内
 * 还原同名新文件的创建时间，于是「删除重建」可能只有 ino 变、birthtime 不变；
 * 而 rename 覆盖带来的 birthtime 取决于临时文件是什么时候创建的，方向也不固定。
 * 所以这里不做过度判定：audit detail 同时记录 hashSame、inoChanged、birthtimeChanged
 * 以及两侧完整的 identity / birthtimeNs，把「当时到底看到了什么」原样留证，
 * 让后来的审计（谁在什么时候写过这个路径）去区分，而不是靠猜。
 */
function compareRegistryToDisk(registryRow, snapshot) {
  const expected = parseIdentity(registryRow.file_identity);
  const actual = parseIdentity(snapshot.identity);
  const hashSame = snapshot.hash === registryRow.content_hash;
  const identityChanged = snapshot.identity !== registryRow.file_identity;
  return {
    externalChange: !hashSame || identityChanged,
    hashSame,
    contentChanged: !hashSame,
    identityChanged,
    inoChanged: expected.ino !== actual.ino,
    birthtimeChanged: expected.birthtimeNs !== actual.birthtimeNs,
    expectedBirthtimeNs: expected.birthtimeNs,
    actualBirthtimeNs: actual.birthtimeNs,
    expectedSize: Number(registryRow.size),
    actualSize: snapshot.size,
    changeKind: !hashSame
      ? 'content-change'
      : (identityChanged ? 'same-bytes-file-identity-change' : 'none'),
  };
}

function insertAudit(runDb, row) {
  runDb.prepare(
    `INSERT INTO memory_audit(at_ms, path, kind, generation, content_hash, writer, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Number(row.atMs),
    String(row.relPath),
    String(row.kind),
    row.generation === undefined || row.generation === null ? null : Number(row.generation),
    row.contentHash ?? null,
    row.writer ?? null,
    row.detail === undefined || row.detail === null ? null : JSON.stringify(row.detail),
  );
}

/**
 * 把一条记忆标成 drift，并留下一次性审计（只在状态真正转移时写，避免每次读盘都刷审计）。
 * 改 trust 前会重新读一次 registry 再比对：如果这期间恰好有候选写入者提交了新内容，
 * 那一份快照已经过期，不能拿它误判 drift。
 * 不改 content_hash / file_identity / generation：那几个字段是「登记时的事实」，
 * 也是事后核对 drift 的证据，不能被 drift 覆盖掉。
 */
function markDriftIn(runDb, { registryRow, snapshot, atMs, reason, writer, kind = 'drift' }) {
  const current = runDb.prepare('SELECT * FROM memory_registry WHERE path = ?').get(registryRow.path) ?? null;
  if (!current) return false;
  const verdict = snapshot ? compareRegistryToDisk(current, snapshot) : null;
  if (verdict && !verdict.externalChange) return false;
  const update = runDb.prepare(
    'UPDATE memory_registry SET trust = ? WHERE path = ? AND trust <> ?',
  ).run(TRUST.DRIFT, current.path, TRUST.DRIFT);
  const changed = Number(update?.changes ?? 0) > 0;
  if (!changed) return false;
  insertAudit(runDb, {
    atMs,
    relPath: current.path,
    kind,
    generation: Number(current.generation),
    contentHash: current.content_hash,
    writer,
    detail: {
      reason,
      hashSame: verdict ? verdict.hashSame : null,
      contentChanged: verdict ? verdict.contentChanged : null,
      identityChanged: verdict ? verdict.identityChanged : null,
      inoChanged: verdict ? verdict.inoChanged : null,
      birthtimeChanged: verdict ? verdict.birthtimeChanged : null,
      changeKind: verdict ? verdict.changeKind : (reason === 'file-missing' ? 'file-missing' : 'unknown'),
      expectedHash: current.content_hash,
      actualHash: snapshot ? snapshot.hash : null,
      expectedIdentity: current.file_identity,
      actualIdentity: snapshot ? snapshot.identity : null,
      expectedBirthtimeNs: verdict?.expectedBirthtimeNs ?? null,
      actualBirthtimeNs: verdict?.actualBirthtimeNs ?? null,
      expectedSize: Number(current.size),
      actualSize: snapshot ? snapshot.size : null,
      observedAtMs: atMs,
    },
  });
  return true;
}

/**
 * @param {{root: string, db: import('node:sqlite').DatabaseSync, now?: () => number,
 *          reservationTtlMs?: number, hooks?: {beforeRegistryCommit?: (info: object) => void}}} options
 */
export function createMemoryStore({
  root,
  db,
  now = nowMs,
  reservationTtlMs = 120000,
  hooks = {},
} = {}) {
  if (typeof root !== 'string' || root === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'root 必须是非空字符串', { field: 'root' });
  }
  if (!db || typeof db.prepare !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'db 必须是已打开的 node:sqlite DatabaseSync', { field: 'db' });
  }
  const ttlDefault = Number(reservationTtlMs);
  if (!Number.isFinite(ttlDefault) || ttlDefault <= 0) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'reservationTtlMs 必须是正数', { field: 'reservationTtlMs' });
  }

  const rootAbs = ensureDir(path.resolve(root));
  const rootReal = fs.realpathSync(rootAbs);
  const beforeRegistryCommit = typeof hooks?.beforeRegistryCommit === 'function'
    ? hooks.beforeRegistryCommit
    : () => {};

  const time = () => {
    const value = typeof now === 'function' ? now() : now;
    const ms = Number(value);
    if (!Number.isFinite(ms)) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, '注入的 now 必须返回有限数值（毫秒）', { value: String(value) });
    }
    return Math.trunc(ms);
  };

  const statementCache = new Map();
  const stmt = (sql) => {
    let prepared = statementCache.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statementCache.set(sql, prepared);
    }
    return prepared;
  };

  /**
   * 相对路径规范化 + 越界防护。只接受 memory 根内部的相对路径：
   * 绝对路径、`..`、以及指向根目录之外的软链接一律拒绝 —— 否则一个写入口就能改到
   * 隔离目录外面去，「隔离施工」的前提就没了。
   */
  function resolveRel(relPath) {
    requireString(relPath, 'relPath');
    if (path.isAbsolute(relPath)) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'relPath 必须是相对 memory 根的路径', { relPath });
    }
    const segments = relPath.replace(/\\/g, '/').split('/');
    if (segments.some((segment) => segment === '..')) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'relPath 不得包含 ..', { relPath });
    }
    const rel = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
    if (rel === '') {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'relPath 不能是 memory 根本身', { relPath });
    }
    const absPath = path.resolve(rootReal, ...rel.split('/'));
    if (absPath !== rootReal && !absPath.startsWith(rootReal + path.sep)) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'relPath 解析后越出 memory 根', { relPath, absPath });
    }
    if (fs.existsSync(absPath)) {
      const real = fs.realpathSync(absPath);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'relPath 通过软链接指向 memory 根之外', { relPath, real });
      }
    }
    return { relPath: rel, absPath };
  }

  function registryRow(relPath) {
    return stmt('SELECT * FROM memory_registry WHERE path = ?').get(relPath) ?? null;
  }

  function injectionRow(reg, resolved, snapshot) {
    return {
      relPath: reg.path,
      absPath: resolved.absPath,
      content: snapshot.content,
      hash: snapshot.hash,
      size: snapshot.size,
      identity: snapshot.identity,
      mtimeMs: snapshot.mtimeMs,
      generation: Number(reg.generation),
      trust: reg.trust,
      registered: true,
      externalChange: false,
    };
  }

  /** 首次登记：generation=1，写入当时磁盘上的 hash / 文件身份。 */
  function adopt({ relPath, writerIdentity, trust } = {}) {
    const ident = requireString(writerIdentity, 'writerIdentity');
    const resolved = resolveRel(relPath);
    const requested = trust === undefined || trust === null
      ? (isAuthorityWriter(ident) ? TRUST.AUTHORITY : TRUST.UNTRUSTED)
      : String(trust);
    if (!ALL_TRUST.has(requested) || requested === TRUST.DRIFT) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'trust 只能是 authority / trusted / untrusted（drift 只能由校验产生）', { trust });
    }
    if (requested !== TRUST.UNTRUSTED && !isAuthorityWriter(ident)) {
      throw new CandidateError(ERR.UNTRUSTED_MEMORY, '只有 authority 才能把记忆登记为 authority / trusted', {
        writerIdentity: ident,
        trust: requested,
      });
    }
    return tx(db, (runDb) => {
      const atMs = time();
      const snapshot = readFileSnapshot(resolved.absPath); // 文件不存在 ⇒ ERR.NOT_FOUND
      const existing = runDb.prepare('SELECT path FROM memory_registry WHERE path = ?').get(resolved.relPath);
      if (existing) {
        throw new CandidateError(ERR.CONFLICT, '该路径已登记；adopt 只用于首次登记', { relPath: resolved.relPath });
      }
      runDb.prepare(
        `INSERT INTO memory_registry(path, content_hash, size, file_identity, generation,
                                    writer_identity, trust, updated_at_ms, reservation_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
      ).run(
        resolved.relPath,
        snapshot.hash,
        snapshot.size,
        snapshot.identity,
        ident,
        requested,
        atMs,
      );
      insertAudit(runDb, {
        atMs,
        relPath: resolved.relPath,
        kind: 'adopt',
        generation: 1,
        contentHash: snapshot.hash,
        writer: ident,
        detail: { trust: requested, size: snapshot.size, fileIdentity: snapshot.identity },
      });
      return {
        relPath: resolved.relPath,
        absPath: resolved.absPath,
        hash: snapshot.hash,
        size: snapshot.size,
        identity: snapshot.identity,
        generation: 1,
        trust: requested,
        writerIdentity: ident,
      };
    });
  }

  /** fresh read。未登记文件返回 trust=untrusted 但正文可读（供人工查看），绝不算授权内容。 */
  function read(relPath) {
    const resolved = resolveRel(relPath);
    const snapshot = readFileSnapshot(resolved.absPath);
    const reg = registryRow(resolved.relPath);
    if (!reg) {
      return {
        relPath: resolved.relPath,
        absPath: resolved.absPath,
        content: snapshot.content,
        hash: snapshot.hash,
        size: snapshot.size,
        identity: snapshot.identity,
        mtimeMs: snapshot.mtimeMs,
        generation: 0,
        trust: TRUST.UNTRUSTED,
        declaredTrust: null,
        registered: false,
        externalChange: false,
        expected: null,
      };
    }
    const verdict = compareRegistryToDisk(reg, snapshot);
    if (verdict.externalChange) {
      const atMs = time();
      tx(db, (runDb) => {
        markDriftIn(runDb, {
          registryRow: reg,
          snapshot,
          atMs,
          reason: 'external-change-detected-on-read',
          writer: 'system:read',
          kind: 'external-change',
        });
      });
    }
    return {
      relPath: resolved.relPath,
      absPath: resolved.absPath,
      content: snapshot.content,
      hash: snapshot.hash,
      size: snapshot.size,
      identity: snapshot.identity,
      mtimeMs: snapshot.mtimeMs,
      generation: Number(reg.generation),
      trust: verdict.externalChange ? TRUST.DRIFT : reg.trust,
      declaredTrust: reg.trust,
      registered: true,
      externalChange: verdict.externalChange,
      expected: verdict.externalChange
        ? { hash: reg.content_hash, identity: reg.file_identity, generation: Number(reg.generation) }
        : null,
    };
  }

  /**
   * 只做校验，不把正文带回调用方：调用方（注入/服务层）需要的是「还能不能信」，
   * 不需要内容，少传一份正文就少一次泄露面。
   */
  function verify(relPath) {
    const resolved = resolveRel(relPath);
    const snapshot = readFileSnapshot(resolved.absPath);
    const reg = registryRow(resolved.relPath);
    if (!reg) {
      return {
        relPath: resolved.relPath,
        absPath: resolved.absPath,
        hash: snapshot.hash,
        size: snapshot.size,
        identity: snapshot.identity,
        generation: 0,
        trust: TRUST.UNTRUSTED,
        declaredTrust: null,
        registered: false,
        externalChange: false,
        hashMatches: false,
        identityMatches: false,
        ok: false,
      };
    }
    const verdict = compareRegistryToDisk(reg, snapshot);
    if (verdict.externalChange) {
      const atMs = time();
      tx(db, (runDb) => {
        markDriftIn(runDb, {
          registryRow: reg,
          snapshot,
          atMs,
          reason: 'external-change-detected-on-verify',
          writer: 'system:verify',
          kind: 'external-change',
        });
      });
    }
    const trust = verdict.externalChange ? TRUST.DRIFT : reg.trust;
    return {
      relPath: resolved.relPath,
      absPath: resolved.absPath,
      hash: snapshot.hash,
      size: snapshot.size,
      identity: snapshot.identity,
      generation: Number(reg.generation),
      trust,
      declaredTrust: reg.trust,
      registered: true,
      externalChange: verdict.externalChange,
      hashMatches: verdict.hashSame,
      identityMatches: !verdict.identityChanged,
      ok: !verdict.externalChange && INJECTABLE.has(trust),
    };
  }

  /**
   * 申请写入权（reservation 就是非 authority 写入者的授权凭证，也是同一路径的互斥锁）。
   * 同一路径同时只能有一个未过期 reservation；过期的就地收口为 expired 再放行。
   */
  function reserve({ relPath, writerIdentity, ttlMs } = {}) {
    const ident = requireString(writerIdentity, 'writerIdentity');
    const resolved = resolveRel(relPath);
    const ttl = ttlMs === undefined || ttlMs === null ? ttlDefault : Number(ttlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'ttlMs 必须是正数', { ttlMs });
    }
    const outcome = tx(db, (runDb) => {
      const atMs = time();
      const reg = runDb.prepare('SELECT * FROM memory_registry WHERE path = ?').get(resolved.relPath) ?? null;
      if (!reg) {
        throw new CandidateError(ERR.NOT_FOUND, '未登记的记忆不能申请 reservation（先 adopt）', { relPath: resolved.relPath });
      }
      if (reg.trust === TRUST.DRIFT) {
        throw new CandidateError(ERR.MEMORY_DRIFT, '该记忆已判 drift，必须先由人工核对，不能继续写入', { relPath: resolved.relPath });
      }
      if (!INJECTABLE.has(reg.trust)) {
        throw new CandidateError(ERR.UNTRUSTED_MEMORY, '未受信记忆不允许申请写入 reservation', { relPath: resolved.relPath, trust: reg.trust });
      }
      const snapshot = readFileSnapshot(resolved.absPath);
      const verdict = compareRegistryToDisk(reg, snapshot);
      if (verdict.externalChange) {
        markDriftIn(runDb, {
          registryRow: reg,
          snapshot,
          atMs,
          reason: 'external-change-detected-on-reserve',
          writer: ident,
          kind: 'external-change',
        });
        return {
          ok: false,
          error: new CandidateError(ERR.MEMORY_DRIFT, '磁盘内容与登记不一致，拒绝签发 reservation', {
            relPath: resolved.relPath,
            hashSame: verdict.hashSame,
          }),
        };
      }
      const openRows = runDb.prepare(
        `SELECT * FROM memory_reservation
          WHERE path = ? AND state = 'open'
          ORDER BY created_at_ms DESC, rowid DESC`,
      ).all(resolved.relPath);
      for (const row of openRows) {
        if (Number(row.expires_at_ms) <= atMs) {
          runDb.prepare("UPDATE memory_reservation SET state = 'expired' WHERE reservation_id = ?")
            .run(row.reservation_id);
          continue;
        }
        throw new CandidateError(ERR.CONFLICT, '同一路径已有未过期 reservation', {
          relPath: resolved.relPath,
          existingReservationId: row.reservation_id,
          expiresAtMs: Number(row.expires_at_ms),
        });
      }
      const reservationId = newId('memres');
      const expiresAtMs = atMs + Math.trunc(ttl);
      runDb.prepare(
        `INSERT INTO memory_reservation(reservation_id, path, expected_hash, expected_generation,
                                       writer_identity, created_at_ms, expires_at_ms, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
      ).run(reservationId, resolved.relPath, snapshot.hash, Number(reg.generation), ident, atMs, expiresAtMs);
      insertAudit(runDb, {
        atMs,
        relPath: resolved.relPath,
        kind: 'reserve',
        generation: Number(reg.generation),
        contentHash: snapshot.hash,
        writer: ident,
        detail: { reservationId, expiresAtMs, ttlMs: Math.trunc(ttl) },
      });
      return {
        ok: true,
        value: {
          reservationId,
          relPath: resolved.relPath,
          expectedHash: snapshot.hash,
          expectedGeneration: Number(reg.generation),
          expiresAtMs,
          writerIdentity: ident,
        },
      };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * CAS 写入。硬约束：
   *   * fresh read + 校验 + 落盘 + 提交 registry 全在同一个 BEGIN IMMEDIATE 里；
   *   * 任一前提不满足 ⇒ 抛错，且**一个字节都不写盘**；
   *   * 落盘之后、registry 提交之前是跨介质崩溃窗口，hooks.beforeRegistryCommit 就在这里。
   */
  function write({ relPath, content, writerIdentity, reservationId = null, expectedHash } = {}) {
    const ident = requireString(writerIdentity, 'writerIdentity');
    if (typeof content !== 'string') {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'content 必须是字符串（正文按原字节写入，不做归一化）', { field: 'content' });
    }
    if (typeof expectedHash !== 'string' || expectedHash === '') {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'expectedHash 必填：CAS 不接受盲目覆盖', { field: 'expectedHash' });
    }
    if (reservationId !== null && reservationId !== undefined) requireString(reservationId, 'reservationId');
    const resolved = resolveRel(relPath);
    const authority = isAuthorityWriter(ident);

    const outcome = tx(db, (runDb) => {
      const atMs = time();
      const reject = (error) => ({ ok: false, error });
      const noteReject = (generation, contentHash, detail) => insertAudit(runDb, {
        atMs,
        relPath: resolved.relPath,
        kind: 'cas-reject',
        generation,
        contentHash,
        writer: ident,
        detail,
      });

      const snapshot = readFileSnapshot(resolved.absPath);
      const reg = runDb.prepare('SELECT * FROM memory_registry WHERE path = ?').get(resolved.relPath) ?? null;
      if (!reg) {
        noteReject(null, null, { problem: 'not-registered', writerIdentity: ident });
        return reject(new CandidateError(ERR.UNTRUSTED_MEMORY, '记忆未登记：未登记文件不得被写入', { relPath: resolved.relPath }));
      }

      const verdict = compareRegistryToDisk(reg, snapshot);
      if (verdict.externalChange) {
        markDriftIn(runDb, {
          registryRow: reg,
          snapshot,
          atMs,
          reason: 'external-change-detected-before-write',
          writer: ident,
          kind: 'external-change',
        });
        return reject(new CandidateError(ERR.MEMORY_DRIFT, '磁盘内容与登记不一致（外部修改），拒绝写入', {
          relPath: resolved.relPath,
          hashSame: verdict.hashSame,
          expectedHash: reg.content_hash,
          actualHash: snapshot.hash,
        }));
      }
      if (reg.trust === TRUST.DRIFT) {
        noteReject(Number(reg.generation), reg.content_hash, { problem: 'trust-is-drift' });
        return reject(new CandidateError(ERR.MEMORY_DRIFT, '该记忆已被标为 drift，拒绝写入', { relPath: resolved.relPath }));
      }
      if (reg.trust === TRUST.UNTRUSTED) {
        noteReject(Number(reg.generation), reg.content_hash, { problem: 'trust-is-untrusted' });
        return reject(new CandidateError(ERR.UNTRUSTED_MEMORY, '未受信记忆不允许写入', { relPath: resolved.relPath }));
      }

      // 越权：非 authority 且没有 reservation（没有授权凭证）直接拒绝，连 CAS 都不进入。
      if (!authority && !reservationId) {
        noteReject(Number(reg.generation), reg.content_hash, {
          problem: 'no-reservation-for-non-authority',
          writerIdentity: ident,
        });
        return reject(new CandidateError(ERR.UNTRUSTED_MEMORY, '非 authority 写入者必须持有 reservation 才能写入', {
          relPath: resolved.relPath,
          writerIdentity: ident,
        }));
      }

      const problems = [];
      let reservation = null;
      if (!reservationId) {
        problems.push('missing-reservation-id');
      } else {
        reservation = runDb.prepare('SELECT * FROM memory_reservation WHERE reservation_id = ?').get(reservationId) ?? null;
        if (!reservation) {
          problems.push('reservation-not-found');
        } else {
          if (reservation.path !== resolved.relPath) problems.push('reservation-path-mismatch');
          if (reservation.writer_identity !== ident) problems.push('reservation-writer-mismatch');
          if (reservation.state !== 'open') {
            problems.push(`reservation-state-${reservation.state}`);
          } else if (Number(reservation.expires_at_ms) <= atMs) {
            runDb.prepare("UPDATE memory_reservation SET state = 'expired' WHERE reservation_id = ?").run(reservationId);
            problems.push('reservation-expired');
          }
          if (Number(reservation.expected_generation) !== Number(reg.generation)) problems.push('reservation-generation-stale');
          if (reservation.expected_hash !== snapshot.hash) problems.push('reservation-hash-stale');
          // 注意：不能拿 registry.reservation_id 与本次 reservation 比较 —— 上一代内容本来就
          // 由更早的 reservation 提交，「与上次源头不同」是正常的。真正要防的是这个 reservation
          // 是否仍是最新一张（reservation-superseded + generation 校验已经覆盖）。
          const latest = runDb.prepare(
            `SELECT reservation_id FROM memory_reservation
              WHERE path = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1`,
          ).get(resolved.relPath);
          if (!latest || latest.reservation_id !== reservation.reservation_id) problems.push('reservation-superseded');
        }
      }
      if (expectedHash !== snapshot.hash) problems.push('expected-hash-mismatch');

      if (problems.length) {
        noteReject(Number(reg.generation), reg.content_hash, {
          problems,
          reservationId: reservationId ?? null,
          expectedHash,
          actualHash: snapshot.hash,
        });
        return reject(new CandidateError(ERR.CAS_MISMATCH, 'CAS 前提不满足，拒绝写入（磁盘未改动）', {
          relPath: resolved.relPath,
          problems,
          reservationId: reservationId ?? null,
        }));
      }

      const bytes = Buffer.from(content, 'utf8');
      const newHash = sha256Hex(bytes);
      try {
        writeFileAtomic(resolved.absPath, bytes);
      } catch (error) {
        noteReject(Number(reg.generation), reg.content_hash, {
          problem: 'disk-placeholder',
          cause: String(error?.message ?? error),
        });
        return reject(new CandidateError(ERR.INTERNAL, '原子落盘失败：registry 未改动', {
          relPath: resolved.relPath,
          cause: String(error?.message ?? error),
        }));
      }
      // 落盘后立刻回读确认：如果这中间还有别的进程改名，宁可判 drift 也不把错的内容登记成已提交。
      let confirmed;
      try {
        confirmed = readFileSnapshot(resolved.absPath);
      } catch (error) {
        markDriftIn(runDb, {
          registryRow: reg,
          snapshot: null,
          atMs,
          reason: 'post-write-read-failed',
          writer: ident,
          kind: 'drift',
        });
        return reject(new CandidateError(ERR.MEMORY_DRIFT, '落盘后无法回读文件（registry 未提交）', {
          relPath: resolved.relPath,
          cause: String(error?.message ?? error),
        }));
      }
      if (confirmed.hash !== newHash) {
        markDriftIn(runDb, {
          registryRow: reg,
          snapshot: confirmed,
          atMs,
          reason: 'post-write-confirm-mismatch',
          writer: ident,
          kind: 'drift',
        });
        return reject(new CandidateError(ERR.MEMORY_DRIFT, '落盘后回读内容与预期不一致（疑似外部并发改写），registry 未提交', {
          relPath: resolved.relPath,
          expectedHash: newHash,
          actualHash: confirmed.hash,
        }));
      }

      const generation = Number(reg.generation) + 1;
      const hookInfo = Object.freeze({
        relPath: resolved.relPath,
        absPath: resolved.absPath,
        reservationId: reservation.reservation_id,
        writerIdentity: ident,
        previousHash: reg.content_hash,
        hash: newHash,
        previousGeneration: Number(reg.generation),
        generation,
        previousIdentity: reg.file_identity,
        identity: confirmed.identity,
        atMs,
      });
      // 故障注入点：此刻「文件已换、registry 未提交」。默认 no-op；测试里抛错或 SIGKILL。
      // 这里抛错会穿过 tx() 的 ROLLBACK —— 正好留下跨介质中间态，交给 reconcile() 判 drift。
      beforeRegistryCommit(hookInfo);

      runDb.prepare(
        `UPDATE memory_registry
            SET content_hash = ?, size = ?, file_identity = ?, generation = ?,
                writer_identity = ?, updated_at_ms = ?, reservation_id = ?
          WHERE path = ?`,
      ).run(newHash, confirmed.size, confirmed.identity, generation, ident, atMs, reservation.reservation_id, resolved.relPath);
      runDb.prepare("UPDATE memory_reservation SET state = 'committed' WHERE reservation_id = ?")
        .run(reservation.reservation_id);
      insertAudit(runDb, {
        atMs,
        relPath: resolved.relPath,
        kind: 'write',
        generation,
        contentHash: newHash,
        writer: ident,
        detail: {
          reservationId: reservation.reservation_id,
          previousHash: reg.content_hash,
          previousGeneration: Number(reg.generation),
          size: confirmed.size,
          fileIdentity: confirmed.identity,
        },
      });
      return {
        ok: true,
        value: {
          relPath: resolved.relPath,
          absPath: resolved.absPath,
          hash: newHash,
          size: confirmed.size,
          identity: confirmed.identity,
          generation,
          previousHash: reg.content_hash,
          previousGeneration: Number(reg.generation),
          trust: reg.trust,
          reservationId: reservation.reservation_id,
          writerIdentity: ident,
        },
      };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * 回滚。只有「仍是当前 generation 源头」的 reservation 才允许（旧 reservation 想撤销新写入 → 拒绝）。
   * 允许的回滚也不改写文件：数据库里没有正文 pre-image（权威正文只在文件里，DB 不做第二副本），
   * 所以做不到按字节恢复。诚实的做法是把这次写入撤回登记、把该条标 drift，交人工核对 ——
   * 绝不假装「已经恢复成旧版本」。
   */
  function rollback(reservationId) {
    requireString(reservationId, 'reservationId');
    const outcome = tx(db, (runDb) => {
      const atMs = time();
      const reject = (error) => ({ ok: false, error });
      const reservation = runDb.prepare('SELECT * FROM memory_reservation WHERE reservation_id = ?')
        .get(reservationId) ?? null;
      if (!reservation) {
        insertAudit(runDb, {
          atMs,
          relPath: '(unknown)',
          kind: 'rollback',
          writer: 'system:rollback',
          detail: { reservationId, rejected: true, reason: 'reservation-not-found' },
        });
        return reject(new CandidateError(ERR.RESERVATION_INVALID, 'reservation 不存在，拒绝回滚', { reservationId }));
      }
      const reg = runDb.prepare('SELECT * FROM memory_registry WHERE path = ?').get(reservation.path) ?? null;
      const latest = runDb.prepare(
        `SELECT * FROM memory_reservation
          WHERE path = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1`,
      ).get(reservation.path) ?? null;
      const problems = [];
      if (!reg) problems.push('registry-missing');
      if (reservation.state !== 'committed') problems.push(`reservation-state-${reservation.state}`);
      if (!latest || latest.reservation_id !== reservationId) problems.push('reservation-superseded');
      if (reg) {
        if (reg.reservation_id !== reservationId) problems.push('registry-reservation-mismatch');
        if (Number(reg.generation) !== Number(reservation.expected_generation) + 1) problems.push('generation-moved');
      }
      if (problems.length) {
        insertAudit(runDb, {
          atMs,
          relPath: reservation.path,
          kind: 'rollback',
          generation: reg ? Number(reg.generation) : null,
          contentHash: reg ? reg.content_hash : null,
          writer: 'system:rollback',
          detail: { reservationId, rejected: true, reason: 'stale-reservation', problems },
        });
        return reject(new CandidateError(ERR.RESERVATION_INVALID, '该 reservation 已不是当前 generation 的源头，拒绝回滚（新内容保持完好）', {
          reservationId,
          relPath: reservation.path,
          problems,
        }));
      }
      runDb.prepare("UPDATE memory_reservation SET state = 'rolled-back' WHERE reservation_id = ?").run(reservationId);
      runDb.prepare('UPDATE memory_registry SET trust = ? WHERE path = ?').run(TRUST.DRIFT, reservation.path);
      insertAudit(runDb, {
        atMs,
        relPath: reservation.path,
        kind: 'rollback',
        generation: Number(reg.generation),
        contentHash: reg.content_hash,
        writer: 'system:rollback',
        detail: {
          reservationId,
          rejected: false,
          restored: false,
          reason: 'no-preimage-stored',
          trust: TRUST.DRIFT,
        },
      });
      return {
        ok: true,
        value: {
          reservationId,
          relPath: reservation.path,
          rolledBack: true,
          restored: false,
          trust: TRUST.DRIFT,
          generation: Number(reg.generation),
        },
      };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * 启动/恢复用对账。逐条 fresh read 比对文件与 registry：
   * hash 或文件身份不符 / 文件消失 ⇒ 判 drift 并写审计；已经 drift 的条目不会自动恢复
   * （文件被换回来也可能是攻击者行为，恢复必须走人工确认）。
   * 整个扫描放在同一个写事务里，这样对账看到的是候选写入者不会插进来的稳定状态。
   */
  function reconcile() {
    return tx(db, (runDb) => {
      const atMs = time();
      const expired = runDb.prepare(
        "UPDATE memory_reservation SET state = 'expired' WHERE state = 'open' AND expires_at_ms <= ?",
      ).run(atMs);
      const rows = runDb.prepare('SELECT * FROM memory_registry ORDER BY path').all();
      const drifted = [];
      const ok = [];
      for (const reg of rows) {
        let resolved;
        try {
          resolved = resolveRel(reg.path);
        } catch (error) {
          drifted.push({ relPath: reg.path, reason: 'invalid-path', trust: TRUST.DRIFT, detail: String(error?.message ?? error) });
          continue;
        }
        let snapshot = null;
        try {
          snapshot = readFileSnapshot(resolved.absPath);
        } catch (error) {
          if (error?.code === ERR.NOT_FOUND) {
            const newlyMarked = markDriftIn(runDb, { registryRow: reg, snapshot: null, atMs, reason: 'file-missing', writer: 'system:reconcile', kind: 'drift' });
            drifted.push({ relPath: reg.path, reason: 'file-missing', trust: TRUST.DRIFT, hashSame: null, newlyMarked });
            continue;
          }
          throw error; // 快照不稳定 ⇒ 让调用方看到错误，不猜测
        }
        const verdict = compareRegistryToDisk(reg, snapshot);
        if (verdict.externalChange) {
          // newlyMarked 区分「这次对账才发现」和「之前就已经标了 drift」，审计只在转移时写一次。
          const newlyMarked = markDriftIn(runDb, {
            registryRow: reg,
            snapshot,
            atMs,
            reason: `external-change-${verdict.changeKind}`,
            writer: 'system:reconcile',
            kind: 'drift',
          });
          drifted.push({
            relPath: reg.path,
            reason: verdict.changeKind,
            trust: TRUST.DRIFT,
            hashSame: verdict.hashSame,
            identityChanged: verdict.identityChanged,
            newlyMarked,
          });
        } else if (reg.trust === TRUST.DRIFT) {
          drifted.push({ relPath: reg.path, reason: 'drift-flag-retained', trust: TRUST.DRIFT, hashSame: true, newlyMarked: false });
        } else {
          ok.push({
            relPath: reg.path,
            generation: Number(reg.generation),
            trust: reg.trust,
            hash: reg.content_hash,
          });
        }
      }
      // 只读诊断：目录里存在但未登记的 *.md —— 它们一律 untrusted，不注入。
      const registered = new Set(rows.map((row) => String(row.path)));
      const unregistered = [];
      const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), rel);
          } else if (entry.isFile() && entry.name.endsWith('.md') && !registered.has(rel)) {
            unregistered.push(rel);
          }
        }
      };
      walk(rootReal, '');
      unregistered.sort();
      return {
        drifted,
        ok,
        unregistered,
        expiredReservations: Number(expired?.changes ?? 0),
        atMs,
      };
    });
  }

  /** 隔离：把一条已登记记忆降级为 untrusted，并记录原因。 */
  function quarantine(relPath, reason = 'manual') {
    if (typeof reason !== 'string' || reason === '') {
      throw new CandidateError(ERR.INVALID_ARGUMENT, 'reason 必须是非空字符串', { field: 'reason' });
    }
    const resolved = resolveRel(relPath);
    return tx(db, (runDb) => {
      const atMs = time();
      const reg = runDb.prepare('SELECT * FROM memory_registry WHERE path = ?').get(resolved.relPath) ?? null;
      if (!reg) {
        throw new CandidateError(ERR.NOT_FOUND, '未登记的记忆无需 quarantine（它本来就是 untrusted）', {
          relPath: resolved.relPath,
        });
      }
      let snapshot = null;
      try {
        snapshot = readFileSnapshot(resolved.absPath);
      } catch (error) {
        if (error?.code !== ERR.NOT_FOUND) throw error;
      }
      runDb.prepare('UPDATE memory_registry SET trust = ? WHERE path = ?').run(TRUST.UNTRUSTED, resolved.relPath);
      insertAudit(runDb, {
        atMs,
        relPath: resolved.relPath,
        kind: 'quarantine',
        generation: Number(reg.generation),
        contentHash: reg.content_hash,
        writer: 'system:quarantine',
        detail: {
          reason,
          previousTrust: reg.trust,
          fileMissing: snapshot === null,
          hashSame: snapshot ? snapshot.hash === reg.content_hash : null,
        },
      });
      return {
        relPath: resolved.relPath,
        trust: TRUST.UNTRUSTED,
        previousTrust: reg.trust,
        reason,
        generation: Number(reg.generation),
      };
    });
  }

  /**
   * 注入候选。这里再做一次 fresh read（不信任 registry 里「上次还好」的状态）：
   * 文件在两次注入之间被改掉，必须当场判 drift 并从列表里消失。
   * 返回正文是因为注入本来就要正文；正文来自文件读取，不来自任何缓存。
   */
  function listForInjection() {
    const rows = stmt(
      'SELECT * FROM memory_registry WHERE trust IN (?, ?) ORDER BY path',
    ).all(TRUST.AUTHORITY, TRUST.TRUSTED);
    const out = [];
    for (const reg of rows) {
      let resolved;
      try {
        resolved = resolveRel(reg.path);
      } catch {
        continue;
      }
      let snapshot;
      try {
        snapshot = readFileSnapshot(resolved.absPath);
      } catch (error) {
        if (error?.code === ERR.NOT_FOUND) {
          tx(db, (runDb) => {
            markDriftIn(runDb, {
              registryRow: reg,
              snapshot: null,
              atMs: time(),
              reason: 'file-missing-at-injection',
              writer: 'system:injection',
              kind: 'drift',
            });
          });
          continue;
        }
        throw error;
      }
      const verdict = compareRegistryToDisk(reg, snapshot);
      if (verdict.externalChange) {
        tx(db, (runDb) => {
          markDriftIn(runDb, {
            registryRow: reg,
            snapshot,
            atMs: time(),
            reason: 'external-change-at-injection',
            writer: 'system:injection',
            kind: 'drift',
          });
        });
        continue;
      }
      out.push(injectionRow(reg, resolved, snapshot));
    }
    return out;
  }

  return {
    adopt,
    read,
    verify,
    reserve,
    write,
    rollback,
    reconcile,
    quarantine,
    listForInjection,
    // 只读诊断：调用方需要区分「配置的根目录」与「解析后的真实路径」时可查；不参与写入逻辑。
    get root() { return rootReal; },
  };
}
