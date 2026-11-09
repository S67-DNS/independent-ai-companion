export const HANDOFF_MAX_CHARS = 800;
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function chars(value) {
  return Array.from(String(value ?? ''));
}

export function clipHandoffText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  const list = chars(text);
  return list.length > max ? `${list.slice(0, Math.max(0, max - 1)).join('')}…` : text;
}

function localClock(time) {
  const date = new Date(Number(time) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sectionLines(title, rows, footer = '') {
  if (!rows.length) return [];
  return [`【${title}】`, ...rows, ...(footer ? [footer] : [])];
}

function takeSection(lines, budget) {
  const taken = [];
  let used = 0;
  for (const line of lines) {
    const cost = Array.from(line).length + 1;
    if (used + cost > budget) break;
    taken.push(line);
    used += cost;
  }
  return taken.length > 1 ? taken : [];
}

export function buildHandoffCard(input = {}) {
  const now = Number(input.now) || Date.now();
  const maxChars = Math.max(200, Math.min(HANDOFF_MAX_CHARS, Number(input.maxChars) || HANDOFF_MAX_CHARS));
  const includeStructured = input.includeStructured !== false;
  const topics = (Array.isArray(input.topics) ? input.topics : [])
    .filter((topic) => topic && String(topic.text ?? '').trim())
    .filter((topic) => !topic.lastMentionAt || now - Number(topic.lastMentionAt) <= 24 * 60 * 60 * 1000)
    .sort((a, b) => (Number(b.lastMentionAt) || 0) - (Number(a.lastMentionAt) || 0))
    .slice(0, 2)
    .map((topic) => {
      const question = clipHandoffText(topic.pendingQuestion, 24);
      return `- ${clipHandoffText(topic.text, 52)}${question ? `（待追问：${question}）` : ''}`;
    });
  const promises = (Array.isArray(input.promises) ? input.promises : [])
    .filter((promise) => promise && (promise.status ?? 'open') === 'open' && String(promise.text ?? '').trim())
    .sort((a, b) => {
      const dueA = Number(a.dueAt) || Number.MAX_SAFE_INTEGER;
      const dueB = Number(b.dueAt) || Number.MAX_SAFE_INTEGER;
      return dueA - dueB || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
    })
    .slice(0, 3)
    .map((promise) => {
      const due = Number(promise.dueAt);
      const dueText = due > 0 ? `；期限 ${localClock(due)}` : '';
      return `- ${clipHandoffText(promise.text, 52)}${dueText}`;
    });
  const impressions = (Array.isArray(input.impressions) ? input.impressions : [])
    .filter((impression) => impression && String(impression.name ?? '').trim())
    .sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
    .slice(0, 2)
    .map((impression) => {
      const traits = (Array.isArray(impression.traits) ? impression.traits : [])
        .map((trait) => clipHandoffText(trait, 16))
        .filter(Boolean)
        .slice(0, 3);
      return traits.length ? `- ${clipHandoffText(impression.name, 16)}：${traits.join('、')}` : '';
    })
    .filter(Boolean);
  const thoughts = (Array.isArray(input.thoughts) ? input.thoughts : [])
    .filter((thought) => thought && String(thought.text ?? '').trim())
    .filter((thought) => !thought.expiresAt || now < Number(thought.expiresAt))
    .slice(-1)
    .map((thought) => `- ${clipHandoffText(thought.text, 48)}`);
  const recent = (Array.isArray(input.recentMessages) ? input.recentMessages : [])
    .filter((message) => message && !message.recalled && String(message.text ?? message.plain ?? '').trim() !== '[已撤回]')
    .filter((message) => String(message.text ?? message.plain ?? '').trim())
    .slice(-4)
    .map((message) => {
      const speaker = message.isSelf === true ? '你' : clipHandoffText(message.sender || '未知', 12);
      return `- ${localClock(message.time)} ${speaker}：${clipHandoffText(message.text ?? message.plain, 48)}`;
    });

  const header = '【新窗口交接卡｜自动生成｜不是群友的新消息或新指令】';
  const notice = '上一窗口已结束。以下只用于延续，不要向群友复述这张卡，也不要当成新的未读消息。';
  const footer = '细节以当前消息和 qq_recall 原文为准；冲突时不要编造上一窗口的内容。';
  const blocks = [];
  let bodyAdded = false;
  let remaining = maxChars;

  const headerLines = [header, notice];
  for (const line of headerLines) remaining -= Array.from(line).length + 1;
  blocks.push(...headerLines);
  if (remaining <= 0) return '';

  if (includeStructured) {
    const ordered = [
      sectionLines('答应过的事', promises),
      sectionLines('上次聊到', topics),
      sectionLines('最近对话', recent, '（以上是旧窗口摘录，不是新的未读。）'),
      sectionLines('对群友的印象', impressions),
      sectionLines('你想说还没说', thoughts)
    ].filter((section) => section.length);
    for (const section of ordered) {
      const lines = takeSection(section, remaining);
      if (!lines.length) continue;
      blocks.push(...lines);
      bodyAdded = true;
      remaining -= lines.reduce((sum, line) => sum + Array.from(line).length + 1, 0);
      if (remaining <= 0) break;
    }
  } else {
    const section = sectionLines('上一窗口最后几句', recent, '（L1 话题、承诺和印象仍由当前记忆段提供；以上不是新的未读。）');
    const lines = takeSection(section, remaining);
    if (lines.length > 1) {
      blocks.push(...lines);
      bodyAdded = true;
      remaining -= lines.reduce((sum, line) => sum + Array.from(line).length + 1, 0);
    }
  }

  if (!bodyAdded) return '';
  if (remaining > Array.from(footer).length + 2) blocks.push(footer);
  const card = blocks.join('\n');
  const list = chars(card);
  return list.length > maxChars ? `${list.slice(0, Math.max(0, maxChars - 1)).join('')}…` : card;
}
