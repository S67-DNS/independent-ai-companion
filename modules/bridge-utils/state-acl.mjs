// state/ 目录 ACL 收紧的**唯一实现**。
//
// 为什么单独成模块：这套逻辑原本在桥接进程（`src/bridge.js` 的 hardenStateDirAcl）和
// 安装脚本（`scripts/harden-state-acl.mjs`）里各写了一份，两份带着**同一个** bug：
//
//   icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /grant:r ... /T /C
//
// `(OI)(CI)` 是**目录专用**的继承标志。icacls 把它套到 `/T` 展开出来的**文件**上会失败，
// 而同一句里的 `/inheritance:r` 已经把文件原有的继承 ACE 摘掉了 —— 净结果是**子文件
// DACL 被清空，连属主自己都读不了**。实测后果：state/ 下 50 个子文件变成空 DACL，
// 桥接读不到自己的控制台令牌（"Access to the path ... is denied"），而启动日志只报
// 「未能收紧权限」，完全看不出已经造成了破坏。
//
// 第二个 bug 让第一个 bug 反复发生：回读自检用 `/\(I\)/.test(整段输出)` 判断「继承链是否
// 断干净」。但 DSH 的 ACL 沙箱会把工作区（含 state/）标记为 Low 完整性，而
// `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)` 这一行**永远**带 (I) ——
// 于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
//
// 安全顺序（任何一步失败都不能让目标失去访问权）：
//   1. 先对根和整棵子树补显式授权（此时继承链和宽松 ACE 都还在）；
//   2. 再按 SID 删除宽松主体；
//   3. 给根补一份可继承 ACE；
//   4. 最后才 `/inheritance:r`；
//   5. 自检：根没有继承/宽松 ACE，且整棵树当前用户都能读。
// 早期实现把「断继承」放在最前面；在 Low 完整性目录上后续授权被拒时，目录已经只剩
// 一个 Mandatory Label、任何普通进程都读不了，而 isHardened 只看 ACE 不看实际访问，
// 还会把这种状态误报成「已收紧」。现在授权先行，失败最多是「没收紧」，不会是「打不开」。
//
// 另一个必须防的坑：`icacls /T` **会跟随 junction/symlink**，把 ACL 改到链接目标
// （即 state/ 之外）。所以递归前先用 Node 扫一遍，发现任何 reparse point 就拒绝自动收紧，
// 不做任何修改；宁可明确报失败，也不能悄悄改到别的目录。
//
// 合并成一份实现，从结构上杜绝两份逻辑再次漂移。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Authenticated Users=S-1-5-11, BUILTIN\Users=S-1-5-32-545, Everyone=S-1-1-0
const PERMISSIVE_SIDS = ['*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0'];

/**
 * icacls 走管道时按 Windows OEM 代码页输出（简中系统是 GBK），按 UTF-8 解码会把
 * “拒绝访问”变成乱码，后续的错误检测就会漏掉。这里先按 GBK 解码，出现替换符再试 UTF-8。
 */
function decodeConsoleOutput(buffer) {
  if (!buffer) return '';
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  if (!bytes.length) return '';
  if (process.platform !== 'win32') return bytes.toString('utf8');
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch {}
  return bytes.toString('utf8');
}

/** icacls 的可执行封装（统一超时与隐藏窗口）。 */
export function icacls(args, timeout = 30000) {
  const res = spawnSync('icacls', args, { encoding: 'buffer', timeout, windowsHide: true });
  res.stdout = decodeConsoleOutput(res.stdout);
  res.stderr = decodeConsoleOutput(res.stderr);
  return res;
}

/** icacls 是否报告了权限不足（输出随系统语言变化，不能只匹配英文）。 */
export function looksLikeAccessDenied(output) {
  return /access is denied|拒绝访问/i.test(String(output ?? ''));
}

/**
 * icacls 输出里是否还有**继承来的权限** ACE。
 *
 * 必须排除 Mandatory Label 行：那不是权限，而且 DSH 沙箱打过 Low 标签后它永远带 (I)。
 * 用全文 `/\(I\)/` 扫描会把「已收紧」判成「未收紧」，进而让调用方反复重跑破坏性命令。
 */
export function hasInheritedPermissionAce(icaclsOutput) {
  return String(icaclsOutput ?? '')
    .split(/\r?\n/)
    .filter((line) => !/Mandatory Label/i.test(line))
    .some((line) => /\(I\)/.test(line));
}

/** 是否还有本机任意用户可读的宽松主体授权。 */
export function hasPermissiveTrustee(icaclsOutput) {
  return /Authenticated Users|BUILTIN\\Users|\bEveryone\b/i.test(String(icaclsOutput ?? ''));
}

function aclLooksHardened(icaclsOutput) {
  return !hasInheritedPermissionAce(icaclsOutput) && !hasPermissiveTrustee(icaclsOutput);
}

function errorSnippet(output) {
  return String(output ?? '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 600);
}

function stepFailure(stage, res) {
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error) return { ok: false, detail: `${stage}：${res.error.message}` };
  if (res.status !== 0) return { ok: false, detail: `${stage}（退出码 ${res.status}）：${errorSnippet(out)}` };
  if (looksLikeAccessDenied(out)) return { ok: false, detail: `${stage}：${errorSnippet(out)}` };
  return null;
}

/**
 * 只用 Node 枚举，不跟随 reparse point；发现链接或读不了的目录就返回原因。
 * @returns {string} 空字符串表示整棵树可安全交给 `icacls /T`。
 */
function firstLinkOrUnreadable(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { return `无法读取 ${dir}（${error?.message ?? error}），拒绝递归修改 ACL`; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      return `发现链接/reparse point：${full}。icacls /T 会跟随链接改到外部目标，已拒绝自动收紧`;
    }
    if (entry.isDirectory()) {
      const nested = firstLinkOrUnreadable(full);
      if (nested) return nested;
    }
  }
  return '';
}

/** 当前用户是否真的能读目录/文件（不只看 DACL 里有没有 ACE）。 */
function canAccessTree(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return false; }
  if (stat.isSymbolicLink()) return true;
  if (stat.isDirectory()) {
    let names;
    try { names = fs.readdirSync(target); } catch { return false; }
    for (const name of names) {
      if (!canAccessTree(path.join(target, name))) return false;
    }
    return true;
  }
  if (!stat.isFile()) return true;
  let fd = -1;
  try { fd = fs.openSync(target, 'r'); return true; }
  catch { return false; }
  finally { if (fd >= 0) { try { fs.closeSync(fd); } catch {} } }
}

/**
 * 目标路径的权限是否已收紧：根上没有继承/宽松 ACE，且当前用户对整棵树有读访问。
 * 只查 ACE 不查实际访问会漏掉「DACL 被清空、属主也读不了」的破坏态。
 * @param {string} target - 目录或文件路径。
 */
export function isHardened(target) {
  if (process.platform !== 'win32') {
    try { return (fs.statSync(target).mode & 0o077) === 0; } catch { return false; }
  }
  let stat;
  try { stat = fs.lstatSync(target); } catch { return false; }
  if (stat.isSymbolicLink()) return false;
  const res = icacls([target], 10000);
  if (res.error || res.status !== 0) return false;
  if (!aclLooksHardened(res.stdout ?? '')) return false;
  return canAccessTree(target);
}

/**
 * 收紧一个**目录**及其整棵子树的权限。
 * @param {string} dir - 目标目录。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenDir(dir) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); return { ok: true, detail: 'chmod 700' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = process.env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  let stat;
  try { stat = fs.lstatSync(dir); }
  catch (error) { return { ok: false, detail: `无法读取目标：${error?.message ?? error}` }; }
  if (stat.isSymbolicLink()) return { ok: false, detail: '目标本身是链接/reparse point，拒绝修改其外部目标的 ACL' };
  if (!stat.isDirectory()) return { ok: false, detail: '目标不是目录' };
  const unsafe = firstLinkOrUnreadable(dir);
  if (unsafe) return { ok: false, detail: unsafe };

  const steps = [
    // 1. 授权先行：此时继承链和宽松 ACE 都还在，失败也不会丢失访问。
    [dir, '/T', '/C', '/Q', '/grant', `${user}:F`, '/grant', 'SYSTEM:F', '/grant', 'Administrators:F'],
    // 2. 按 SID 删除宽松主体（对文件和目录同样有效，不带目录专用的 (OI)(CI)）。
    [dir, '/remove:g', ...PERMISSIVE_SIDS, '/T', '/C', '/Q'],
    // 3. 先补根上的可继承 ACE，再断继承；这样断继承失败也不会影响以后新建的文件。
    [dir, '/Q', '/C', '/grant:r', `${user}:(OI)(CI)F`,
      '/grant:r', 'SYSTEM:(OI)(CI)F', '/grant:r', 'Administrators:(OI)(CI)F'],
    // 4. 最后断继承：显式 ACE 已在每个条目上，不会重演「清空 DACL」。
    [dir, '/inheritance:r', '/C', '/Q']
  ];
  const stages = ['补显式授权', '删除宽松主体', '补可继承 ACE', '切断继承'];
  for (let i = 0; i < steps.length; i += 1) {
    const failure = stepFailure(stages[i], icacls(steps[i]));
    if (failure) return failure;
  }

  const verify = icacls([dir], 10000);
  const verifyFailure = stepFailure('收紧后回读', verify);
  if (verifyFailure) return verifyFailure;
  if (!aclLooksHardened(verify.stdout ?? '')) {
    return { ok: false, detail: '收紧后根目录仍存在继承或宽松 ACE（可能被组策略重新下发）' };
  }
  if (!canAccessTree(dir)) {
    return { ok: false, detail: '收紧后目录或子文件已不可读，请检查 ACL（可能被显式拒绝 ACE 覆盖）' };
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 收紧一个**文件**的权限（凭据文件用；文件不能带 (OI)(CI)）。
 * @param {string} file - 目标文件。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenFile(file) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return { ok: true, detail: 'chmod 600' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = process.env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { return { ok: false, detail: `无法读取目标：${error?.message ?? error}` }; }
  if (stat.isSymbolicLink()) return { ok: false, detail: '目标本身是链接/reparse point，拒绝修改其外部目标的 ACL' };
  if (!stat.isFile()) return { ok: false, detail: '目标不是普通文件' };

  const steps = [
    [file, '/C', '/Q', '/grant', `${user}:F`, '/grant', 'SYSTEM:F', '/grant', 'Administrators:F'],
    [file, '/remove:g', ...PERMISSIVE_SIDS, '/C', '/Q'],
    [file, '/inheritance:r', '/C', '/Q']
  ];
  const stages = ['补显式授权', '删除宽松主体', '切断继承'];
  for (let i = 0; i < steps.length; i += 1) {
    const failure = stepFailure(stages[i], icacls(steps[i]));
    if (failure) return failure;
  }

  const verify = icacls([file], 10000);
  const verifyFailure = stepFailure('收紧后回读', verify);
  if (verifyFailure) return verifyFailure;
  if (!aclLooksHardened(verify.stdout ?? '')) {
    return { ok: false, detail: '收紧后文件仍存在继承或宽松 ACE（可能被组策略重新下发）' };
  }
  if (!canAccessTree(file)) {
    return { ok: false, detail: '收紧后文件不可读，请检查 ACL（可能被显式拒绝 ACE 覆盖）' };
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 给人看的手动收紧命令（失败降级时打印）。
 *
 * 必须保持「先授权、再删宽松主体、再加可继承 ACE、最后断继承」的顺序：
 * 把 /inheritance:r 放前面，一旦后续命令失败，目录就会变成谁也读不了的死目录。
 * ⚠️ icacls /T 会跟随 junction/symlink；若目标里有链接，先移除链接或逐个手工处理。
 */
export function manualDirCommand(dir) {
  if (process.platform !== 'win32') return `chmod -R go-rwx "${dir}"`;
  const d = `"${dir}"`;
  return [
    'rem 注意：icacls /T 会跟随 junction/symlink，执行前先移除目标内的链接',
    `icacls ${d} /T /C /Q /grant "%USERNAME%:F" /grant "SYSTEM:F" /grant "Administrators:F"`,
    `icacls ${d} /remove:g "*S-1-5-11" "*S-1-5-32-545" "*S-1-1-0" /T /C /Q`,
    `icacls ${d} /Q /C /grant:r "%USERNAME%:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F"`,
    `icacls ${d} /inheritance:r /C /Q`
  ].join('\n             ');
}
