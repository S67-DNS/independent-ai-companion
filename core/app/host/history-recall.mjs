import fsDefault from 'node:fs';
import pathDefault from 'node:path';

export function normalizeHistoryText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function historyTokens(value) {
  const tokens = [];
  const source = normalizeHistoryText(value);
  for (const word of source.match(/[a-z0-9_]+/g) ?? []) tokens.push(word);
  for (const run of source.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function historyTime(value, name) {
  if (value === undefined || value === null || value === '') return null;
  let result;
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    result = Number(value);
  } else {
    const text = String(value).trim();
    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const month = Number(dateOnly[2]);
      const day = Number(dateOnly[3]);
      const date = new Date(year, month - 1, day);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        throw new TypeError(`${name} 不是有效日期`);
      }
      result = date.getTime();
    } else {
      result = Date.parse(text);
    }
  }
  if (!Number.isFinite(result) || result < 0 || result > 8.64e15) throw new TypeError(`${name} 不是有效时间`);
  return result;
}

export function normalizeHistoryOptions(input = {}) {
  const after = historyTime(input.after, 'after');
  const before = historyTime(input.before, 'before');
  if (after !== null && before !== null && after >= before) throw new TypeError('after 必须早于 before');
  let self = null;
  if (input.self !== undefined && input.self !== null && input.self !== '') {
    if (input.self === true || input.self === 'true') self = true;
    else if (input.self === false || input.self === 'false') self = false;
    else throw new TypeError('self 只能是 true 或 false');
  }
  const rawContext = input.context === undefined || input.context === null || input.context === '' ? 0 : Number(input.context);
  if (!Number.isInteger(rawContext) || rawContext < 0 || rawContext > 2) throw new TypeError('context 只能是 0、1 或 2');
  return {
    after,
    before,
    self,
    sender: normalizeHistoryText(input.sender),
    context: rawContext
  };
}

function historyResult(doc) {
  return {
    t: doc.t,
    self: doc.self,
    sender: doc.sender,
    kind: doc.kind,
    text: doc.text,
    ...(doc.mid ? { mid: doc.mid } : {}),
    truncated: doc.truncated
  };
}

export function searchHistoryDocs(docs, query, limit = 5, rawOptions = {}) {
  const all = Array.isArray(docs) ? docs : [];
  const options = normalizeHistoryOptions(rawOptions);
  const candidates = all.filter((doc) => {
    if (options.after !== null && !(doc.t >= options.after)) return false;
    if (options.before !== null && !(doc.t < options.before)) return false;
    if (options.self !== null && doc.self !== options.self) return false;
    if (options.sender && normalizeHistoryText(doc.sender) !== options.sender) return false;
    return true;
  });
  const qTokens = [...new Set(historyTokens(query))];
  const total = all.length;
  if (!qTokens.length || !candidates.length) return { total, filtered: candidates.length, matched: 0, results: [] };
  const phrase = normalizeHistoryText(query);
  const qSet = new Set(qTokens);
  const df = new Map();
  for (const doc of candidates) {
    const seen = new Set(doc.tokens);
    for (const term of qSet) if (seen.has(term)) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = candidates.length;
  const avgdl = candidates.reduce((sum, doc) => sum + doc.tokens.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;
  const scored = [];
  for (const doc of candidates) {
    const dl = doc.tokens.length || 1;
    const tf = new Map();
    for (const term of doc.tokens) if (qSet.has(term)) tf.set(term, (tf.get(term) || 0) + 1);
    if (!tf.size) continue;
    let score = 0;
    for (const [term, count] of tf) {
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (count * (k1 + 1)) / (count + k1 * (1 - b + b * dl / avgdl));
    }
    const normalized = doc.normalized ?? normalizeHistoryText(doc.text);
    if (phrase.length >= 2 && normalized.includes(phrase)) score += 2 + Math.min(phrase.length, 32) / 32;
    if (score > 0) scored.push({ doc, score });
  }
  scored.sort((a, b2) => b2.score - a.score || b2.doc.t - a.doc.t || a.doc.position - b2.doc.position);
  const indexByDoc = new Map(all.map((doc, index) => [doc, index]));
  const take = Math.min(20, Math.max(1, Number(limit) || 5));
  const results = scored.slice(0, take).map(({ doc, score }) => {
    const item = { ...historyResult(doc), score: Math.round(score * 1000) / 1000 };
    if (options.context > 0) {
      const before = [];
      const after = [];
      const index = indexByDoc.get(doc);
      for (let offset = options.context; offset >= 1; offset -= 1) {
        const neighbor = all[index - offset];
        if (neighbor) before.push(historyResult(neighbor));
      }
      for (let offset = 1; offset <= options.context; offset += 1) {
        const neighbor = all[index + offset];
        if (neighbor) after.push(historyResult(neighbor));
      }
      item.context = { before, after };
    }
    return item;
  });
  return { total, filtered: N, matched: scored.length, results };
}

// ── L2 append-only archive（端口自 src/bridge.js:12260-12434 的语义） ───────────
export const HISTORY_RETENTION_DAYS = 90;
export const HISTORY_MAX_LINES = 20000;
export const HISTORY_TEXT_MAX_CHARS = 300;

export function safeHistoryKey(key) {
  const safe = String(key ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return safe || 'unknown';
}

export function historyFilePath(historyDir, key) {
  return `${String(historyDir).replace(/[\\/]+$/, '')}/${safeHistoryKey(key)}.jsonl`;
}

function fsSafeTruncate(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) {
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}

/**
 * L2 归档：只追加，不重写历史行；写入前 redact；正文 300 字；tombstone 同行格式。
 * 读侧把 tombstone 行与同 mid 的历史行一起过滤掉，context 邻居也来自过滤后的 docs。
 */
export function createHistoryArchive({
  historyDir,
  fs = null,
  redact = (text) => String(text ?? ''),
  now = () => Date.now(),
  logger = () => {},
} = {}) {
  if (!historyDir) throw new Error('historyDir required');
  const nodeFs = fs ?? fsDefault;
  const dir = pathDefault.resolve(historyDir);
  const fileFor = (key) => pathDefault.join(dir, `${safeHistoryKey(key)}.jsonl`);

  function appendEntry(key, entry) {
    const original = redact(String(entry?.text ?? entry?.plain ?? '')).trim();
    const text = fsSafeTruncate(original, HISTORY_TEXT_MAX_CHARS);
    if (!text) return { appended: false, reason: 'empty' };
    const mid = entry?.mid != null ? String(entry.mid) : (entry?.messageId != null ? String(entry.messageId) : '');
    const line = JSON.stringify({
      t: Number(entry?.time ?? entry?.at) || Number(now()),
      self: entry?.isSelf === true,
      sender: fsSafeTruncate(String(entry?.sender ?? ''), 40),
      kind: String(entry?.kind || (entry?.sticker ? 'sticker' : entry?.hasMedia ? 'media' : 'text')).slice(0, 12),
      text,
      ...(Array.from(original).length > Array.from(text).length ? { truncated: true } : {}),
      ...(mid ? { mid } : {}),
    });
    try {
      nodeFs.mkdirSync(dir, { recursive: true });
      nodeFs.appendFileSync(fileFor(key), line + '\n', 'utf8');
      return { appended: true, truncated: line.includes('"truncated":true'), mid: mid || null };
    } catch (error) {
      logger(`[history] 归档失败 ${key}: ${error?.message ?? error}`);
      return { appended: false, reason: String(error?.message ?? error) };
    }
  }

  function appendRecall(key, mid) {
    const id = String(mid ?? '').trim();
    if (!id) return { appended: false, reason: 'empty-mid' };
    const file = fileFor(key);
    try {
      nodeFs.statSync(file);
      nodeFs.mkdirSync(dir, { recursive: true });
      nodeFs.appendFileSync(file, JSON.stringify({ t: Number(now()), recall: id }) + '\n', 'utf8');
      return { appended: true, tombstone: id };
    } catch (error) {
      if (error?.code !== 'ENOENT') logger(`[history] 撤回对账失败 ${key}: ${error?.message ?? error}`);
      return { appended: false, reason: error?.code === 'ENOENT' ? 'no-history-file' : String(error?.message ?? error) };
    }
  }

  function loadDocs(key) {
    const file = fileFor(key);
    let stat = null;
    try { stat = nodeFs.statSync(file); } catch { return []; }
    const docs = [];
    try {
      const entries = [];
      for (const line of nodeFs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
      const recalled = new Set();
      for (const entry of entries) if (entry?.recall != null) recalled.add(String(entry.recall));
      for (const [position, entry] of entries.entries()) {
        if (entry?.recall != null) continue;
        const text = String(entry?.text ?? '').trim();
        if (!text) continue;
        if (recalled.size && entry.mid != null && recalled.has(String(entry.mid))) continue;
        docs.push({
          position,
          t: Number(entry.t) || 0,
          self: entry.self === true,
          sender: String(entry.sender ?? ''),
          kind: String(entry.kind ?? 'text'),
          text,
          ...(entry.mid != null && String(entry.mid) ? { mid: String(entry.mid) } : {}),
          truncated: entry.truncated === true ? true : (entry.truncated === undefined && Array.from(text).length >= HISTORY_TEXT_MAX_CHARS ? null : false),
          tokens: historyTokens(text),
        });
      }
    } catch { return []; }
    void stat;
    return docs;
  }

  function search(key, query, limit = 5, options = {}) {
    return searchHistoryDocs(loadDocs(key), query, limit, options);
  }

  /** 90 天 / 20,000 行裁剪：独立动作，只在显式调用/定时任务里执行。 */
  function prune({ retentionDays = HISTORY_RETENTION_DAYS, maxLines = HISTORY_MAX_LINES } = {}) {
    let names = [];
    try { names = nodeFs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')); } catch { return { prunedFiles: 0, removedLines: 0 }; }
    const cutoff = Number(now()) - Number(retentionDays) * 24 * 60 * 60 * 1000;
    let prunedFiles = 0; let removedLines = 0;
    for (const name of names) {
      const file = pathModule.join(dir, name);
      let lines = [];
      try { lines = nodeFs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
      const kept = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (Number(entry?.t) >= cutoff) kept.push(line);
        } catch { /* drop malformed */ }
      }
      const trimmed = kept.length > maxLines ? kept.slice(-maxLines) : kept;
      if (trimmed.length === lines.length) continue;
      try {
        const tmp = `${file}.tmp`;
        nodeFs.writeFileSync(tmp, trimmed.length ? trimmed.join('\n') + '\n' : '', 'utf8');
        nodeFs.renameSync(tmp, file);
        prunedFiles += 1;
        removedLines += lines.length - trimmed.length;
      } catch (error) {
        logger(`[history] 裁剪失败 ${name}: ${error?.message ?? error}`);
      }
    }
    return { prunedFiles, removedLines };
  }

  return { dir, fileFor, appendEntry, appendRecall, loadDocs, search, prune };
}

