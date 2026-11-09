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
