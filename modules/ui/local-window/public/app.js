// 本地窗口前端（无框架、无第三方依赖）。
// 只与同源的本地 API 通信：/api/*。不接触 QQ / OneBot / NapCat / AstrBot / DSH。

const $ = (id) => document.getElementById(id);
const els = {
  messages: $('messages'), empty: $('empty'), input: $('input'), send: $('send-btn'),
  file: $('file-input'), pending: $('pending'), badge: $('channel-badge'),
  exportBtn: $('export-btn'), toast: $('toast'), sub: $('brand-sub'),
};

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 8;
const state = { messages: [], pending: [], config: null, sending: false };

const fmtSize = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};
const kindLabel = { image: '图片', audio: '音频', video: '视频' };

function toast(message, kind = 'error') {
  els.toast.textContent = message;
  els.toast.className = `toast${kind === 'info' ? ' info' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, 6000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function attachmentNode(part) {
  const a = part.attachment ?? {};
  const wrap = el('div', 'bubble-attachments');
  if (part.type === 'image') {
    const img = el('img');
    img.src = `/media/${encodeURIComponent(a.id)}`;
    img.alt = a.name ?? '图片';
    img.loading = 'lazy';
    wrap.appendChild(img);
    return wrap;
  }
  if (part.type === 'audio') {
    const audio = el('audio');
    audio.controls = true;
    audio.src = `/media/${encodeURIComponent(a.id)}`;
    wrap.appendChild(audio);
    return wrap;
  }
  if (part.type === 'video') {
    const video = el('video');
    video.controls = true;
    video.src = `/media/${encodeURIComponent(a.id)}`;
    wrap.appendChild(video);
    return wrap;
  }
  wrap.appendChild(el('div', 'file-chip', `${kindLabel[part.type] ?? part.type}：${a.name ?? ''}`));
  return wrap;
}

function renderMessage(m) {
  const row = el('div', `row ${m.role}`);
  const wrap = el('div', 'bubble-wrap');

  const hasText = (m.parts ?? []).some((p) => p.type === 'text' && p.text.trim());
  if (hasText) {
    const bubble = el('div', `bubble${m.status === 'failed' ? ' failed' : ''}`);
    bubble.textContent = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    wrap.appendChild(bubble);
  }
  for (const p of (m.parts ?? [])) {
    if (p.type === 'text') continue;
    wrap.appendChild(attachmentNode(p));
  }
  if (m.status === 'failed') wrap.appendChild(el('div', 'meta', '发送失败（已保留在本地记录）'));
  else wrap.appendChild(el('div', 'meta', fmtTime(m.time)));
  row.appendChild(wrap);
  return row;
}

function renderAll() {
  els.messages.querySelectorAll('.row, .typing-row').forEach((n) => n.remove());
  els.empty.hidden = state.messages.length > 0;
  for (const m of state.messages) els.messages.appendChild(renderMessage(m));
  scrollToBottom();
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function showTyping() {
  const row = el('div', 'row assistant typing-row');
  const bubble = el('div', 'bubble');
  const t = el('span', 'typing');
  t.append(el('i'), el('i'), el('i'));
  bubble.appendChild(t);
  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollToBottom();
  return row;
}

function renderPending() {
  els.pending.hidden = state.pending.length === 0;
  els.pending.replaceChildren();
  for (const [i, f] of state.pending.entries()) {
    const chip = el('div', 'pending-chip');
    chip.append(el('span', 'name', f.name), el('span', '', fmtSize(f.size)));
    const del = el('button', '', '×');
    del.title = '移除';
    del.addEventListener('click', () => { state.pending.splice(i, 1); renderPending(); });
    chip.appendChild(del);
    els.pending.appendChild(chip);
  }
}

async function readFileAsPart(file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const mime = file.type || 'application/octet-stream';
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : null;
  if (!kind) throw new Error(`无法识别的文件类型：${file.name}`);
  return { type: kind, attachment: { kind, name: file.name, mime, size: file.size, data } };
}

function createStreamingBubble() {
  const row = el('div', 'row assistant');
  const wrap = el('div', 'bubble-wrap');
  const bubble = el('div', 'bubble');
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  els.messages.appendChild(row);
  return { row, bubble };
}

async function send() {
  if (state.sending) return;
  const text = els.input.value.trim();
  if (!text && state.pending.length === 0) return;

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const f of state.pending) parts.push(await readFileAsPart(f));

  state.sending = true;
  els.send.disabled = true;
  els.input.disabled = true;
  els.input.value = '';
  autoResize();
  state.pending = [];
  renderPending();
  const typing = showTyping();

  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ parts, stream: true }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      typing.remove();
      await refresh();
      return;
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      const body = await res.json().catch(() => null);
      typing.remove();
      if (body?.ok) {
        state.messages.push(body.userMessage, body.assistantMessage);
        els.empty.hidden = true;
        els.messages.appendChild(renderMessage(body.userMessage));
        els.messages.appendChild(renderMessage(body.assistantMessage));
        scrollToBottom();
      } else {
        toast(body?.error?.message ?? '请求失败');
        await refresh();
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let stream = null;
    let streamedText = '';
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        if (event === 'user') {
          state.messages.push(payload.message);
          els.empty.hidden = true;
          els.messages.appendChild(renderMessage(payload.message));
          scrollToBottom();
        } else if (event === 'delta') {
          if (!stream) { typing.remove(); stream = createStreamingBubble(); }
          streamedText += payload.delta ?? '';
          stream.bubble.textContent = streamedText;
          scrollToBottom();
        } else if (event === 'done') {
          typing.remove();
          const m = payload.message;
          state.messages.push(m);
          if (stream) {
            stream.bubble.textContent = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
            stream.row.querySelector('.bubble-wrap')?.appendChild(el('div', 'meta', fmtTime(m.time)));
          } else {
            els.messages.appendChild(renderMessage(m));
          }
          scrollToBottom();
          finished = true;
        } else if (event === 'error') {
          typing.remove();
          toast(payload.message ?? '模型调用失败');
          await refresh();
          finished = true;
        }
      }
    }
  } catch (e) {
    toast(`无法连接本地服务：${e?.message ?? e}`);
  } finally {
    state.sending = false;
    els.send.disabled = false;
    els.input.disabled = false;
    els.input.focus();
  }
}

async function refresh() {
  const [cfgRes, msgRes] = await Promise.all([fetch('/api/config').catch(() => null), fetch('/api/messages').catch(() => null)]);
  if (cfgRes?.ok) {
    state.config = await cfgRes.json().catch(() => null);
    if (state.config) {
      els.badge.textContent = state.config.transportLabel ?? state.config.transport ?? '通道';
      els.badge.title = state.config.note ?? '';
      els.sub.textContent = state.config.note ?? '独立会话 · 仅本机';
    }
  }
  if (msgRes?.ok) {
    const data = await msgRes.json().catch(() => null);
    if (data?.ok) { state.messages = data.messages; renderAll(); }
  }
}

function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 168)}px`;
}

els.send.addEventListener('click', send);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
els.input.addEventListener('input', autoResize);

els.file.addEventListener('change', async () => {
  const files = [...(els.file.files ?? [])];
  els.file.value = '';
  for (const f of files) {
    if (state.pending.length >= MAX_FILES) { toast(`附件最多 ${MAX_FILES} 个`); break; }
    if (f.size > MAX_FILE_BYTES) { toast(`「${f.name}」超过 12 MB 上限`); continue; }
    state.pending.push(f);
  }
  renderPending();
});

els.exportBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/export.txt';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('已导出完整 TXT（同时保存到窗口数据目录的 exports/）', 'info');
});

// 启动
autoResize();
refresh().catch((e) => toast(`初始化失败：${e?.message ?? e}`));