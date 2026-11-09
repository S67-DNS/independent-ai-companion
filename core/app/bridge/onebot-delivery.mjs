import fs from 'node:fs';
import { DEFAULT_ONEBOT_BASE } from '../shared/outbound-constants.mjs';
import { egressFetch } from '../host/outbound-egress.mjs';

/**
 * OneBot v11 HTTP delivery provider. It performs a network send only when its
 * send() method is explicitly called; no timer, no automatic dispatch.
 * The activation controller/dispatcher remains guarded.
 */
export function createOneBotDeliveryProvider({ base = DEFAULT_ONEBOT_BASE, token, fetchImpl = null } = {}) {
  if (!token) throw new Error('OneBot HTTP token is required');
  const doFetch = fetchImpl ?? ((url, init, label) => egressFetch(url, init, { label }));
  // P1 默认 none（沿用旧行为）。query 是可选能力，只有显式 env 开启；
  // 用于恢复 R2 的真实 HTTP 对账（测试 mock 可以挂起以覆盖 timeout）。
  const reconcileSupport = process.env.OPENCORE_ONEBOT_RECONCILE === 'query' ? 'query' : 'none';
  async function send({ delivery, partNo = 1 } = {}) {
    if (!delivery || delivery.channel !== 'qq') throw new Error('only qq delivery is supported');
    const m = /^private:(\d+)$/.exec(String(delivery.target ?? ''));
    if (!m) throw new Error('unsupported qq target; only private:<uin> is enabled');
    const text = String(delivery.payload?.text ?? delivery.payloadText ?? '');
    if (!text) throw new Error('empty delivery text');
    if (Number(partNo) !== 1) throw new Error('only single-part delivery is supported');
    const r = await doFetch(base + '/send_private_msg', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ user_id: Number(m[1]), message: [{ type: 'text', data: { text } }] }),
      signal: AbortSignal.timeout(15000),
    }, 'onebot-send');
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.status !== 'ok' || body.retcode !== 0) {
      return { ok: false, error: { httpStatus: r.status, retcode: body?.retcode ?? null, wording: body?.wording ?? null } };
    }
    return { ok: true, receipt: { messageId: body.data?.message_id ?? null, atMs: Date.now() } };
  }
  async function reconcile({ delivery = null, attempt = null } = {}) {
    if (reconcileSupport !== 'query') return 'unknown';
    try {
      const r = await doFetch(base + '/get_msg', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({
          deliveryId: delivery?.deliveryId ?? null,
          attemptId: attempt?.attemptId ?? null,
          target: delivery?.target ?? null,
        }),
        signal: AbortSignal.timeout(30000),
      }, 'onebot-reconcile');
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || body.status !== 'ok' || body.retcode !== 0) return 'unknown';
      if (body.data?.sent === true) return 'sent';
      if (body.data?.sent === false) return 'not-sent';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return { send, reconcile, reconcileSupport, transport: 'onebot-http', base };
}
