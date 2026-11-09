import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideInbound, decideRecallNotice } from '../adapters/formal-gateway-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', 'config', 'production.json'), 'utf8'));
const ONEBOT = JSON.parse(fs.readFileSync('<WORKSPACE>/', 'utf8').replace(/^\uFEFF/, ''));
const TOKEN = ONEBOT.networks.wsServers[0].accessToken;
const URL = 'ws://127.0.0.1:3001/?access_token=' + encodeURIComponent(TOKEN);
const HOST = 'http://127.0.0.1:' + CONFIG.core.hostPort + '/inbound';
// 撤回通知单独走一个端点：不挤占消息链的 190s 预算，也不改 /inbound 的既有契约。
const HOST_NOTICE = 'http://127.0.0.1:' + CONFIG.core.hostPort + '/inbound/notice';
const NOTICE_TIMEOUT_MS = Number(CONFIG.core?.noticeTimeoutMs) > 0 ? Number(CONFIG.core.noticeTimeoutMs) : 8000;
const OUT = '<WORKSPACE>/';
const STANDBY = CONFIG.deployment?.inboundStandby === 'ENABLED';
const WANTS_ACTIVE = CONFIG.deployment?.personaActivation === 'ENABLED'
  && CONFIG.deployment?.messageProcessing === 'ENABLED';
const ACTIVE = WANTS_ACTIVE && process.env.OPENCORE_ALLOW_PERSONA_INBOUND === '1';
const TEST_ENDPOINT = process.env.OPENCORE_GATEWAY_SYNTHETIC_TEST === '1';
const state = {
  startedAt: new Date().toISOString(), mode: ACTIVE ? 'ACTIVE' : (STANDBY ? 'STANDBY' : 'BLOCKED'),
  inboundStandby: STANDBY, personaActivation: CONFIG.deployment?.personaActivation ?? null,
  messageProcessing: CONFIG.deployment?.messageProcessing ?? null,
  wsConnected: false, reconnects: 0, received: 0, accepted: 0, denied: 0, forwarded: 0, hostErrors: 0,
  // 撤回通知计数：notices=收到的 notice 数；recalled=Host 确认落地；recallDenied=策略拒绝；
  // recallIgnored=非私聊撤回（群撤回）等明确忽略。只记 id，不记消息正文。
  notices: 0, recalled: 0, recallDenied: 0, recallIgnored: 0,
  standbyAccepted: 0, lastEvent: null, lastError: null, outbound: CONFIG.deployment?.qqOutbound === 'ENABLED' ? 'ENABLED' : 'DISABLED',
  syntheticEndpoint: TEST_ENDPOINT
};
function save() { try { fs.writeFileSync(OUT, JSON.stringify(state, null, 2)); } catch { /* ignore */ } }
function log(msg) { try { fs.appendFileSync('<WORKSPACE>/', new Date().toISOString() + ' ' + msg + '\n'); } catch { /* ignore */ } }
if (WANTS_ACTIVE && !ACTIVE) {
  state.blocked = 'PERSONA_INBOUND_AUTHORIZATION_REQUIRED';
  save(); log('refused to connect: active inbound requires OPENCORE_ALLOW_PERSONA_INBOUND=1');
  console.log(JSON.stringify(state)); process.exit(0);
}
if (!STANDBY && !ACTIVE) {
  state.blocked = 'PERSONA_ACTIVATION_DISABLED';
  save(); log('refused to connect: standby and persona/message activation disabled');
  console.log(JSON.stringify(state)); process.exit(0);
}
let ws; let stopped = false; let testServer; let testPort = null;
let eventChain = Promise.resolve();
async function forward(event, decision, { synthetic = false } = {}) {
  try {
    const res = await fetch(HOST, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ correlationId: `qq:${event.message_id ?? event.messageId ?? ''}`, synthetic, rawEvent: event, decision }), signal: AbortSignal.timeout(190000) });
    const body = await res.text();
    state.forwarded += 1;
    if (!res.ok) state.hostErrors += 1;
    log(`forward synthetic=${synthetic} status=${res.status} body=${body.slice(0, 300)}`);
    return { status: res.status, body };
  } catch (e) {
    state.hostErrors += 1; state.lastError = String(e.message); log('forward error ' + String(e.message));
    return { status: 0, body: String(e.message) };
  }
}
async function forwardNotice(event, decision) {
  // 复用消息链的超时上限之外单独给短超时：撤回丢了可以人工补，但绝不能阻塞后续消息。
  const mid = String(decision?.mid ?? '');
  try {
    const res = await fetch(HOST_NOTICE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ correlationId: `recall:${mid}`, rawEvent: event, decision }),
      signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
    });
    const body = await res.text();
    state.forwarded += 1;
    if (!res.ok) state.hostErrors += 1;
    // 只记 mid / 状态码 / 截断后的响应体（Host 只返回计数与错误码，不含正文）。
    log(`notice forward mid=${mid} status=${res.status} body=${body.slice(0, 200)}`);
    return { status: res.status, body };
  } catch (e) {
    state.hostErrors += 1; state.lastError = String(e.message);
    log(`notice forward error mid=${mid} ` + String(e.message));
    return { status: 0, body: String(e.message) };
  }
}
async function handleNotice(event) {
  state.notices += 1;
  const decision = decideRecallNotice(event, CONFIG);
  if (!decision.allow) {
    if (decision.reason === 'group-recall') state.recallIgnored += 1;
    else state.recallDenied += 1;
    save();
    log(`notice ignored reason=${decision.reason}`);
    return { ignored: decision.reason };
  }
  state.recallAccepted = (state.recallAccepted ?? 0) + 1;
  const result = await forwardNotice(event, decision);
  if (result.status === 200) state.recalled += 1;
  save();
  return result;
}
async function handleEvent(event, { synthetic = false } = {}) {
  if (event.post_type === 'meta_event') return { skipped: 'meta_event' };
  // 撤回通知（private-only）：旧桥 friend_recall 的等价入口；群撤回在策略层显式拒绝。
  if (event.post_type === 'notice') return handleNotice(event);
  if (event.post_type !== 'message') return { skipped: 'not_message' };
  state.received += 1;
  state.lastEvent = { at: new Date().toISOString(), synthetic, post_type: event.post_type, message_type: event.message_type, sub_type: event.sub_type, hasUserId: event.user_id != null, hasGroupId: event.group_id != null, messageId: event.message_id ?? null };
  const decision = decideInbound(event, CONFIG);
  if (!decision.allow) { state.denied += 1; save(); log(`denied ${decision.reason}`); return { denied: decision.reason }; }
  state.accepted += 1; save(); log(`accepted admin private synthetic=${synthetic}; forwarding`);
  const result = await forward(event, decision, { synthetic });
  if (result.status === 202) state.standbyAccepted += 1;
  save();
  return result;
}
function connect() {
  if (stopped) return;
  ws = new WebSocket(URL);
  ws.addEventListener('open', () => { state.wsConnected = true; save(); log('ws connected'); });
  ws.addEventListener('message', (ev) => {
    eventChain = eventChain.then(async () => {
      let event; try { event = JSON.parse(ev.data); } catch { return; }
      await handleEvent(event, { synthetic: false });
    }).catch((error) => {
      state.hostErrors += 1; state.lastError = String(error.message); save();
      log('event chain error ' + String(error.message));
    });
  });
  ws.addEventListener('close', () => { state.wsConnected = false; save(); if (!stopped) { state.reconnects += 1; setTimeout(connect, 3000); } });
  ws.addEventListener('error', (e) => { state.lastError = String(e.message || e.type || 'ws-error'); save(); });
}
function startSyntheticEndpoint() {
  if (!TEST_ENDPOINT) return;
  testServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/synthetic-event') { res.writeHead(404); res.end('not found'); return; }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', async () => {
      try {
        const event = JSON.parse(body);
        const result = await handleEvent(event, { synthetic: true });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, synthetic: true, result }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message) }));
      }
    });
  });
  testServer.listen(31051, '127.0.0.1', () => { testPort = 31051; state.syntheticEndpoint = true; state.testPort = 31051; save(); log('synthetic endpoint 127.0.0.1:31051 enabled'); });
}
connect();
startSyntheticEndpoint();
setInterval(save, 5000);
process.on('SIGTERM', () => { stopped = true; try { ws?.close(); } catch {} try { testServer?.close(); } catch {} save(); process.exit(0); });
process.on('SIGINT', () => { stopped = true; try { ws?.close(); } catch {} try { testServer?.close(); } catch {} save(); process.exit(0); });
