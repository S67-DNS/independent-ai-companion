// 桥接控制台的「身份探针」。
//
// 只看 TCP 端口是否在监听是不够的：consolePort 被任意别的程序占用时，启动器会
// 以为桥接已经在跑，看门狗也会一直认为桥接在线，真正的桥接反而永远不会被拉起。
// 这里用 bridge.js 提供的无令牌 /api/health 确认端口后面确实是桥接服务核心主体。
//
// 旧版桥接没有健康接口。升级过渡期（新启动器遇到仍在前台运行的旧实例）会得到
// 401/404 而不是 200；若此时 bridge.lock 指向仍存活的进程，就按「旧版桥接」放行。
// 这不是安全判定，只是避免升级瞬间把正在工作的实例误判成陌生进程。
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isPidAlive, readLockPid } from './pid-lock.mjs';

// 值为协议约定：必须与桥接 /api/health 返回的 service 字段一致，已按配置映射方案隔离，详见 FINAL-PROTOCOL-COMPATIBILITY-DECISION.md。
// 协议约定值由部署方通过环境变量映射；公开默认值为中性标识，不含内部项目自称。
export const BRIDGE_SERVICE = process.env.BRIDGE_SERVICE_ID || 'bridge-service';
export const BRIDGE_HEALTH_PATH = '/api/health';

function tcpOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * @returns {Promise<{ok: boolean, responded: boolean, status: number|null}>}
 *   responded=false 表示没拿到**完整** HTTP 响应（拒绝连接、超时、非 HTTP 服务、
 *   或响应体没在期限内读完）；responded=true 且 ok=false 表示对方完整回了 HTTP，
 *   但不是桥接的健康响应（例如旧版桥接的 401/404）。
 */
export function fetchBridgeHealth(port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(value);
    };
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: BRIDGE_HEALTH_PATH,
      headers: { accept: 'application/json' },
      agent: false
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        // 陌生服务可能回一个很大的页面；身份探针只需要开头一小段。
        if (body.length < 16_384) body += chunk;
      });
      res.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch {}
        finish({
          ok: res.statusCode === 200 && payload?.ok === true && payload?.service === BRIDGE_SERVICE,
          responded: true,
          status: res.statusCode ?? null
        });
      });
      res.on('error', () => finish({ ok: false, responded: false, status: null }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('health timeout')));
    // setTimeout 是「空闲」超时：陌生服务只要隔一会儿滴一个字节，请求就永远不会结束，
    // 启动器 30 秒等待和看门狗这一轮检查都会被拖住。再加一道绝对截止时间。
    // 已收到响应头但正文没在期限内读完时按 responded=false 处理：只有完整拿到
    // 可解析的健康响应才算「有 HTTP 应答」，避免半截响应被误判成旧版桥接。
    deadline = setTimeout(() => {
      finish({ ok: false, responded: false, status: null });
      req.destroy();
    }, timeoutMs);
    req.on('error', () => finish({ ok: false, responded: false, status: null }));
  });
}

/**
 * 判断控制台端口的状态：
 *   closed       端口没开（桥接不在）
 *   healthy      新桥接确认在线
 *   legacy       端口在监听、健康接口不是桥接的，但 bridge.lock 指向存活进程（旧版）
 *   unresponsive 端口在监听、进程还活着，但健康接口没有响应（卡死/阻塞）
 *   foreign      端口被别的进程占用，且没有存活桥接锁
 *
 * 只有 healthy / legacy 返回 ok=true。unresponsive / foreign 都不能再启动第二个
 * 实例（端口仍被占用），调用方应报错而不是伪装成就绪。
 */
export async function probeBridge(consolePort, { root = '', timeoutMs = 1500, lockFile = '' } = {}) {
  const port = Number(consolePort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, state: 'closed', pid: 0, detail: `控制台端口无效：${consolePort}` };
  }
  if (!(await tcpOpen(port, Math.min(timeoutMs, 800)))) {
    return { ok: false, state: 'closed', pid: 0, detail: `控制台端口 ${port} 未监听` };
  }
  const health = await fetchBridgeHealth(port, { timeoutMs });
  if (health.ok) {
    return { ok: true, state: 'healthy', pid: 0, detail: `控制台 ${port} 健康检查通过` };
  }
  const lock = lockFile || (root ? path.join(root, 'state', 'bridge.lock') : '');
  const pid = lock ? readLockPid(lock) : 0;
  const alive = pid > 0 && isPidAlive(pid);
  if (health.responded && alive) {
    return {
      ok: true,
      state: 'legacy',
      pid,
      detail: `健康接口不可用（HTTP ${health.status ?? '?'}），但 bridge.lock 指向存活进程 ${pid}，按旧版桥接处理`
    };
  }
  if (alive) {
    return {
      ok: false,
      state: 'unresponsive',
      pid,
      detail: `端口 ${port} 在监听但健康接口无响应，bridge.lock 指向存活进程 ${pid}`
    };
  }
  return {
    ok: false,
    state: 'foreign',
    pid: 0,
    detail: `端口 ${port} 被其它进程占用（健康接口未通过${health.responded ? `，HTTP ${health.status}` : ''}）`
  };
}
