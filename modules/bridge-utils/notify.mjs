// 主动故障通知：Windows 桌面 toast + 有界审计日志。
//
// 设计边界：
//   · 先写状态、再弹 toast。状态写在 state/alert-state.json，跨进程用 PID 锁串行化，
//     同一 key 在冷却期内只弹一次；恢复时（resolveAlert）只对仍然 active 的告警弹一次
//     「已恢复」，所以看门狗/启动器同时跑也不会互相刷屏。
//   · 通知失败绝不能影响看门狗/启动器本身：所有异常都吞掉并落到 logger。
//   · 正文先脱敏再落盘/上屏；alerts.log 只保留最近 200 行。
//   · toast 参数走 base64，命令行本身保持纯 ASCII：中文标题不会因代码页变成乱码。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquirePidLock, releasePidLock } from './pid-lock.mjs';

export const ALERT_STATE_VERSION = 1;
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_MAX_BODY = 600;
export const DEFAULT_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const MAX_ALERT_ENTRIES = 64;
const INACTIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_LOG_LINES = 400;
const KEEP_LOG_LINES = 200;
const LOCK_TIMEOUT_MS = 3000;
const LOCK_INITIALIZING_GRACE_MS = 200;

export function alertPaths(root = process.cwd()) {
  const dir = path.join(root, 'state');
  return {
    dir,
    state: path.join(dir, 'alert-state.json'),
    log: path.join(dir, 'alerts.log'),
    lock: path.join(dir, 'alert-state.lock')
  };
}

/** 读取告警状态；损坏/缺失都回退成空状态（不能让通知把调用方拖垮）。 */
export function readAlertState(root = process.cwd()) {
  try {
    let text = fs.readFileSync(alertPaths(root).state, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = JSON.parse(text);
    const alerts = data && typeof data === 'object' && data.alerts
      && typeof data.alerts === 'object' && !Array.isArray(data.alerts)
      ? data.alerts
      : {};
    return {
      version: ALERT_STATE_VERSION,
      updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : null,
      alerts
    };
  } catch {
    return { version: ALERT_STATE_VERSION, updatedAt: null, alerts: {} };
  }
}

function writeAlertState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function entryTime(entry) {
  const parsed = Date.parse(String(entry?.lastAt ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pruneAlerts(alerts, now) {
  const entries = Object.entries(alerts).filter(([, value]) => value && typeof value === 'object');
  const kept = entries.filter(([, value]) => value.active === true || now - entryTime(value) < INACTIVE_TTL_MS);
  kept.sort((a, b) => entryTime(b[1]) - entryTime(a[1]));
  return Object.fromEntries(kept.slice(0, MAX_ALERT_ENTRIES));
}

/**
 * 脱敏并压成单行。告警会进日志、可能被复制给别人，令牌/密码不应该跟着走。
 */
export function sanitizeAlertText(value, { maxLength = DEFAULT_MAX_BODY } = {}) {
  let text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
  text = text
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***')
    .replace(/\bBearer\s+[^\s,;，；]+/gi, 'Bearer ***')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic ***')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|token|password|passwd|secret|api[_-]?key|cookie|密码|口令|令牌)\s*[=:：]\s*)[^\s,;，；]+/gi,
      '$1***'
    )
    .replace(
      /(authorization\s*[=:：]\s*)(?!Bearer\s+\*\*\*|Basic\s+\*\*\*)[^\s,;，；]+/gi,
      '$1***'
    )
    .replace(/\n+/g, ' ')
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  return text;
}

function appendAlertLog(root, { at, source, level, key, title, body, kind }) {
  const line = [
    `[${new Date(at).toLocaleString('zh-CN')}]`,
    `[${source || 'notify'}]`,
    `[${level || 'error'}]`,
    `[${kind}]`,
    key,
    title,
    body
  ].filter(Boolean).join(' | ');
  try {
    const file = alertPaths(root).log;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.length > MAX_LOG_LINES) {
      fs.writeFileSync(file, `${lines.slice(-KEEP_LOG_LINES).join('\n')}\n`, 'utf8');
    }
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireAlertLock(lockFile, timeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = acquirePidLock(lockFile, { initializingGraceMs: LOCK_INITIALIZING_GRACE_MS });
    if (lock.ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25 + Math.floor(Math.random() * 40));
  }
}

// 同一进程内的并发（例如测试或启动器同时打多个告警）不能依赖 PID 锁：
// acquirePidLock 对「锁里的 PID 就是自己」会直接放行，必须再加一层进程内队列。
let stateQueue = Promise.resolve();

function serialize(task) {
  const run = stateQueue.then(task, task);
  stateQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function withStateLock(root, task) {
  return serialize(async () => {
    const paths = alertPaths(root);
    fs.mkdirSync(paths.dir, { recursive: true });
    const got = await acquireAlertLock(paths.lock);
    if (!got) return { busy: true };
    try {
      return await task(paths);
    } finally {
      releasePidLock(paths.lock);
    }
  });
}

function defaultPowershell() {
  const base = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidate = path.join(base, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * 弹一条 Windows toast。参数全部 base64，不把中文/换行塞进命令行。
 * @returns {{ok: boolean, pid?: number|null, error?: string}}
 */
export function showToast({
  root = process.cwd(),
  title = 'QQ 链路告警',
  body = '',
  appId = DEFAULT_APP_ID,
  script = '',
  powershell = defaultPowershell(),
  spawnImpl = spawn,
  logger = console.log
} = {}) {
  if (process.platform !== 'win32') return { ok: false, error: '桌面通知仅支持 Windows' };
  const toastScript = script || path.join(root, 'scripts', 'toast.ps1');
  if (!fs.existsSync(toastScript)) return { ok: false, error: `找不到 ${toastScript}` };
  const encode = (value) => Buffer.from(String(value ?? ''), 'utf8').toString('base64');
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', toastScript,
    '-TitleBase64', encode(title),
    '-BodyBase64', encode(body),
    '-AppIdBase64', encode(appId)
  ];
  try {
    const child = spawnImpl(powershell, args, { windowsHide: true, stdio: 'ignore', detached: true });
    child.on?.('error', (error) => logger(`[notify] toast 进程启动失败：${error?.message ?? error}`));
    child.unref?.();
    return { ok: true, pid: child.pid ?? null };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 发送（或冷却期内抑制）一条告警。
 *
 * 冷却只作用于**仍在持续**的同一条告警：已经 resolve 的 key 再次故障会立刻重新通知。
 * @returns {Promise<{sent: boolean, reason?: string, key?: string, toast?: object|null}>}
 */
export async function sendAlert({
  root = process.cwd(),
  key,
  title = 'QQ 链路告警',
  body = '',
  level = 'error',
  source = '',
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  toast = showToast,
  toastOptions = {},
  logger = console.log
} = {}) {
  const alertKey = String(key ?? '').trim();
  if (!alertKey) return { sent: false, reason: 'missing-key' };
  const safeTitle = sanitizeAlertText(title, { maxLength: 120 }) || 'QQ 链路告警';
  const safeBody = sanitizeAlertText(body, { maxLength: DEFAULT_MAX_BODY });
  const at = new Date(now).toISOString();

  let result;
  try {
    result = await withStateLock(root, (paths) => {
      const state = readAlertState(root);
      const prior = state.alerts[alertKey];
      const lastAt = entryTime(prior);
      const cooldown = Math.max(0, Number(cooldownMs) || 0);
      if (prior?.active === true && lastAt > 0 && now - lastAt < cooldown) {
        return { sent: false, reason: 'cooldown', nextAt: new Date(lastAt + cooldown).toISOString() };
      }
      state.alerts[alertKey] = {
        active: true,
        title: safeTitle,
        level,
        source,
        firstAt: prior?.active === true && prior.firstAt ? prior.firstAt : at,
        lastAt: at,
        lastSeenAt: at,
        resolvedAt: null,
        count: (Number(prior?.count) || 0) + 1
      };
      state.version = ALERT_STATE_VERSION;
      state.updatedAt = at;
      state.alerts = pruneAlerts(state.alerts, now);
      writeAlertState(paths.state, state);
      return { sent: true };
    });
  } catch (error) {
    logger(`[notify] 告警状态写入失败：${error?.message ?? error}`);
    return { sent: false, reason: 'state-error' };
  }
  if (result.busy) {
    logger(`[notify] 告警状态被其他进程占用，跳过本轮：${alertKey}`);
    return { sent: false, reason: 'busy' };
  }
  if (!result.sent) return result;

  appendAlertLog(root, { at: now, source, level, key: alertKey, title: safeTitle, body: safeBody, kind: 'alert' });
  let toastResult = null;
  try {
    toastResult = await toast({ root, key: alertKey, title: safeTitle, body: safeBody, level, ...toastOptions });
  } catch (error) {
    toastResult = { ok: false, error: String(error?.message ?? error) };
  }
  if (toastResult && toastResult.ok === false) {
    logger(`[notify] 桌面通知未发出（${toastResult.error || '未知原因'}）：${alertKey}`);
  }
  return { sent: true, key: alertKey, title: safeTitle, body: safeBody, toast: toastResult };
}

/**
 * 标记故障已恢复；只对仍然 active 的告警动作，重复调用不会重复弹窗。
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function resolveAlert({
  root = process.cwd(),
  key,
  title = 'QQ 链路已恢复',
  body = '',
  level = 'info',
  source = '',
  now = Date.now(),
  toast = showToast,
  toastOptions = {},
  logger = console.log
} = {}) {
  const alertKey = String(key ?? '').trim();
  if (!alertKey) return { sent: false, reason: 'missing-key' };
  const fast = readAlertState(root).alerts[alertKey];
  if (!fast || fast.active !== true) return { sent: false, reason: 'not-active' };

  const safeTitle = sanitizeAlertText(title, { maxLength: 120 }) || 'QQ 链路已恢复';
  const safeBody = sanitizeAlertText(body, { maxLength: DEFAULT_MAX_BODY });
  const at = new Date(now).toISOString();

  let result;
  try {
    result = await withStateLock(root, (paths) => {
      const state = readAlertState(root);
      const entry = state.alerts[alertKey];
      if (!entry || entry.active !== true) return { sent: false, reason: 'not-active' };
      entry.active = false;
      entry.resolvedAt = at;
      entry.lastSeenAt = at;
      state.version = ALERT_STATE_VERSION;
      state.updatedAt = at;
      state.alerts = pruneAlerts(state.alerts, now);
      writeAlertState(paths.state, state);
      return { sent: true };
    });
  } catch (error) {
    logger(`[notify] 恢复状态写入失败：${error?.message ?? error}`);
    return { sent: false, reason: 'state-error' };
  }
  if (result.busy) {
    logger(`[notify] 告警状态被其他进程占用，跳过恢复通知：${alertKey}`);
    return { sent: false, reason: 'busy' };
  }
  if (!result.sent) return result;

  appendAlertLog(root, { at: now, source, level, key: alertKey, title: safeTitle, body: safeBody, kind: 'resolved' });
  let toastResult = null;
  try {
    toastResult = await toast({ root, key: alertKey, title: safeTitle, body: safeBody, level, ...toastOptions });
  } catch (error) {
    toastResult = { ok: false, error: String(error?.message ?? error) };
  }
  if (toastResult && toastResult.ok === false) {
    logger(`[notify] 恢复通知未发出（${toastResult.error || '未知原因'}）：${alertKey}`);
  }
  return { sent: true, key: alertKey, title: safeTitle, body: safeBody, toast: toastResult };
}
