// 本地窗口隔离验收测试：临时目录 + 本地 Mock API / 本地假 OpenAI 端点。
// 不连接真实 DSH、真实 API、QQ、OneBot、NapCat、AstrBot。
// 运行：node local-window/tests/run.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'server.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra).slice(0, 400)}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lw-${tag}-`));
}

function writeConfig(dir, cfg) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  return file;
}

function startServer({ configDir, dataDir, port = 0 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LOCAL_WINDOW_CONFIG: path.join(configDir, 'config.json'), LOCAL_WINDOW_DATA: dataDir, LOCAL_WINDOW_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server 启动超时：${err || out}`)), 15000);
    child.stdout.on('data', (b) => {
      out += b.toString();
      const m = out.match(/LOCAL_WINDOW_READY (\{.*\})/);
      if (m) {
        clearTimeout(timer);
        const info = JSON.parse(m[1]);
        resolve({ child, info, dataDir, base: `http://127.0.0.1:${info.port}` });
      }
    });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server 提前退出 code=${code} ${err}`)); });
  });
}

async function stopServer(s) {
  if (!s?.child || s.child.killed) return;
  s.child.kill();
  await new Promise((r) => s.child.once('exit', r));
}

const getJson = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body, text, headers: res.headers };
};

async function postJson(url, obj) {
  return getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
}

function sseEvents(text) {
  return text.split('\n\n').filter(Boolean).map((raw) => {
    let event = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    let payload = null;
    try { payload = JSON.parse(data); } catch { /* ignore */ }
    return { event, payload };
  });
}

// 1x1 PNG、最简 WAV、最简 MP4 字节
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(20), Buffer.alloc(200)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(120)]);
const b64 = (b) => b.toString('base64');
const attachmentPart = (kind, mime, name, buf) => ({ type: kind, attachment: { kind, mime, name, size: buf.length, data: b64(buf) } });

async function main() {
  const work = tmpDir('main');
  const cfgDir = path.join(work, 'cfg'); fs.mkdirSync(cfgDir);
  const dataDir = path.join(work, 'data'); fs.mkdirSync(dataDir);
  writeConfig(cfgDir, {
    transport: 'mock',
    model: { name: 'mock-model', maxContextTokens: 128000, mockCapabilities: { image: true, audio: true, video: true } },
    listen: { port: 0 },
  });
  const s = await startServer({ configDir: cfgDir, dataDir });
  try {
    // T1 启动与配置
    const health = await getJson(`${s.base}/api/health`);
    ok('T1 服务健康', health.status === 200 && health.body?.ok === true && health.body?.transport === 'mock');
    const cfg = await getJson(`${s.base}/api/config`);
    ok('T1 配置通道为 mock 且暴露能力', cfg.status === 200 && cfg.body?.transport === 'mock' && cfg.body?.capabilities?.text === true);
    ok('T1 配置不含密钥字段', !JSON.stringify(cfg.body).includes('apiKey') && !JSON.stringify(cfg.body).includes('secret'));

    // T2 静态页面
    const html = await getJson(`${s.base}/`);
    ok('T2 首页可打开', html.status === 200 && html.text.includes('本地窗口'));
    const css = await getJson(`${s.base}/app.css`);
    ok('T2 样式可加载', css.status === 200 && css.text.includes('--blue'));

    // T3 首轮文字发送与回显
    const r1 = await postJson(`${s.base}/api/messages`, { parts: [{ type: 'text', text: '你好，第一轮' }] });
    ok('T3 首轮发送成功', r1.status === 200 && r1.body?.ok === true);
    ok('T3 回复来自 Mock 且含轮次', r1.body?.assistantMessage?.parts?.[0]?.text?.includes('第 1 轮'));
    const m1 = await getJson(`${s.base}/api/messages`);
    ok('T3 首轮落盘 2 条且顺序正确', m1.body?.count === 2 && m1.body.messages[0].role === 'user' && m1.body.messages[1].role === 'assistant');

    // T4 多轮上下文完整（不因新消息丢历史）
    const r2 = await postJson(`${s.base}/api/messages`, { parts: [{ type: 'text', text: '第二轮' }] });
    ok('T4 第二轮上下文含 3 条', r2.body?.assistantMessage?.parts?.[0]?.text?.includes('上下文共 3 条消息'));
    const r3 = await postJson(`${s.base}/api/messages`, { parts: [{ type: 'text', text: '第三轮' }] });
    ok('T4 第三轮上下文含 5 条', r3.body?.assistantMessage?.parts?.[0]?.text?.includes('上下文共 5 条消息'));
    const m3 = await getJson(`${s.base}/api/messages`);
    ok('T4 三顺序连续', m3.body?.count === 6 && eq(m3.body.messages.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']));

    // T5 附件：三种类型保存 + 元数据 + 媒体可读取
    const r4 = await postJson(`${s.base}/api/messages`, {
      parts: [
        { type: 'text', text: '带附件的一条' },
        attachmentPart('image', 'image/png', 'pixel.png', PNG),
        attachmentPart('audio', 'audio/wav', 'voice.wav', WAV),
        attachmentPart('video', 'video/mp4', 'clip.mp4', MP4),
      ],
    });
    ok('T5 附件消息发送成功', r4.status === 200 && r4.body?.ok === true);
    const saved = r4.body?.userMessage?.parts?.filter((p) => p.type !== 'text') ?? [];
    ok('T5 三类附件均保存', saved.length === 3 && eq(saved.map((p) => p.type), ['image', 'audio', 'video']));
    const metaOk = saved.every((p) => p.attachment?.id && p.attachment?.mime && p.attachment?.name && p.attachment?.size > 0 && p.attachment?.path);
    ok('T5 附件元数据完整（id/mime/name/size/path）', metaOk, saved);
    const onDisk = saved.every((p) => fs.existsSync(p.attachment.path) && fs.statSync(p.attachment.path).size === p.attachment.size);
    ok('T5 附件文件真实落盘且大小一致', onDisk);
    const media = await fetch(`${s.base}/media/${saved[0].attachment.id}`);
    const mediaBuf = Buffer.from(await media.arrayBuffer());
    ok('T5 /media 返回原图字节', media.status === 200 && mediaBuf.equals(PNG) && media.headers.get('content-type') === 'image/png');

    // T6 流式回复
    const streamRes = await fetch(`${s.base}/api/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text: '流式测试' }], stream: true }),
    });
    ok('T6 流式响应为 text/event-stream', streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'));
    const events = sseEvents(await streamRes.text());
    const evNames = events.map((e) => e.event);
    ok('T6 流式事件含 user/delta/done', evNames.includes('user') && evNames.includes('delta') && evNames.includes('done'), evNames);
    const doneMsg = events.find((e) => e.event === 'done')?.payload?.message;
    const deltaText = events.filter((e) => e.event === 'delta').map((e) => e.payload?.delta ?? '').join('');
    ok('T6 流式拼接等于最终文本', doneMsg && deltaText === doneMsg.parts[0].text);
    ok('T6 流式回合已落盘', (await getJson(`${s.base}/api/messages`)).body?.count === 10);

    // T7 TXT 导出：完整、含角色/附件/路径
    const exp = await fetch(`${s.base}/api/export.txt`);
    const txt = await exp.text();
    ok('T7 导出 HTTP 200 且为 text/plain', exp.status === 200 && (exp.headers.get('content-type') ?? '').includes('text/plain'));
    ok('T7 导出含 10 条消息', (txt.match(/^\[\d+\] /gm) ?? []).length === 10, (txt.match(/^\[\d+\] /gm) ?? []).length);
    ok('T7 导出含角色标识', txt.includes('用户') && txt.includes('助手'));
    ok('T7 导出含附件元数据与本地路径', txt.includes('pixel.png') && txt.includes('image/png') && txt.includes(saved[0].attachment.path));
    ok('T7 导出含边界声明', txt.includes('不是 DSH 权威 Session') && txt.includes('不写入 memory.db'));
    const expFiles = fs.readdirSync(path.join(dataDir, 'exports'));
    ok('T7 导出文件落盘', expFiles.length === 1 && expFiles[0].endsWith('.txt'));

    // T8 重启后记录完整（关闭窗口/重新打开）
    const before = (await getJson(`${s.base}/api/messages`)).body;
    await stopServer(s);
    const s2 = await startServer({ configDir: cfgDir, dataDir });
    try {
      const after = await getJson(`${s2.base}/api/messages`);
      ok('T8 重启后消息完整', after.body?.count === before.count && eq(after.body.messages.map((m) => m.id), before.messages.map((m) => m.id)));
    } finally { await stopServer(s2); }
  } finally {
    if (!s.child.killed) await stopServer(s);
  }

  // T9 不支持的多模态：必须明确报错（不静默丢弃）
  {
    const dir = tmpDir('caps'); const cfg = path.join(dir, 'cfg'); fs.mkdirSync(cfg); const data = path.join(dir, 'data'); fs.mkdirSync(data);
    writeConfig(cfg, { transport: 'mock', model: { name: 'mock', maxContextTokens: 128000 } });
    const s3 = await startServer({ configDir: cfg, dataDir: data });
    try {
      const r = await postJson(`${s3.base}/api/messages`, { parts: [attachmentPart('image', 'image/png', 'x.png', PNG)] });
      ok('T9 不支持的图片被明确拒绝', r.status === 422 && r.body?.error?.code === 'transport/unsupported-part', r.body);
      const still = await getJson(`${s3.base}/api/messages`);
      ok('T9 被拒绝的消息未静默入库', still.body?.count === 0);
    } finally { await stopServer(s3); }
  }

  // T10 上下文超限：明确报错，不静默截断
  {
    const dir = tmpDir('ctx'); const cfg = path.join(dir, 'cfg'); fs.mkdirSync(cfg); const data = path.join(dir, 'data'); fs.mkdirSync(data);
    writeConfig(cfg, { transport: 'mock', model: { name: 'mock', maxContextTokens: 40 } });
    const s4 = await startServer({ configDir: cfg, dataDir: data });
    try {
      const long = '这是一段很长的文字。'.repeat(40);
      const r = await postJson(`${s4.base}/api/messages`, { parts: [{ type: 'text', text: long }] });
      ok('T10 超上下文明确 413', r.status === 413 && r.body?.error?.code === 'context/too-long', r.body);
      const rec = await getJson(`${s4.base}/api/messages`);
      ok('T10 超限消息保留为 failed 记录', rec.body?.count === 1 && rec.body.messages[0].status === 'failed');
    } finally { await stopServer(s4); }
  }

  // T11 模型接口不可用：明确错误
  {
    const dir = tmpDir('down'); const cfg = path.join(dir, 'cfg'); fs.mkdirSync(cfg); const data = path.join(dir, 'data'); fs.mkdirSync(data);
    writeConfig(cfg, { transport: 'openai', openai: { baseURL: 'http://127.0.0.1:1/v1', model: 'test-model', apiKey: 'sk-placeholder', supports: { image: false } } });
    const s5 = await startServer({ configDir: cfg, dataDir: data });
    try {
      const r = await postJson(`${s5.base}/api/messages`, { parts: [{ type: 'text', text: '接口挂了会怎样' }] });
      ok('T11 接口不可用返回 502', r.status === 502 && r.body?.error?.code === 'transport/unreachable', r.body);
      const c2 = await getJson(`${s5.base}/api/config`);
      ok('T11 配置接口不泄露密钥', !c2.text.includes('sk-placeholder'), c2.text.slice(0, 200));
    } finally { await stopServer(s5); }
  }

  // T12 依赖与端点扫描
  {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mjs|js|html|css)$/.test(e.name)) files.push(p); } };
    walk(ROOT);
    const forbiddenImports = /^(?:qq|onebot|napcat|astrbot|snowluma|dsh-client|dsh-base)/i;
    const bad = [];
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/(?:from|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) if (forbiddenImports.test(m[1])) bad.push(`${path.relative(ROOT, f)} -> ${m[1]}`);
      for (const m of t.matchAll(/127\.0\.0\.1:(3000|3001|3100|50190)\b/g)) bad.push(`${path.relative(ROOT, f)} -> ${m[0]}`);
    }
    ok('T12 无平台/DSH 依赖与端点', bad.length === 0, bad);
  }

  console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log('失败项：', failures.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => { console.error('测试崩溃：', e); process.exitCode = 1; });