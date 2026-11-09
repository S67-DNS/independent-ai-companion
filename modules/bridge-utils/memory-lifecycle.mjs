export const PROMISE_STATUSES = Object.freeze(['open', 'done', 'cancelled']);
export const PROMISE_OPEN_LIMIT = 10;
export const PROMISE_SETTLED_LIMIT = 20;

export function normalizeSourceMid(value) {
  const mid = String(value ?? '').trim();
  return mid ? mid.slice(0, 128) : '';
}

function validTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 && time <= 8.64e15 ? time : 0;
}

function dueTime(value) {
  if (value === null) return null;
  const time = validTime(value);
  if (!time) throw new TypeError('dueAt 必须是绝对毫秒时间戳或 null');
  return time;
}

export function normalizePromise(value) {
  const createdAt = validTime(value?.createdAt);
  const status = PROMISE_STATUSES.includes(value?.status) ? value.status : 'open';
  const sourceMid = normalizeSourceMid(value?.sourceMid);
  const dueAt = validTime(value?.dueAt);
  const completedAt = validTime(value?.completedAt);
  const cancelledAt = validTime(value?.cancelledAt);
  return {
    text: String(value?.text ?? '').trim().slice(0, 200),
    createdAt,
    updatedAt: validTime(value?.updatedAt) || createdAt,
    status,
    revision: Math.max(1, Math.floor(Number(value?.revision) || 1)),
    ...(sourceMid ? { sourceMid } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(value?.previousText ? { previousText: String(value.previousText).slice(0, 200) } : {}),
    ...(status === 'done' && completedAt ? { completedAt } : {}),
    ...(status === 'cancelled' && cancelledAt ? { cancelledAt } : {})
  };
}

export function capPromises(values) {
  const list = Array.isArray(values) ? values : [];
  const keep = new Set([
    ...list.filter((p) => (p?.status ?? 'open') === 'open').slice(-PROMISE_OPEN_LIMIT),
    ...list.filter((p) => (p?.status ?? 'open') !== 'open').slice(-PROMISE_SETTLED_LIMIT)
  ]);
  return list.filter((p) => keep.has(p));
}

export function appendPromise(st, text, extra = {}, now = Date.now()) {
  if (!Array.isArray(st.promises)) st.promises = [];
  const promiseText = String(text ?? '').trim().slice(0, 200);
  const sourceMid = normalizeSourceMid(extra.sourceMid);
  const dueAt = extra.dueAt === undefined ? undefined : dueTime(extra.dueAt);
  const existing = st.promises.find((p) => (p?.status ?? 'open') === 'open' && String(p?.text ?? '') === promiseText);
  if (existing) {
    let changed = false;
    if (sourceMid && existing.sourceMid !== sourceMid) {
      existing.sourceMid = sourceMid;
      changed = true;
    }
    if (dueAt !== undefined && (existing.dueAt ?? null) !== dueAt) {
      if (dueAt === null) delete existing.dueAt;
      else existing.dueAt = dueAt;
      changed = true;
    }
    if (changed) {
      existing.updatedAt = now;
      existing.revision = Math.max(1, Number(existing.revision) || 1) + 1;
    }
    st.promises = capPromises(st.promises);
    return existing;
  }
  const entry = normalizePromise({
    text: promiseText,
    createdAt: now,
    updatedAt: now,
    status: 'open',
    revision: 1,
    ...(sourceMid ? { sourceMid } : {}),
    ...(dueAt ? { dueAt } : {})
  });
  st.promises.push(entry);
  st.promises = capPromises(st.promises);
  return entry;
}

export function updatePromise(entry, changes = {}, now = Date.now()) {
  const current = normalizePromise(entry);
  const draft = { ...entry };
  let changed = false;
  if (changes.newContent !== undefined) {
    const text = String(changes.newContent ?? '').trim().slice(0, 200);
    if (!text) throw new TypeError('承诺正文不能为空');
    if (text !== current.text) {
      draft.previousText = current.text;
      draft.text = text;
      changed = true;
    }
  }
  if (changes.status !== undefined) {
    if (!PROMISE_STATUSES.includes(changes.status)) throw new TypeError('status 只能是 open、done 或 cancelled');
    if (changes.status !== current.status) {
      draft.status = changes.status;
      delete draft.completedAt;
      delete draft.cancelledAt;
      if (changes.status === 'done') draft.completedAt = now;
      if (changes.status === 'cancelled') draft.cancelledAt = now;
      changed = true;
    }
  }
  if (changes.dueAt !== undefined) {
    const dueAt = dueTime(changes.dueAt);
    if ((current.dueAt ?? null) !== dueAt) {
      if (dueAt === null) delete draft.dueAt;
      else draft.dueAt = dueAt;
      changed = true;
    }
  }
  if (changes.sourceMid !== undefined) {
    const sourceMid = normalizeSourceMid(changes.sourceMid);
    if ((current.sourceMid ?? '') !== sourceMid) {
      if (sourceMid) draft.sourceMid = sourceMid;
      else delete draft.sourceMid;
      changed = true;
    }
  }
  if (changed) {
    draft.updatedAt = now;
    draft.revision = current.revision + 1;
    for (const key of Object.keys(entry)) delete entry[key];
    Object.assign(entry, draft);
  }
  return entry;
}

export function normalizeImpression(value) {
  const traits = Array.isArray(value?.traits) ? value.traits.map((trait) => String(trait).slice(0, 50)).filter(Boolean).slice(0, 20) : [];
  const rawSources = value?.traitSources && typeof value.traitSources === 'object' ? value.traitSources : {};
  const traitSources = Object.create(null);
  for (const trait of traits) {
    const sources = Array.isArray(rawSources[trait]) ? [...new Set(rawSources[trait].map(normalizeSourceMid).filter(Boolean))].slice(0, 8) : [];
    if (sources.length) traitSources[trait] = sources;
  }
  const rawUnsourced = Array.isArray(value?.unsourcedTraits) ? new Set(value.unsourcedTraits.map(String)) : null;
  const unsourcedTraits = traits.filter((trait) => rawUnsourced ? rawUnsourced.has(trait) : !traitSources[trait]);
  return {
    traits,
    ...(Object.keys(traitSources).length ? { traitSources } : {}),
    ...(unsourcedTraits.length ? { unsourcedTraits } : {}),
    interactionCount: Math.max(0, Number(value?.interactionCount) || 0),
    lastSeenAt: validTime(value?.lastSeenAt)
  };
}

export function reconcileRecalledMemory(st, mid) {
  const id = normalizeSourceMid(mid);
  if (!st || !id) return 0;
  let removed = 0;
  for (const field of ['activeTopics', 'pendingThoughts', 'promises']) {
    if (!Array.isArray(st[field])) continue;
    const before = st[field].length;
    st[field] = st[field].filter((entry) => normalizeSourceMid(entry?.sourceMid) !== id);
    removed += before - st[field].length;
  }
  if (!st.memberImpressions || typeof st.memberImpressions !== 'object') return removed;
  for (const [name, raw] of Object.entries(st.memberImpressions)) {
    const impression = normalizeImpression(raw);
    const traits = [];
    const traitSources = Object.create(null);
    const unsourced = new Set(impression.unsourcedTraits);
    for (const trait of impression.traits) {
      const sources = impression.traitSources?.[trait] ?? [];
      if (!sources.includes(id)) {
        traits.push(trait);
        if (sources.length) traitSources[trait] = sources;
        continue;
      }
      const remaining = sources.filter((source) => source !== id);
      if (remaining.length || unsourced.has(trait)) {
        traits.push(trait);
        if (remaining.length) traitSources[trait] = remaining;
      } else {
        unsourced.delete(trait);
        removed += 1;
      }
    }
    if (!traits.length && impression.traits.length) delete st.memberImpressions[name];
    else {
      impression.traits = traits;
      impression.traitSources = traitSources;
      impression.unsourcedTraits = [...unsourced].filter((trait) => traits.includes(trait));
      st.memberImpressions[name] = impression;
    }
  }
  return removed;
}
