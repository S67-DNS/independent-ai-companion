// MessagePart：统一消息内容与多模态附件结构（窗口 MVP 的稳定边界之一）
// 结构：{ type: 'text', text } | { type: 'image'|'audio'|'video', attachment: {...} }
// 附件元数据：{ id, kind, mime, name, size, path, createdAt }

export const PART_KINDS = Object.freeze(['text', 'image', 'audio', 'video']);
export const ROLE_KINDS = Object.freeze(['user', 'assistant']);

const MIME_RULES = {
  image: [/^image\/(png|jpeg|webp|gif)$/i],
  audio: [/^audio\/(mpeg|wav|ogg|webm|mp4|x-m4a|aac)$/i],
  video: [/^video\/(mp4|webm|quicktime|x-matroska)$/i],
};

export const MAX_TEXT_CHARS = 200_000;
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const MAX_BODY_BYTES = 48 * 1024 * 1024;

export class PartError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'PartError';
    this.code = code;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 校验并规范化一条 text part。 */
export function normalizeTextPart(part) {
  if (!isPlainObject(part) || part.type !== 'text') throw new PartError('part/invalid', 'text part 形状不正确', { part });
  const text = typeof part.text === 'string' ? part.text : '';
  if (!text.trim()) throw new PartError('part/empty-text', '文本不能为空白');
  if (text.length > MAX_TEXT_CHARS) throw new PartError('part/text-too-long', `单条文本过长（${text.length} > ${MAX_TEXT_CHARS} 字符）`);
  return { type: 'text', text };
}

/** 校验附件 part 的声明字段（文件落盘由 store 完成）。 */
export function normalizeAttachmentPart(part) {
  if (!isPlainObject(part) || !PART_KINDS.includes(part.type) || part.type === 'text') {
    throw new PartError('part/invalid', '附件 part 类型必须是 image/audio/video');
  }
  const kind = part.type;
  const meta = part.attachment ?? part;
  const mime = String(meta.mime ?? meta.type ?? '').trim();
  if (!mime) throw new PartError('part/mime-missing', '附件缺少 MIME 类型');
  if (!MIME_RULES[kind].some((re) => re.test(mime))) throw new PartError('part/mime-unsupported', `${kind} 不支持该 MIME：${mime}`, { kind, mime });
  const name = String(meta.name ?? '').trim() || `${kind}-${Date.now()}`;
  if (name.length > 200) throw new PartError('part/name-too-long', '附件名过长');
  const size = Number(meta.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) throw new PartError('part/size-invalid', '附件大小无效');
  if (size > MAX_ATTACHMENT_BYTES) throw new PartError('part/too-large', `附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`, { size });
  const data = String(meta.data ?? meta.base64 ?? '');
  if (!data) throw new PartError('part/data-missing', '附件缺少内容');
  if (data.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1024) throw new PartError('part/data-too-large', '附件内容超限');
  return { type: kind, attachment: { kind, mime, name, size, data } };
}

/** 校验整个 parts 数组：text 必填或至少一个附件；附件数量有限。 */
export function validateParts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new PartError('part/missing', '至少需要一个 text part 或附件');
  const parts = [];
  let attachments = 0;
  let hasText = false;
  for (const item of raw) {
    if (!isPlainObject(item)) throw new PartError('part/invalid', 'part 必须是对象');
    if (item.type === 'text') { parts.push(normalizeTextPart(item)); if (item.text.trim()) hasText = true; continue; }
    if (!PART_KINDS.includes(item.type)) throw new PartError('part/unknown-kind', `未知 part 类型：${item.type}`);
    attachments += 1;
    if (attachments > MAX_ATTACHMENTS) throw new PartError('part/too-many', `附件最多 ${MAX_ATTACHMENTS} 个`);
    parts.push(normalizeAttachmentPart(item));
  }
  if (!hasText && attachments === 0) throw new PartError('part/missing', '至少需要一个 text part 或附件');
  return parts;
}

/** 声明式判断：某 part 是否被当前 transport 能力支持。 */
export function unsupportedKinds(parts, capabilities) {
  const caps = capabilities ?? {};
  const bad = new Set();
  for (const p of parts) {
    if (p.type === 'text') continue;
    if (caps[p.type] !== true) bad.add(p.type);
  }
  return [...bad];
}

/** 估算 token（保守：CJK 约 1 字 1 token，ASCII 约 4 字符 1 token；附件按固定预算）。 */
export function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += 4;
    for (const p of m.parts ?? []) {
      if (p.type === 'text') {
        const s = p.text ?? '';
        let ascii = 0;
        let wide = 0;
        for (const ch of s) (ch.codePointAt(0) > 0x2e80 ? (wide += 1) : (ascii += 1));
        total += wide + Math.ceil(ascii / 4);
      } else {
        total += 600; // 图片/音视频的进程内预算（仅用于上下文上限检查）
      }
    }
  }
  return total;
}