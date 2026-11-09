// 桥接端到端就绪快照（state/bridge-readiness.json）。
//
// `/api/health` 只证明「这个端口后面确实是桥接服务核心主体」，不证明 OneBot WebSocket 连着、
// QQ 侧收得到消息。端口在、进程在、WebSocket 断了（换账号后 token 失效、网关卡死等）
// 时，旧看门狗仍然会认为桥接一切正常。
//
// 桥接每 15 秒写一份**不含令牌/URL/账号**的快照；看门狗/启动器只把它当作补充证据：
//   · 文件缺失 / 版本不符 / PID 与 bridge.lock 不一致 / 过期 → 「未知」，绝不能据此重启。
//     旧版桥接没有这个文件，升级瞬间必须按在线放行。
//   · connected=false 超过宽限期 → 才认为需要自愈；短时间断线由 SDK 自己重连。
//
// 这里只做纯判断，不启动/杀死任何进程；调用方仍须用 bridge.lock 验证 PID 归属。
import fs from 'node:fs';
import path from 'node:path';

// 值为协议约定：桥接写入就绪快照时的 service 标识，读取侧须一致，已按配置映射方案隔离，详见 FINAL-PROTOCOL-COMPATIBILITY-DECISION.md。
// 协议约定值由部署方通过环境变量映射；公开默认值为中性标识，不含内部项目自称。
export const READINESS_SERVICE = process.env.READINESS_SERVICE_ID || 'bridge-readiness';
export const READINESS_VERSION = 1;
export const DEFAULT_STALE_MS = 120_000;
export const DEFAULT_ONEBOT_GRACE_MS = 180_000;

/** 快照文件位置（root 是仓库根目录）。 */
export function readinessFile(root) {
  return path.join(root, 'state', 'bridge-readiness.json');
}

/** 读取并校验快照结构；任何异常/旧版本都返回 null（= 未知，不是掉线）。 */
export function readBridgeReadiness(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.service !== READINESS_SERVICE) return null;
    if (Number(data.version) !== READINESS_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

function isoMs(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : 0;
}

function humanMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
  return `${Math.round(value / 60_000)} 分钟`;
}

/**
 * 判断快照是否可信、OneBot 是否在宽限期内。
 *
 * @param {object|null} data - readBridgeReadiness() 的结果。
 * @param {object} options
 * @param {number} [options.now]
 * @param {number} [options.staleMs] - updatedAt 超过这个时长视为写侧已停（未知）。
 * @param {number} [options.graceMs] - OneBot 断线宽限；SDK 会在这段时间里自行重连。
 * @param {number} [options.lockPid] - bridge.lock 里的 PID；缺失时不信任快照。
 * @param {(pid: number) => boolean} [options.pidAlive]
 * @returns {{known: boolean, ready: boolean|null, reason: string|null, pid: number,
 *   onebotConnected: boolean|null, disconnectedMs: number|null, graceMs: number,
 *   updatedAgoMs: number|null, detail: string}}
 */
export function assessBridgeReadiness(data, {
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  graceMs = DEFAULT_ONEBOT_GRACE_MS,
  lockPid = 0,
  pidAlive = () => false,
} = {}) {
  const unknown = (reason, detail, extra = {}) => ({
    known: false,
    ready: null,
    reason,
    pid: 0,
    onebotConnected: null,
    disconnectedMs: null,
    graceMs,
    updatedAgoMs: null,
    detail,
    ...extra,
  });
  if (!data) return unknown('missing', '没有桥接就绪快照（旧版桥接或尚未写出）');
  const pid = Number(data.pid);
  if (!Number.isInteger(pid) || pid <= 0) return unknown('invalid-pid', '就绪快照缺少有效 PID');
  const lock = Number(lockPid);
  if (!Number.isInteger(lock) || lock <= 0) {
    return unknown('no-lock', 'bridge.lock 缺失或不可读，无法确认快照归属', { pid });
  }
  if (pid !== lock) {
    return unknown('pid-mismatch', `就绪快照 PID ${pid} 与 bridge.lock ${lock} 不一致`, { pid });
  }
  if (!pidAlive(pid)) {
    return unknown('pid-dead', `就绪快照 PID ${pid} 已不在运行`, { pid });
  }
  const updatedAt = isoMs(data.updatedAt);
  if (!updatedAt) return unknown('invalid-time', '就绪快照缺少有效 updatedAt', { pid });
  const ageMs = now - updatedAt;
  // 时钟回拨超过一个 stale 窗口同样不可信：未来时间会让「过期」永远判不出来。
  if (ageMs > staleMs || ageMs < -staleMs) {
    return unknown('stale', `就绪快照已 ${humanMs(Math.abs(ageMs))} 未更新，写侧可能卡住`, {
      pid,
      updatedAgoMs: ageMs,
    });
  }

  const onebot = data.onebot && typeof data.onebot === 'object' ? data.onebot : {};
  const connected = onebot.connected === true;
  const disconnectedAt = isoMs(onebot.disconnectedAt);
  const startedAt = isoMs(data.startedAt);
  // 从未连上过（启动阶段）时用 startedAt 起算，避免启动即被判掉线。
  const since = disconnectedAt || startedAt || updatedAt;
  const downMs = Math.max(0, now - since);
  const ready = connected || downMs < graceMs;
  let detail;
  if (connected) {
    detail = 'OneBot WebSocket 已连接';
    if (onebot.good === false) detail += '（但网关上报告接收链路异常）';
  } else if (ready) {
    detail = `OneBot 断线 ${humanMs(downMs)}，仍在 ${humanMs(graceMs)} 宽限期内`;
  } else {
    detail = `OneBot 已断线 ${humanMs(downMs)}，超过 ${humanMs(graceMs)} 宽限期`;
  }
  return {
    known: true,
    ready,
    reason: null,
    pid,
    onebotConnected: connected,
    disconnectedMs: connected ? 0 : downMs,
    graceMs,
    updatedAgoMs: ageMs,
    accountOnline: typeof onebot.accountOnline === 'boolean' ? onebot.accountOnline : null,
    good: typeof onebot.good === 'boolean' ? onebot.good : null,
    degraded: onebot.degraded === true,
    detail,
  };
}

/**
 * 是否允许按这份快照重启桥接。
 * 必须同时满足：快照可信、明确不 ready、PID 与 bridge.lock 完全一致。
 * 缺一条都只能等/告警，绝不能杀一个来路不明的 PID（可能是被回收给别的程序了）。
 */
export function canRestartOwnedBridge(assessment, lockPid) {
  return Boolean(assessment)
    && assessment.known === true
    && assessment.ready === false
    && Number(assessment.pid) > 0
    && Number(assessment.pid) === Number(lockPid);
}
