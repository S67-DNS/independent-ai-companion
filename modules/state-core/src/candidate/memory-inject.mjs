// 记忆注入装配：把「还能信的」记忆条目拼成一段注入文本。
//
// 为什么这一层要独立并且纯函数：
//   注入是记忆进入模型上下文的最后一道闸门。它不能依赖调用方自觉——凡是 trust 不是
//   authority/trusted 的、或者读侧已经标了 externalChange 的，都在这里再挡一次。
//   纯函数（不碰 DB、不碰文件）让它能被离线单测，也保证同样的输入永远得到同样的文本。
//
// 排序为什么是 generation + relPath 双键：
//   只按 generation 排，同代条目顺序取决于调用方给的数组顺序，两次运行可能写出不同
//   的注入文本，破坏可复现性；用 relPath 做稳定兜底，输入顺序怎么打乱结果都一样。
//
// 截断为什么要显式标记：
//   超预算时静默丢弃或静默切一半，都会让模型把半句话当成完整记忆。必须留下
//   `[…截断…]`，让人和模型都能看出这里是断的，并且把没装下的条目标记成 over-budget。

import { CandidateError, ERR } from './errors.mjs';
import { TRUST } from './memory-provenance.mjs';

export const TRUNCATION_MARKER = '[…截断…]';
export const DEFAULT_MAX_CHARS = 6000;

const INJECTABLE_TRUST = new Set([TRUST.AUTHORITY, TRUST.TRUSTED]);

/** 稳定排序：generation 升序，同代按 relPath 升序（用码元比较，不受 locale 影响）。 */
function compareInjectionOrder(a, b) {
  const genA = Number(a.generation ?? 0);
  const genB = Number(b.generation ?? 0);
  if (genA !== genB) return genA - genB;
  const pathA = String(a.relPath);
  const pathB = String(b.relPath);
  if (pathA === pathB) return 0;
  return pathA < pathB ? -1 : 1;
}

function entryMeta(entry) {
  return {
    relPath: String(entry.relPath),
    generation: Number(entry.generation ?? 0),
    hash: String(entry.hash ?? ''),
    trust: entry.trust ?? null,
  };
}

function renderEntry(entry) {
  const hash12 = String(entry.hash ?? '').slice(0, 12);
  return `${entry.relPath} · generation ${Number(entry.generation ?? 0)} · trust ${String(entry.trust)} · sha256:${hash12}\n${entry.content}`;
}

/**
 * @param {{entries?: Array<object>, maxChars?: number, now?: () => number}} options
 * @returns {{text: string, included: Array<object>, rejected: Array<object>,
 *            truncated: boolean, usedChars: number, maxChars: number, builtAtMs: number}}
 */
export function buildInjection({ entries = [], maxChars = DEFAULT_MAX_CHARS, now = Date.now } = {}) {
  if (!Array.isArray(entries)) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'entries 必须是数组', { field: 'entries' });
  }
  const budget = Number(maxChars);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new CandidateError(ERR.INVALID_ARGUMENT, 'maxChars 必须是正数', { maxChars });
  }

  const rejected = [];
  const seenPaths = new Set();
  const candidates = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.relPath !== 'string' || entry.relPath === '') {
      rejected.push({ relPath: String(entry?.relPath ?? ''), reason: 'invalid-entry' });
      continue;
    }
    const relPath = entry.relPath;
    if (entry.trust === TRUST.UNTRUSTED) {
      rejected.push({ relPath, reason: 'untrusted', trust: entry.trust });
      continue;
    }
    if (entry.trust === TRUST.DRIFT) {
      rejected.push({ relPath, reason: 'drift', trust: entry.trust });
      continue;
    }
    if (!INJECTABLE_TRUST.has(entry.trust)) {
      rejected.push({ relPath, reason: 'unknown-trust', trust: entry.trust ?? null });
      continue;
    }
    // 读侧发现外部改动时会把 trust 判成 drift；这里再挡一次，防止调用方手工拼条目绕过。
    if (entry.externalChange === true) {
      rejected.push({ relPath, reason: 'external-change', trust: entry.trust });
      continue;
    }
    if (typeof entry.content !== 'string' || entry.content === '') {
      rejected.push({ relPath, reason: 'missing-content', trust: entry.trust });
      continue;
    }
    if (seenPaths.has(relPath)) {
      rejected.push({ relPath, reason: 'duplicate-path', trust: entry.trust });
      continue;
    }
    seenPaths.add(relPath);
    candidates.push(entry);
  }

  candidates.sort(compareInjectionOrder);

  let text = '';
  const included = [];
  let index = 0;
  for (; index < candidates.length; index += 1) {
    const entry = candidates[index];
    const block = renderEntry(entry);
    const separator = included.length > 0 ? '\n\n' : '';
    if (text.length + separator.length + block.length <= budget) {
      text += separator + block;
      included.push({ ...entryMeta(entry), truncated: false, chars: block.length });
      continue;
    }
    const available = budget - text.length - separator.length;
    if (available > TRUNCATION_MARKER.length + 1) {
      // 精确切到预算上限：剩余长度 - 标记 - 换行，让 text.length 恰好等于 maxChars。
      const keep = Math.min(block.length, available - TRUNCATION_MARKER.length - 1);
      text += separator + block.slice(0, keep) + '\n' + TRUNCATION_MARKER;
      included.push({ ...entryMeta(entry), truncated: true, chars: keep });
      index += 1;
    }
    // 预算连一个标记都放不下时，宁可一个条目都不加，也不写半句没有标记的残缺内容。
    break;
  }
  for (; index < candidates.length; index += 1) {
    rejected.push({ relPath: candidates[index].relPath, reason: 'over-budget', trust: candidates[index].trust });
  }

  const builtAtMs = Number(typeof now === 'function' ? now() : now);
  return {
    text,
    included,
    rejected,
    truncated: included.some((item) => item.truncated),
    usedChars: text.length,
    maxChars: budget,
    builtAtMs: Number.isFinite(builtAtMs) ? builtAtMs : Date.now(),
  };
}
