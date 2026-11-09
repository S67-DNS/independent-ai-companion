#!/usr/bin/env node
// LOCAL-WINDOW-MVP-MINIMAL-001 · 极简独立本地聊天窗口（服务端）
//
// 边界声明：
//   · 只监听 127.0.0.1，不对外网/局域网开放；
//   · 只连接"配置指定的 OpenAI-compatible 模型接口"或本地 Mock；
//   · 不依赖 QQ / OneBot / NapCat / AstrBot / DSH 私有接口 / 旧 Bridge / 任何通信平台 SDK；
//   · 聊天记录与媒体只写本窗口自己的数据目录，不写 memory.db、不改人格与日记。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { validateParts, PART_KINDS, PartError, estimateTokens, unsupportedKinds, MAX_BODY_BYTES } from './lib/parts.mjs';
import { Store, newMessageId } from './lib/store.mjs';
import { createMockTransport, createOpenAiTransport, TransportError } from './lib/transport.mjs';
import { exportTxt } from './lib/exporter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const DEFAULT_DATA_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'continuity-core', 'local-window');
const NAME = 'LOCAL-WINDOW-MVP-MINIMAL-001';

// ---------- 配置 ----------
function loadConfig() {
  const configPath = process.env.LOCAL_WINDOW_CONFIG || path.join(HERE, 'config.json');
  let file = {};
  if (fs.existsSync(configPath)) {
    try { file = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { throw new Error(`配置文件解析失败：${configPath}：${e.message}`); }
  }
  const env = process.env;
  const dataDir = env.LOCAL_WINDOW_DATA || file.dataDir || DEFAULT_DATA_DIR;
  const transportKind = env.LOCAL_WINDOW_TRANSPORT || file.transport || 'mock';
  const modelCfg = { ...(file.model ?? {}) };
  const openaiCfg = {
    ...(file.openai ?? {}),
    baseURL: env.LOCAL_WINDOW_BASE_URL || file.openai?.baseURL || '',
    model: env.LOCAL_WINDOW_MODEL || file.openai?.model || '',
    apiKey: env.LOCAL_WINDOW_API_KEY || file.openai?.apiKey || '',
  };
  const listen = { host: '127.0.0.1', port: Number(env.LOCAL_WINDOW_PORT ?? file.listen?.port ?? 8790) };
  const transportConfig = transportKind === 'openai'
    ? { ...openaiCfg, maxContextTokens: openaiCfg.maxContextTokens ?? modelCfg.maxContextTokens ?? 128000 }
    : { model: modelCfg.name ?? 'mock-model', maxContextTokens: modelCfg.maxContextTokens ?? 128000, capabilities: modelCfg.mockCapabilities };
  return { configPath, dataDir: path.resolve(dataDir), transportKind, transportConfig, listen };
}

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const transport = cfg.transportKind === 'openai' ? createOpenAiTransport(cfg.transportConfig) : createMockTransport(cfg.transportConfig);
const startedAt = new Date().toISOString();
let sendBusy = false;

// ---------- 工具 ----------
const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};
const fail = (res, status, code, message, detail) => json(res, status, { ok: false, error: { code, message, ...(detail ? { detail } : {}) } });

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error(`请求体超过 ${limit} 字节`), { code: 'body/too-large', status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) { fail(res, 404, 'static/not-found', '文件不存在'); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(buf);
  });
}

const MIME_STATIC = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- 消息组装 ----------
function publicMessage(m) {
  return {
    id: m.id, role: m.role, time: m.time, status: m.status ?? 'ok', model: m.model ?? null,
    parts: (m.parts ?? []).map((p) => p.type === 'text' ? { type: 'text', text: p.text } : { type: p.type, attachment: { ...p.attachment } }),
  };
}

async function handleSend(req, res) {
  if (sendBusy) { fail(res, 409, 'window/busy', '上一条消息还在处理中，请稍候'); return; }
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch (e) { fail(res, e.status ?? 400, e.code ?? 'body/invalid-json', e.message); return; }

  let parts;
  try { parts = validateParts(body.parts); }
  catch (e) { if (e instanceof PartError) { fail(res, e.code === 'part/mime-unsupported' ? 415 : 400, e.code, e.message, e.detail); return; } throw e; }

  const unsupported = unsupportedKinds(parts, transport.capabilities);
  if (unsupported.length) {
    fail(res, 422, 'transport/unsupported-part', `当前通道（${transport.displayName}）不支持：${unsupported.join('、')}。请移除附件或更换支持多模态的配置。`, { unsupported, capabilities: transport.capabilities });
    return;
  }

  const history = store.loadMessages();
  const now = new Date().toISOString();
  const userParts = parts.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    const meta = store.saveAttachment(p);
    const { data, ...keep } = p.attachment;
    return { type: p.type, attachment: meta };
  });
  const userMessage = { id: newMessageId(), role: 'user', time: now, status: 'ok', parts: userParts };

  const outgoing = [...history, userMessage];
  const estimate = estimateTokens(outgoing);
  if (estimate > transport.maxContextTokens) {
    store.appendMessage({ ...userMessage, status: 'failed' });
    fail(res, 413, 'context/too-long', `上下文预计 ${estimate} tokens，超过当前上限 ${transport.maxContextTokens}；已拒绝发送（不静默截断）。`, { estimate, limit: transport.maxContextTokens, messages: outgoing.length });
    return;
  }

  sendBusy = true;
  if (body.stream === true) {
    try { await streamReply(res, { userMessage, outgoing }); }
    finally { sendBusy = false; }
    return;
  }
  try {
    const reply = await transport.chat({ messages: outgoing });
    const assistantMessage = {
      id: newMessageId(), role: 'assistant', time: new Date().toISOString(), status: 'ok',
      model: reply.model ?? null, usage: reply.usage ?? null,
      parts: [{ type: 'text', text: reply.text }],
    };
    // 顺序落盘：user 先、assistant 后（保证导出/重开顺序正确）
    store.appendMessage(userMessage);
    store.appendMessage(assistantMessage);
    json(res, 200, { ok: true, userMessage: publicMessage(userMessage), assistantMessage: publicMessage(assistantMessage) });
  } catch (e) {
    store.appendMessage({ ...userMessage, status: 'failed' });
    if (e instanceof TransportError) {
      const status = e.code === 'transport/unsupported-part' ? 422 : 502;
      fail(res, status, e.code, e.message, e.detail);
    } else {
      fail(res, 502, 'transport/unknown', `模型调用失败：${e?.message ?? e}`);
    }
  } finally {
    sendBusy = false;
  }
}

// ---------- 流式回复（SSE） ----------
async function streamReply(res, { userMessage, outgoing }) {
  store.appendMessage(userMessage);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ } };
  send('user', { message: publicMessage(userMessage) });

  const controller = new AbortController();
  res.on('close', () => controller.abort(new Error('client closed')));
  let text = '';
  try {
    const call = typeof transport.chatStream === 'function' ? transport.chatStream.bind(transport) : transport.chat.bind(transport);
    const reply = await call({ messages: outgoing, signal: controller.signal, onDelta: (delta) => { text += delta; send('delta', { delta }); } });
    if (controller.signal.aborted) return;
    const finalText = (reply?.text ?? text ?? '').trim() ? (reply?.text ?? text) : text;
    const assistantMessage = {
      id: newMessageId(), role: 'assistant', time: new Date().toISOString(), status: 'ok',
      model: reply?.model ?? null, usage: reply?.usage ?? null,
      parts: [{ type: 'text', text: finalText }],
    };
    store.appendMessage(assistantMessage);
    send('done', { message: publicMessage(assistantMessage) });
  } catch (e) {
    if (controller.signal.aborted) return;
    const code = e instanceof TransportError ? e.code : 'transport/unknown';
    send('error', { code, message: String(e?.message ?? e) });
  } finally {
    try { res.end(); } catch { /* 已关闭 */ }
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), MIME_STATIC['.html']);
    if (req.method === 'GET' && (p === '/app.css' || p === '/app.js')) {
      const f = path.join(PUBLIC_DIR, p.slice(1));
      return serveFile(res, f, MIME_STATIC[path.extname(f)] ?? 'application/octet-stream');
    }
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, name: NAME, startedAt, transport: transport.name, model: transport.displayName });
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, {
        ok: true, name: NAME, transport: transport.name, transportLabel: transport.displayName,
        capabilities: transport.capabilities, maxContextTokens: transport.maxContextTokens,
        dataDir: cfg.dataDir, listen: cfg.listen, partKinds: PART_KINDS, startedAt,
        note: transport.name === 'mock' ? '当前为本地 Mock 通道，尚未联调真实模型' : '当前为 OpenAI-compatible 通道（密钥仅保存在服务端）',
      });
    }
    if (req.method === 'GET' && p === '/api/messages') {
      const messages = store.loadMessages().map(publicMessage);
      return json(res, 200, { ok: true, messages, count: messages.length });
    }
    if (req.method === 'POST' && p === '/api/messages') return await handleSend(req, res);
    if (req.method === 'GET' && p === '/api/export.txt') {
      const messages = store.loadMessages();
      const { file, text } = exportTxt(store, { messages, transportLabel: transport.displayName });
      const name = path.basename(file);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
        'x-local-window-export': file,
      });
      res.end(text);
      return;
    }
    if (req.method === 'GET' && p.startsWith('/media/')) {
      const id = decodeURIComponent(p.slice('/media/'.length));
      const found = /^att_[A-Za-z0-9_]+$/.test(id) ? store.findAttachmentPath(id) : null;
      if (!found) return fail(res, 404, 'media/not-found', '附件不存在');
      res.writeHead(200, { 'content-type': found.meta.mime, 'cache-control': 'no-store', 'content-length': fs.statSync(found.abs).size });
      return fs.createReadStream(found.abs).pipe(res);
    }
    fail(res, 404, 'route/not-found', `未知路由：${req.method} ${p}`);
  } catch (e) {
    fail(res, 500, 'server/internal', String(e?.message ?? e));
  }
});

server.on('error', (e) => {
  console.error(`[local-window] server error: ${e.message}`);
  process.exitCode = 1;
});

server.listen(cfg.listen.port, cfg.listen.host, () => {
  const addr = server.address();
  const info = { name: NAME, host: cfg.listen.host, port: addr.port, dataDir: cfg.dataDir, transport: transport.name, model: transport.displayName, configPath: cfg.configPath };
  // 供启动脚本/测试解析；不含任何密钥
  console.log(`LOCAL_WINDOW_READY ${JSON.stringify(info)}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { server.close(); } finally { process.exit(0); } });
}