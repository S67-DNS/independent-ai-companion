// TranscriptExporter：独立聊天记录导出接口（窗口 MVP 的第三个稳定边界）。
// 当前实现：UTF-8 TXT（完整文本 + 附件元数据 + 本地路径）。未来可在同一接口下增加媒体打包格式。

import fs from 'node:fs';

const roleLabel = (role) => (role === 'assistant' ? '助手' : '用户');
const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtSize = (n) => `${Number(n).toLocaleString('en-US')} B`;

/** 生成完整 TXT 文本（不截断任何消息）。 */
export function renderTranscript({ messages, dataDir, transportLabel, exportedAt = new Date() }) {
  const lines = [];
  lines.push('本地窗口聊天记录');
  lines.push('='.repeat(48));
  lines.push(`导出时间：${fmtTime(exportedAt.toISOString())}`);
  lines.push(`消息总数：${messages.length}`);
  lines.push(`通信通道：${transportLabel ?? '未知'}`);
  lines.push(`窗口数据目录：${dataDir}`);
  lines.push('');
  lines.push('说明：这是本地窗口的独立聊天记录，不是 DSH 权威 Session；');
  lines.push('      不写入 memory.db，不修改人格或日记，不自动同步到任何平台。');
  lines.push('      附件原文件保存在上述数据目录的 media/ 下，TXT 只保留其本地路径。');
  lines.push('='.repeat(48));
  lines.push('');
  messages.forEach((m, i) => {
    lines.push(`[${i + 1}] ${fmtTime(m.time)}  ${roleLabel(m.role)}`);
    const texts = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text);
    if (texts.length === 0) lines.push('（无文字内容）');
    else lines.push(texts.join('\n'));
    for (const p of (m.parts ?? [])) {
      if (p.type === 'text') continue;
      const a = p.attachment ?? {};
      lines.push(`  · 附件[${a.kind}]：${a.name} | ${a.mime} | ${fmtSize(a.size)} | ${a.path}`);
    }
    lines.push('');
  });
  lines.push('='.repeat(48));
  lines.push('（导出结束）');
  return lines.join('\n') + '\n';
}

/** 导出并落盘，返回 { file, text }。 */
export function exportTxt(store, { messages, transportLabel, exportedAt = new Date() }) {
  const text = renderTranscript({ messages, dataDir: store.dataDir, transportLabel, exportedAt });
  const file = store.writeExport(text, exportedAt);
  return { file, text };
}