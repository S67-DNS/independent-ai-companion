import crypto from 'node:crypto';
import { guardMcpSend } from '../security/outbound-policy.mjs';

export function stableArgs(args) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]));
  };
  return JSON.stringify(walk(args ?? {}));
}

/**
 * MCP send takeover. It is explicit-only, denies QQ send tools under the current
 * activation policy, deduplicates identical calls, and never calls a transport itself.
 */
export function createMcpSendTakeover({ config, forward = async () => ({ ok: true, forwarded: false }), now = () => Date.now() } = {}) {
  const seen = new Map();
  async function handle(tool, args = {}) {
    const key = `${tool}:${stableArgs(args)}`;
    const prior = seen.get(key);
    if (prior) return { ok: true, deduped: true, tool, key, createdAt: prior.createdAt, forwarded: false };
    try {
      guardMcpSend(config, tool, args);
    } catch (e) {
      seen.set(key, { createdAt: now(), outcome: 'DENIED' });
      return { ok: false, denied: true, code: e.code, reason: e.decision?.reason ?? 'QQ_OUTBOUND_DISABLED', tool, key, forwarded: false };
    }
    const result = await forward(tool, args);
    seen.set(key, { createdAt: now(), outcome: 'FORWARDED' });
    return { ok: true, tool, key, forwarded: true, result };
  }
  function status() { return { entries: seen.size, outbound: 'DISABLED' }; }
  return { handle, status };
}

export function makeCorrelationId(prefix = 'mcp') {
  return `${prefix}-${crypto.randomUUID()}`;
}
