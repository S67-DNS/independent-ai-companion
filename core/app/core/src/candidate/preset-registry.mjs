// Preset Registry：把「preset 目录内容」变成可校验的内容身份，并落到 preset_registry / session_binding。
//
// 为什么需要它（GLM-DSH-READONLY-AUDIT-001 F1/F2/F4）：
//   - DSH 里 preset **只在空会话可切换**；已开轮次会被 `agent-preset/locked` 拒绝，所以
//     「换一个 preset 重建会话」不能作为常规修复手段。
//   - 未知 preset 会抛 `not-found`，**不会**静默回退 `standard`；只有「省略 preset」才落默认值。
//     PROJECT_NAME若在解析层把未知 ID 静默映射成 standard，等于给聊天面开放全量本地工具面（fail-open）。
//   - **preset ID 连续 ≠ 内容连续**：每次 create/resume 都按「当前定义」重新解析并挂载。
//     同一个 ID 的 preset.yml / agent.cordis.yml 被改一个字节，旧 Session 的实际组合就变了，
//     且没有任何报错。所以 registry 记录的是**内容指纹**，不是 ID。
//
// 指纹定义（契约 §D）：
//   对 preset 目录内所有文件按相对路径（posix 分隔符）排序，
//   每一项取 `relPath + '\0' + sha256(fileContent)`，项间用 '\n' 连接，再整体 sha256。
//   改一个字节 ⇒ 该文件 sha256 变 ⇒ 整体指纹变。
//
// 边界：
//   - 只读 preset 目录，不写、不改、不安装 preset；
//   - 不启动 DSH、不调用 agentPresets.*；
//   - 所有 DB 写都走 `tx()`（BEGIN IMMEDIATE），不裸开事务。

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { CandidateError, ERR } from './errors.mjs';
import { sha256Hex } from './util.mjs';
import { tx } from './db.mjs';

const PRESET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_DEPTH = 32;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function requirePresetId(presetId) {
  if (typeof presetId !== 'string' || !PRESET_ID_RE.test(presetId)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `presetId 非法：${String(presetId)}`, { presetId });
  }
  return presetId;
}

function requireOptionalText(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是字符串或 null`);
  }
  return value;
}

function requireFingerprint(fingerprint, field = 'presetFingerprint') {
  if (typeof fingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(fingerprint)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是 64 位 hex 字符串`, { fingerprint });
  }
  return fingerprint.toLowerCase();
}

function requireEventChainHead(value, field = 'eventChainHead') {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `${field} 必须是非负安全整数或 null`);
  }
  return value;
}

/**
 * 把一条 session_binding 记录写进库（独立函数，便于集成层直接调用）。
 *
 * 语义：绑定记录的是「这个 Session 是在哪个 preset 内容下建立的」。
 * 同 session 重新绑定（preset 或指纹变化）会更新记录并返回 previous，调用方必须审计——
 * 它正是「preset ID 连续 ≠ 内容连续」的持久化证据。
 *
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.db
 * @param {string} args.sessionId
 * @param {string} args.presetId
 * @param {string} args.fingerprint 64 位 hex 内容指纹
 * @param {string|null} [args.owner]
 * @param {string|null} [args.workspace]
 * @param {string|null} [args.cwd]
 * @param {string|null} [args.role]
 * @param {number|null} [args.eventChainHead]
 * @param {'candidate'|'c0-readonly'} [args.origin]
 * @param {() => number} [args.now]
 */
export function bindSession({
  db,
  sessionId,
  presetId,
  fingerprint,
  owner = null,
  workspace = null,
  cwd = null,
  role = null,
  eventChainHead = null,
  origin = 'candidate',
  now = Date.now,
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'bindSession 需要有效的 db');
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'sessionId 必须是非空字符串');
  }
  const preset = requirePresetId(presetId);
  const fp = requireFingerprint(fingerprint);
  const ownerText = requireOptionalText(owner, 'owner');
  const workspaceText = requireOptionalText(workspace, 'workspace');
  const cwdText = requireOptionalText(cwd, 'cwd');
  const roleText = requireOptionalText(role, 'role');
  const head = requireEventChainHead(eventChainHead);
  if (origin !== 'candidate' && origin !== 'c0-readonly') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, `origin 只允许 candidate / c0-readonly，收到 ${String(origin)}`);
  }
  if (typeof now !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'now 必须是函数');
  }
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'now() 必须返回非负安全整数毫秒');
  }

  let previousRow = null;
  tx(db, () => {
    // 事务内 fresh read：并发重绑时 changed/previous 必须基于写锁拿到的最新值，
    // 否则两个进程会互相覆盖却都报告「没有变化」。
    previousRow = db.prepare('SELECT * FROM session_binding WHERE session_id = ?').get(sessionId) ?? null;
    db.prepare(`
      INSERT INTO session_binding(
        session_id, preset_id, preset_fingerprint, owner, workspace, cwd, role,
        event_chain_head, origin, created_at_ms, updated_at_ms, state
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active')
      ON CONFLICT(session_id) DO UPDATE SET
        preset_id = excluded.preset_id,
        preset_fingerprint = excluded.preset_fingerprint,
        owner = excluded.owner,
        workspace = excluded.workspace,
        cwd = excluded.cwd,
        role = excluded.role,
        event_chain_head = excluded.event_chain_head,
        origin = excluded.origin,
        updated_at_ms = excluded.updated_at_ms,
        state = 'active'
    `).run(sessionId, preset, fp, ownerText, workspaceText, cwdText, roleText, head, origin, at, at);
  });

  const previous = previousRow
    ? {
      presetId: String(previousRow.preset_id),
      presetFingerprint: String(previousRow.preset_fingerprint),
      eventChainHead: previousRow.event_chain_head === null ? null : Number(previousRow.event_chain_head),
      state: String(previousRow.state),
    }
    : null;
  const changed = previous !== null && (
    previous.presetId !== preset
    || previous.presetFingerprint !== fp
    || previous.eventChainHead !== head
    || previous.state !== 'active'
  );

  return Object.freeze({
    sessionId,
    bound: true,
    firstBind: previous === null,
    changed,
    presetId: preset,
    fingerprint: fp,
    eventChainHead: head,
    atMs: at,
    previous,
  });
}

/**
 * 创建一个 preset registry。
 *
 * @param {object} opts
 * @param {string} opts.presetsDir preset 根目录（每个子目录一个 preset）
 * @param {import('node:sqlite').DatabaseSync|null} [opts.db] record/verifyPreset/bindSession 需要
 * @param {() => number} [opts.now]
 */
export function createPresetRegistry({ presetsDir, db = null, now = Date.now } = {}) {
  if (typeof presetsDir !== 'string' || presetsDir.trim() === '') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'presetsDir 必须是非空字符串');
  }
  if (typeof now !== 'function') {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'now 必须是函数');
  }
  const root = path.resolve(presetsDir);

  const requireDb = () => {
    if (!db || typeof db.prepare !== 'function') {
      throw new CandidateError(ERR.CAPABILITY_UNAVAILABLE, 'preset registry 未绑定 db，无法读写 preset_registry');
    }
    return db;
  };

  const resolveDir = (presetId) => {
    const id = requirePresetId(presetId);
    const dir = path.join(root, id);
    const rel = path.relative(root, dir);
    // 二次防线：即使 PRESET_ID_RE 被放宽，也不允许路径逃出 presetsDir。
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new CandidateError(ERR.INVALID_ARGUMENT, `presetId 越出 presetsDir：${presetId}`, { presetId });
    }
    return { id, dir };
  };

  const statOrNull = (absPath) => {
    try { return fs.statSync(absPath); } catch { return null; }
  };

  const scan = () => {
    const st = statOrNull(root);
    if (!st || !st.isDirectory()) {
      throw new CandidateError(ERR.NOT_FOUND, `presetsDir 不存在或不是目录：${root}`, { presetsDir: root });
    }
    const out = [];
    const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(root, entry.name);
      const dirStat = statOrNull(dir); // 跟随 symlink/junction
      if (!dirStat || !dirStat.isDirectory()) continue;
      if (!statOrNull(path.join(dir, 'preset.yml'))) continue; // 没有 preset.yml 的目录不是 preset
      requirePresetId(entry.name); // 目录名就是 preset ID；非法就显式失败，不静默跳过
      out.push({ presetId: entry.name, dir });
    }
    return out;
  };

  /**
   * 递归列出 preset 目录内的所有普通文件（跟随 symlink/junction，做环路检测）。
   * @returns {Array<{relPath:string, absPath:string, bytes:number}>}
   */
  const listFiles = (dir) => {
    const files = [];
    const visitedDirs = new Set();
    const walk = (absDir, relDir, depth) => {
      if (depth > MAX_DEPTH) {
        throw new CandidateError(ERR.CONTRACT, `preset 目录层级超过 ${MAX_DEPTH}（疑似符号链接环路）`, { dir });
      }
      const real = fs.realpathSync(absDir);
      if (visitedDirs.has(real)) {
        throw new CandidateError(ERR.CONTRACT, 'preset 目录存在符号链接环路，无法界定内容边界', { dir, real });
      }
      visitedDirs.add(real);
      const names = fs.readdirSync(absDir).sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const abs = path.join(absDir, name);
        const rel = relDir === '' ? name : `${relDir}/${name}`;
        const st = fs.statSync(abs); // follows symlink
        if (st.isDirectory()) {
          walk(abs, rel, depth + 1);
        } else if (st.isFile()) {
          files.push({ relPath: rel, absPath: abs, bytes: Number(st.size) });
        } else {
          throw new CandidateError(ERR.CONTRACT, `preset 目录里出现非普通文件：${rel}`, { presetId: path.basename(dir), relPath: rel });
        }
      }
      visitedDirs.delete(real);
    };
    walk(dir, '', 0);
    files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return files;
  };

  const computeFingerprint = (files) => {
    const lines = files.map((file) => `${file.relPath}\u0000${sha256Hex(fs.readFileSync(file.absPath))}`);
    return sha256Hex(lines.join('\n'));
  };

  const assertPresetDir = (id, dir) => {
    const st = statOrNull(dir);
    if (!st || !st.isDirectory()) {
      throw new CandidateError(ERR.NOT_FOUND, `preset 不存在：${id}`, { presetId: id, dir });
    }
  };

  const registry = {
    presetsDir: root,

    /** @returns {string[]} 升序 preset ID 列表（只包含含 preset.yml 的目录） */
    listPresets() {
      return scan().map((item) => item.presetId);
    },

    /** 目录内容明细（诊断/审计用）。 */
    inspect(presetId) {
      const { id, dir } = resolveDir(presetId);
      assertPresetDir(id, dir);
      const listed = listFiles(dir);
      const files = listed.map((file) => ({
        relPath: file.relPath,
        bytes: file.bytes,
        sha256: sha256Hex(fs.readFileSync(file.absPath)),
      }));
      return Object.freeze({
        presetId: id,
        dir,
        fingerprint: computeFingerprint(listed),
        files,
      });
    },

    /** 内容指纹（契约定义见文件头）。 */
    fingerprint(presetId) {
      const { id, dir } = resolveDir(presetId);
      assertPresetDir(id, dir);
      return computeFingerprint(listFiles(dir));
    },

    /**
     * 解析一个 preset。
     * strict=true 时未知 preset 抛 ERR.NOT_FOUND（**fail closed，绝不回退 standard**）；
     * strict=false 时返回 null（仅供「先探测再决定」的显式调用方）。
     */
    resolve(presetId, { strict = true } = {}) {
      const { id, dir } = resolveDir(presetId);
      const dirStat = statOrNull(dir);
      if (!dirStat || !dirStat.isDirectory()) {
        if (strict === true) throw new CandidateError(ERR.NOT_FOUND, `preset 不存在：${id}`, { presetId: id, dir });
        return null;
      }
      const presetYml = path.join(dir, 'preset.yml');
      const agentCordisYml = path.join(dir, 'agent.cordis.yml');
      if (!statOrNull(presetYml)) {
        if (strict === true) throw new CandidateError(ERR.NOT_FOUND, `preset 不存在（缺少 preset.yml）：${id}`, { presetId: id, dir });
        return null;
      }
      if (!statOrNull(agentCordisYml)) {
        throw new CandidateError(ERR.CONTRACT, `preset "${id}" 不完整：缺少 agent.cordis.yml`, { presetId: id, dir });
      }
      let manifest;
      try {
        manifest = yaml.load(stripBom(fs.readFileSync(presetYml, 'utf8')));
      } catch (error) {
        throw new CandidateError(ERR.CONTRACT, `preset "${id}" 的 preset.yml 不是合法 YAML`, {
          presetId: id,
          cause: String(error?.message ?? error),
        });
      }
      if (!isPlainObject(manifest)) {
        throw new CandidateError(ERR.CONTRACT, `preset "${id}" 的 preset.yml 必须是映射（mapping）`, { presetId: id });
      }
      return Object.freeze({
        presetId: id,
        dir,
        presetYml,
        agentCordisYml,
        manifest,
        fingerprint: registry.fingerprint(id),
      });
    },

    /**
     * 落 preset_registry。返回 {fingerprint, previousFingerprint, changed, firstRecord, ...}。
     * changed=true 表示「同 ID 内容变了」——调用方必须把它当审计事件，而不是无声覆盖。
     */
    record(presetId) {
      const handle = requireDb();
      const resolved = registry.resolve(presetId, { strict: true });
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'now() 必须返回非负安全整数毫秒');
      }
      let latest = null;
      tx(handle, () => {
        // 写锁内 fresh read：并发 record 时以最后提交者看到的值为准，previous 才是真历史。
        latest = handle.prepare('SELECT fingerprint FROM preset_registry WHERE preset_id = ?').get(resolved.presetId) ?? null;
        handle.prepare(`
          INSERT INTO preset_registry(preset_id, fingerprint, source_path, resolved_at_ms, valid)
          VALUES (?,?,?,?,1)
          ON CONFLICT(preset_id) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            source_path = excluded.source_path,
            resolved_at_ms = excluded.resolved_at_ms,
            valid = 1
        `).run(resolved.presetId, resolved.fingerprint, resolved.dir, at);
      });
      return Object.freeze({
        presetId: resolved.presetId,
        fingerprint: resolved.fingerprint,
        sourcePath: resolved.dir,
        resolvedAtMs: at,
        previousFingerprint: latest ? String(latest.fingerprint) : null,
        changed: latest ? String(latest.fingerprint) !== resolved.fingerprint : false,
        firstRecord: latest === null,
      });
    },

    /**
     * 比对「登记时的指纹」与「当前内容指纹」。
     * 这是「preset ID 连续 ≠ 内容连续」的检测点：ID 一样、指纹变了 ⇒ changed=true。
     */
    verifyPreset(presetId) {
      const handle = requireDb();
      const id = requirePresetId(presetId);
      const row = handle.prepare('SELECT * FROM preset_registry WHERE preset_id = ?').get(id) ?? null;
      if (!row) {
        throw new CandidateError(ERR.NOT_FOUND, `preset "${id}" 尚未登记（先 record 再 verify）`, { presetId: id });
      }
      const current = registry.fingerprint(id);
      return Object.freeze({
        presetId: id,
        recordedFingerprint: String(row.fingerprint),
        currentFingerprint: current,
        changed: String(row.fingerprint) !== current,
        sourcePath: row.source_path === null || row.source_path === undefined ? null : String(row.source_path),
        resolvedAtMs: Number(row.resolved_at_ms),
      });
    },

    /** bindSession 的方法封装：未显式传 fingerprint 时按当前内容计算。 */
    bindSession(args = {}) {
      const handle = requireDb();
      const presetId = requirePresetId(args.presetId);
      const fingerprint = args.fingerprint === undefined || args.fingerprint === null
        ? registry.fingerprint(presetId)
        : requireFingerprint(args.fingerprint);
      return bindSession({ ...args, db: handle, presetId, fingerprint, now });
    },
  };

  return registry;
}
