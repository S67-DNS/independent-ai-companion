// 基于 PID 的单实例锁。
//
// 之前三个常驻脚本（看门狗/备份/NapCat 看门狗）各自都是「先读 PID，再判断，再写」：
// 两个进程同时启动时可以都读到"没有锁"，然后都写自己的 PID —— 结果两个实例同时跑。
// 这里改成 `wx` 原子创建；只有确认锁里的 PID 已经死了才清理旧锁。
//
// 仍然存在一个极窄的窗口：A 读到旧 PID 已死、准备删除时，B 刚好清掉旧锁并创建了新锁，
// A 可能把 B 的新锁删掉。删除前会再读一次 PID 并把「空内容/刚创建」视为初始化中，
// 足以覆盖实际启动场景；要彻底消除需要 OS 级文件锁，Node 核心不提供。
import fs from 'node:fs';
import path from 'node:path';

export function readLockPid(file) {
  try {
    const pid = Number(String(fs.readFileSync(file, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

export function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在，只是当前用户没有权限向它发信号。
    return error?.code === 'EPERM';
  }
}

/**
 * 尝试取得锁。
 * @returns {{ok: boolean, existing: number, initializing?: boolean}}
 *   `existing` 是占用者的 PID（内容损坏时为 0）。
 */
export function acquirePidLock(file, { pid = process.pid, initializingGraceMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.writeFileSync(file, `${pid}\n`, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, existing: 0 };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const existing = readLockPid(file);
    if (existing === pid) return { ok: true, existing };
    if (existing > 0 && isPidAlive(existing)) return { ok: false, existing };

    if (!existing) {
      // 锁文件存在但还没有 PID：可能是另一个进程刚用 wx 创建、正在写内容。
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch {}
      if (mtime && Date.now() - mtime < initializingGraceMs) {
        return { ok: false, existing: 0, initializing: true };
      }
    }

    // 删除前复核：别人可能已经换上了新锁。
    if (readLockPid(file) !== existing) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return { ok: false, existing };
    }
  }
  return { ok: false, existing: readLockPid(file) };
}

/** 只删除自己持有的锁，避免误删后来者的锁。 */
export function releasePidLock(file, pid = process.pid) {
  try {
    if (readLockPid(file) === pid) fs.rmSync(file, { force: true });
  } catch {}
}
