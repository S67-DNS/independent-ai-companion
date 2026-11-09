import crypto from 'node:crypto';
import { discoverDshSessionCookie } from 'file:///<WORKSPACE>/';
import { egressFetch } from '../host/outbound-egress.mjs';

const DEFAULT_BASE = 'http://127.0.0.1:52311';
export const READONLY_RPC_METHODS = Object.freeze(['session/projections', 'session/page']);

export function createFormalDshReadOnly({ base = DEFAULT_BASE, allowTestTarget = false } = {}) {
  if (allowTestTarget) {
    // 显式登记测试目标；生产 DSH 地址不会被这里默认登记。
    // （测试目标登记由调用方/测试显式完成，Guard 不接受未登记目标。）
  }
  const cookie = discoverDshSessionCookie(base);
  if (!cookie) throw new Error('DSH session cookie could not be minted; read-only attach not attempted');
  async function rpc(method, args, timeoutMs = 5000) {
    if (!READONLY_RPC_METHODS.includes(String(method))) {
      throw new Error(`FORMAL_DSH_READONLY_METHOD_FORBIDDEN: ${method}`);
    }
    const response = await egressFetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }, { label: 'formal-dsh-readonly' });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, ok: body?.result?.ok ?? false, value: body?.result?.value ?? null, body: body ?? text };
  }
  async function projections(sessionId) {
    const r = await rpc('session/projections', { request: { sessionId } });
    return { status: r.status, ok: r.ok, asOfSeq: r.value?.asOfSeq ?? null, value: r.value, body: r.body };
  }
  async function page(sessionId, throughSeq, maxMessages = 50) {
    const r = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages } });
    return { status: r.status, ok: r.ok, value: r.value, body: r.body };
  }
  return { base, cookieMinted: true, projections, page, rpc };
}

export function compactionEventsFromPage(pageValue) {
  const records = Array.isArray(pageValue?.records) ? pageValue.records : [];
  return records.map((r) => r.event).filter((e) => e && String(e.type).startsWith('compaction/'));
}
