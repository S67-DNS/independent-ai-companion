// 本地窗口独立聊天记录存储：JSONL + 本地媒体目录 + 导出目录。
// 明确：这是窗口自己的记录，不是 DSH 权威 Session，不写 memory.db，不向任何平台同步。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STORE_VERSION = 1;

const rand = (n = 8) => crypto.randomBytes(n).toString('hex');

export function newMessageId(now = Date.now()) {
  return `msg_${now.toString(36)}_${rand(5)}`;
}

export function newAttachmentId(now = Date.now()) {
  return `att_${now.toString(36)}_${rand(5)}`;
}

function safeFileName(name, fallback) {
  const base = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return (base || fallback).slice(0, 120);
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.mediaDir = path.join(this.dataDir, 'media');
    this.exportDir = path.join(this.dataDir, 'exports');
    this.messagesFile = path.join(this.dataDir, 'messages.jsonl');
    this.metaFile = path.join(this.dataDir, 'window.json');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.mkdirSync(this.exportDir, { recursive: true });
    if (!fs.existsSync(this.metaFile)) {
      fs.writeFileSync(this.metaFile, JSON.stringify({ version: STORE_VERSION, createdAt: new Date().toISOString() }, null, 2), 'utf8');
    }
  }

  /** 读取全部消息（按写入顺序 = 时间顺序）。 */
  loadMessages() {
    if (!fs.existsSync(this.messagesFile)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.messagesFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* 跳过损坏行，不静默丢正常记录 */ }
    }
    return out;
  }

  appendMessage(message) {
    fs.appendFileSync(this.messagesFile, JSON.stringify(message) + '\n', 'utf8');
    return message;
  }

  /** 把附件 data（base64）落盘，返回带绝对路径的附件元数据。 */
  saveAttachment(part) {
    const kind = part.attachment.kind;
    const id = newAttachmentId();
    const fileName = `${id}-${safeFileName(part.attachment.name, `${kind}.bin`)}`;
    const abs = path.join(this.mediaDir, fileName);
    const buf = Buffer.from(part.attachment.data, 'base64');
    if (buf.byteLength !== part.attachment.size) {
      throw new Error(`附件大小不匹配：声明 ${part.attachment.size}，实际 ${buf.byteLength}`);
    }
    fs.writeFileSync(abs, buf);
    return {
      id, kind, mime: part.attachment.mime, name: part.attachment.name,
      size: buf.byteLength, path: abs, fileName, createdAt: new Date().toISOString(),
    };
  }

  /** 按附件 id 查绝对路径（仅允许 media 目录内）。 */
  findAttachmentPath(attachmentId) {
    for (const m of this.loadMessages()) {
      for (const p of m.parts ?? []) {
        if (p.type === 'text') continue;
        const a = p.attachment;
        if (a && a.id === attachmentId) {
          const resolved = path.resolve(a.path);
          if (resolved.startsWith(path.resolve(this.mediaDir) + path.sep) && fs.existsSync(resolved)) return { abs: resolved, meta: a };
        }
      }
    }
    return null;
  }

  writeExport(text, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const file = path.join(this.exportDir, `chat-${stamp}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  }
}