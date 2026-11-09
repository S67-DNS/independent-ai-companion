// 进程级出站隔离：test mode 下所有 fetch / WebSocket 先过 Guard。
// production 分支调用原生实现，行为与之前一致（不拦截、不审计）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { PRODUCTION_ONEBOT_PORTS, DEFAULT_LOCAL_UI_BASE } from '../shared/outbound-constants.mjs';

const NATIVE_FETCH = globalThis.fetch;
const NATIVE_WEBSOCKET = globalThis.WebSocket;
const NATIVE_HTTP_REQUEST = http.request.bind(http);
const NATIVE_HTTP_GET = http.get.bind(http);
const NATIVE_HTTPS_REQUEST = https.request.bind(https);
const NATIVE_HTTPS_GET = https.get.bind(https);
const NATIVE_NET_CONNECT = net.connect.bind(net);
const PRODUCTION_PORTS = new Set([...PRODUCTION_ONEBOT_PORTS, 8801, 31050]);
const registry = new Map();
let configured = false;
let testMode = process.env.OPENCORE_HOST_TEST_MODE === '1';
let stateDir = null;
let auditPath = null;
let installed = false;
const auditLines = [];

function audit(entry) {
  const line = { atMs: Date.now(), ...entry };
  auditLines.push(line);
  if (auditLines.length > 2000) auditLines.shift();
  if (!auditPath) return;
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(line) + '\n', 'utf8');
  } catch { /* audit must not break egress */ }
}

function originOf(raw) {
  const url = new URL(String(raw));
  return url.origin;
}

export function configureOutboundEgress({ mode = null, dir = null } = {}) {
  if (mode !== null) testMode = mode === 'test';
  if (dir !== null) {
    stateDir = dir;
    auditPath = dir ? path.join(dir, 'outbound-egress-audit.jsonl') : null;
  }
  configured = true;
  if (testMode) installProcessGuard();
  return policy();
}

export function resetOutboundEgress() {
  if (installed) {
    globalThis.fetch = NATIVE_FETCH;
    if (NATIVE_WEBSOCKET) globalThis.WebSocket = NATIVE_WEBSOCKET;
    installed = false;
  }
  registry.clear();
  auditLines.length = 0;
  testMode = process.env.OPENCORE_HOST_TEST_MODE === '1';
  stateDir = null;
  auditPath = null;
  configured = false;
}

export function registerOutboundTarget(raw, label = 'test-target') {
  const origin = originOf(raw);
  registry.set(origin, label);
  try {
    const url = new URL(String(raw));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    // net.connect 使用 tcp origin；登记同一目标的 TCP 形态，避免底层连接被误判。
    registry.set(`tcp://${host}:${port}`, label);
  } catch { /* invalid target is rejected by validate */ }
  return origin;
}

export function policy() {
  return {
    testMode,
    configured,
    registry: Object.fromEntries(registry),
    productionPorts: [...PRODUCTION_PORTS],
    auditPath,
  };
}

export function getEgressAudit() { return [...auditLines]; }

function validate(raw, label) {
  if (!testMode) return { allowed: true };
  let url;
  try { url = new URL(String(raw)); } catch {
    audit({ decision: 'blocked', reason: 'invalid-url', label, origin: null });
    const error = new Error(`OPENCORE_EGRESS_BLOCKED: invalid URL at ${label}`);
    error.code = 'OPENCORE_EGRESS_BLOCKED';
    throw error;
  }
  const origin = url.origin;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  let reason = null;
  if (!['http:', 'https:', 'ws:', 'wss:', 'tcp:'].includes(url.protocol)) reason = 'unsupported-protocol';
  else if (!loopback) reason = 'non-loopback';
  else if (PRODUCTION_PORTS.has(port)) reason = 'production-port';
  else if (!registry.has(origin)) reason = 'target-not-registered';
  if (reason) {
    audit({ decision: 'blocked', reason, label, origin, port });
    const error = new Error(`OPENCORE_EGRESS_BLOCKED: ${reason} ${origin} at ${label}`);
    error.code = 'OPENCORE_EGRESS_BLOCKED';
    error.origin = origin;
    throw error;
  }
  audit({ decision: 'allowed', reason: 'registered-loopback-nonproduction', label, origin, port });
  return { allowed: true, origin, port };
}

export async function egressFetch(input, init = undefined, options = {}) {
  const label = options?.label ?? 'egress-fetch';
  const url = input instanceof URL ? input.href : (typeof input === 'string' ? input : (input?.url ?? String(input)));
  validate(url, label);
  return NATIVE_FETCH(input, init);
}

export function egressWebSocket(raw, options = {}) {
  const label = options?.label ?? 'egress-websocket';
  validate(raw, label);
  if (typeof NATIVE_WEBSOCKET !== 'function') {
    const error = new Error(`OPENCORE_EGRESS_BLOCKED: WebSocket unavailable for ${raw}`);
    error.code = 'OPENCORE_EGRESS_BLOCKED';
    throw error;
  }
  return new NATIVE_WEBSOCKET(raw);
}

function httpOriginFromArgs(args, protocol = 'http:') {
  const first = args[0];
  if (first instanceof URL) return first.origin;
  if (typeof first === 'string' && /^[a-z]+:\/\//i.test(first)) return new URL(first).origin;
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const host = String(first.hostname ?? first.host ?? 'localhost');
    const port = first.port ?? (protocol === 'https:' ? 443 : 80);
    return new URL(`${protocol}//${host}:${Number(port)}`).origin;
  }
  return new URL(`${protocol}//localhost`).origin;
}

function netOriginFromArgs(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    const host = String(first.host ?? 'localhost');
    const port = first.port ?? 0;
    return new URL(`tcp://${host}:${Number(port)}`).origin;
  }
  const port = Number(first);
  const host = String(args[1] ?? 'localhost');
  return new URL(`tcp://${host}:${port}`).origin;
}

function installProcessGuard() {
  if (installed) return;
  globalThis.fetch = (input, init) => egressFetch(input, init, { label: 'global-fetch' });
  if (typeof NATIVE_WEBSOCKET === 'function') {
    globalThis.WebSocket = new Proxy(NATIVE_WEBSOCKET, {
      construct(target, args, newTarget) {
        egressWebSocket(args[0], { label: 'global-websocket' });
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
  const guardedHttpRequest = (protocol, nativeRequest) => function guarded(...args) {
    validate(httpOriginFromArgs(args, protocol), 'global-http-request');
    return nativeRequest(...args);
  };
  http.request = guardedHttpRequest('http:', NATIVE_HTTP_REQUEST);
  http.get = guardedHttpRequest('http:', NATIVE_HTTP_GET);
  https.request = guardedHttpRequest('https:', NATIVE_HTTPS_REQUEST);
  https.get = guardedHttpRequest('https:', NATIVE_HTTPS_GET);
  // net.connect 不作为第一版全局替换：Node 内置 fetch/undici 的底层连接可能复用
  // node:net 导出对象；替换会把合法 mock 连接也打成 fetch failed。HTTP(S) request/get
  // 已覆盖应用层直连，静态守卫覆盖剩余别名；net 直连列入残余风险。
  installed = true;
  globalThis.__OPENCORE_EGRESS_PRELOADED__ = true;
}

export const DEFAULT_LOCAL_UI = DEFAULT_LOCAL_UI_BASE;
