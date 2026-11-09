// ChatTransport：独立模型/API 通信接口（窗口 MVP 的第二个稳定边界）。
// 当前只实现两种：mock（默认，离线验证）与 openai-compatible Chat Completions。
// 任何实现都只接收窗口自己的消息结构，不依赖 QQ / OneBot / NapCat / AstrBot / DSH。

export class TransportError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.detail = detail;
  }
}

/** 把窗口消息映射成 OpenAI Chat Completions 的 messages。 */
export function toOpenAiMessages(messages, capabilities) {
  const out = [];
  for (const m of messages) {
    const content = [];
    for (const p of m.parts ?? []) {
      if (p.type === 'text') { content.push({ type: 'text', text: p.text }); continue; }
      if (p.type === 'image') {
        if (!capabilities.image) throw new TransportError('transport/unsupported-part', '当前 API 不支持图片输入，请移除图片或更换支持多模态的配置', { kind: 'image' });
        content.push({ type: 'image_url', image_url: { url: `data:${p.attachment.mime};base64,${p.attachment.data ?? readAsBase64(p.attachment)}` } });
        continue;
      }
      if (p.type === 'audio') {
        if (!capabilities.audio) throw new TransportError('transport/unsupported-part', '当前 API 不支持音频输入，请移除音频或更换支持多模态的配置', { kind: 'audio' });
        const fmt = p.attachment.mime.includes('wav') ? 'wav' : 'mp3';
        content.push({ type: 'input_audio', input_audio: { data: p.attachment.data ?? readAsBase64(p.attachment), format: fmt } });
        continue;
      }
      throw new TransportError('transport/unsupported-part', '当前 API 不支持视频输入（Chat Completions 无视频标准格式）', { kind: 'video' });
    }
    const flat = content.every((c) => c.type === 'text') ? content.map((c) => c.text).join('\n') : content;
    out.push({ role: m.role, content: flat });
  }
  return out;
}

import fs from 'node:fs';
function readAsBase64(attachment) {
  try { return fs.readFileSync(attachment.path).toString('base64'); } catch { throw new TransportError('transport/attachment-unreadable', `附件读不到：${attachment.name}`); }
}

/** Mock：离线、确定性，回复里回显"收到第几轮 + 历史条数 + 最后一条用户文本"，用于验证上下文完整传递。 */
export function createMockTransport(config = {}) {
  const capabilities = { text: true, image: false, audio: false, video: false, ...(config.capabilities ?? {}) };
  return {
    name: 'mock',
    displayName: `Mock（本地模拟 · ${config.model ?? 'mock-model'}）`,
    capabilities,
    maxContextTokens: Number(config.maxContextTokens ?? 128000),
    async chat({ messages }) {
      const users = messages.filter((m) => m.role === 'user');
      const last = users.at(-1);
      const lastText = last ? (last.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 60) : '';
      const attachmentCount = messages.reduce((n, m) => n + (m.parts ?? []).filter((p) => p.type !== 'text').length, 0);
      return {
        text: `[Mock] 收到第 ${users.length} 轮：${lastText || '（无文字）'}。本次上下文共 ${messages.length} 条消息、附件 ${attachmentCount} 个。`,
        model: config.model ?? 'mock-model',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      };
    },
    /** 流式版本：逐段回吐，便于 UI 实时渲染。 */
    async chatStream({ messages, onDelta }) {
      const reply = await this.chat({ messages });
      const text = reply.text;
      const step = Math.max(1, Math.ceil(text.length / 12));
      for (let i = 0; i < text.length; i += step) {
        const piece = text.slice(i, i + step);
        onDelta(piece);
        await new Promise((r) => setTimeout(r, 12));
      }
      return reply;
    },
  };
}

/** OpenAI-compatible Chat Completions。密钥只在服务端；永不返回给窗口。 */
export function createOpenAiTransport(config = {}) {
  const baseURL = String(config.baseURL ?? '').replace(/\/+$/, '');
  if (!baseURL) throw new TransportError('transport/config', '缺少 baseURL（OpenAI-compatible 接口地址）');
  const model = String(config.model ?? '').trim();
  if (!model) throw new TransportError('transport/config', '缺少模型名称');
  const apiKey = config.apiKey ?? '';
  const capabilities = { text: true, image: false, audio: false, video: false, ...(config.supports ?? {}) };
  const timeoutMs = Number(config.timeoutMs ?? 120000);
  const maxContextTokens = Number(config.maxContextTokens ?? 128000);

  async function chat({ messages, signal }) {
    const body = { model, messages: toOpenAiMessages(messages, capabilities), stream: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        throw new TransportError('transport/unreachable', `模型接口不可用：${e?.message ?? e}`, { baseURL });
      }
      const raw = await res.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 错误体 */ }
      if (!res.ok) {
        const msg = json?.error?.message ?? raw.slice(0, 300) ?? `HTTP ${res.status}`;
        throw new TransportError('transport/http-error', `模型接口返回 ${res.status}：${msg}`, { status: res.status });
      }
      if (!json) throw new TransportError('transport/bad-response', '模型接口返回的不是 JSON');
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new TransportError('transport/empty-response', '模型接口返回了空内容');
      return { text, model: json.model ?? model, usage: json.usage ?? null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 流式版本：解析 SSE 的 data: 行，逐段回吐 delta.content。 */
  async function chatStream({ messages, signal, onDelta }) {
    const body = { model, messages: toOpenAiMessages(messages, capabilities), stream: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let full = '';
    try {
      let res;
      try {
        res = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        throw new TransportError('transport/unreachable', `模型接口不可用：${e?.message ?? e}`, { baseURL });
      }
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '');
        throw new TransportError('transport/http-error', `模型接口返回 ${res.status}：${raw.slice(0, 240)}`, { status: res.status });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let json;
          try { json = JSON.parse(payload); } catch { continue; }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) { full += delta; onDelta(delta); }
        }
      }
      if (!full.trim()) throw new TransportError('transport/empty-response', '模型接口流式返回了空内容');
      return { text: full, model, usage: null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return { name: 'openai', displayName: `OpenAI-compatible（${model}）`, capabilities, maxContextTokens, chat, chatStream };
}