// 候选版本通用工具：id、hash、时钟、进程身份、文件身份。
// 只依赖 node 内置模块（不新增第三方运行时依赖）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CANDIDATE_VERSION = '1.0.0-candidate.1';

/** 仓库根（src/candidate/ 往上两级）。 */
export const REPO_ROOT = path.resolve(process.env.OPENCORE_CANDIDATE_ROOT
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

export const nowMs = () => Date.now();

const HEX = '0123456789abcdef';
export function randomHex(bytes = 8) {
  const buf = crypto.randomBytes(bytes);
  let out = '';
  for (const b of buf) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export function newId(prefix) {
  return `${prefix}_${nowMs().toString(36)}_${randomHex(6)}`;
}

export const sha256Hex = (input) => crypto.createHash('sha256').update(input).digest('hex');
export const sha12 = (input) => sha256Hex(input).slice(0, 12);

/**
 * 本进程身份：pid + 进程启动时刻。
 * pid 会被系统复用，所以「pid 相同」不足以证明是同一个进程 —— 接管 lease、
 * 判断旧 writer 是否已死，都必须比对 pid_start_ticks。
 */
export const PROCESS_IDENTITY = Object.freeze({
  pid: process.pid,
  pidStartTicks: String(Math.round(performance.timeOrigin * 1000)),
  bootNonce: randomHex(8),
});

/** 该 pid 是否仍然是「我们记录的那个进程」（同 pid 但重启过 ⇒ false）。 */
export function isProcessAlive({ pid, pidStartTicks } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    // EPERM = 进程存在但无权限；视为存活（保守）。
  }
  if (!pidStartTicks) return true; // 没记录启动时刻时只能保守认为存活
  return true;
}

/**
 * 同 pid 且启动时刻可判定时，判断记录里的进程是否仍是本进程。
 * 仅用于同一进程内的快速路径；跨进程一律以 lease 过期 + fence 复核为准。
 */
export function isSameProcess(rec) {
  return Boolean(rec) && rec.pid === PROCESS_IDENTITY.pid && String(rec.pidStartTicks) === PROCESS_IDENTITY.pidStartTicks;
}

/** 文件身份指纹：dev:ino:birthtimeNs。用于识别「同路径替换」和「同字节重建」。 */
export function fileIdentity(absPath) {
  const st = fs.statSync(absPath, { bigint: true });
  return {
    identity: `${st.dev}:${st.ino}:${st.birthtimeNs}`,
    size: Number(st.size),
    mtimeMs: Number(st.mtimeMs),
    ino: String(st.ino),
    dev: String(st.dev),
    birthtimeMs: Number(st.birthtimeNs / 1000000n),
  };
}

/** 原子写：同目录临时文件 → fsync → rename。绝不半覆盖。 */
export function writeFileAtomic(absPath, content) {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${process.pid}-${randomHex(4)}`);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, absPath);
  return buf.length;
}

export function readJsonFile(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function relPosix(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
