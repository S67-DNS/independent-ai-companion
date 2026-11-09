import crypto from 'node:crypto';
import { NodeApiClient, createTurnCollector } from 'file:///<WORKSPACE>/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDshPrompt({ base = 'http://127.0.0.1:52311', sessionId, timeoutMs = 180000 } = {}) {
  const api = new NodeApiClient(base, 30000, { token: '', tokenExplicit: false, allowRemote: false });
  async function snapshot() {
    const proj = await api.callUnary('session/projections', { sessionId });
    if (!proj.result?.ok) throw new Error(`projections failed: ${proj.result?.error?.code ?? 'unknown'}`);
    const asOfSeq = proj.result.value?.asOfSeq;
    // session/page 的参数名已经是 request；callUnary 会再包装成 args.request。
    // 不能再传 { request: ... }，否则 DSH 会报 gateway/input-invalid（request 字段校验失败）。
    const page = await api.callUnary('session/page', { address: { kind: 'session', sessionId }, throughSeq: asOfSeq, maxMessages: 200 });
    if (!page.result?.ok) throw new Error(`session page failed: ${page.result?.error?.code ?? 'unknown'}`);
    const records = page.result?.value?.records ?? [];
    const events = records.map((r) => r.event).filter(Boolean);
    const turns = events.map((e) => Number(e.data?.turn)).filter(Number.isFinite);
    return { asOfSeq, events, maxTurn: turns.length ? Math.max(...turns) : 0 };
  }
  async function prompt(text) {
    if (process.env.OPENCORE_ALLOW_PERSONA_DSH !== '1') throw new Error('PERSONA_ACTIVATION_DISABLED: formal DSH prompt requires explicit commander authorization');
    if (typeof text !== 'string' || !text.trim()) throw new Error('prompt text required');
    const before = await snapshot();
    const requestId = 'internal-' + crypto.randomUUID();
    const accepted = await api.callUnary('session/prompt', {
      sessionId, mode: 'queue', requestId,
      content: [{ type: 'text', text }],
    });
    if (!accepted.result?.ok) return { ok: false, accepted: false, requestId, error: accepted.result?.error ?? null };
    const collector = createTurnCollector();
    const deadline = Date.now() + timeoutMs;
    let lastSeq = before.asOfSeq;
    while (Date.now() < deadline) {
      await sleep(1500);
      const now = await snapshot();
      for (const event of now.events) {
        const turn = Number(event.data?.turn);
        if (!Number.isFinite(turn) || turn <= before.maxTurn) continue;
        const ended = collector.push(event);
        if (ended) {
          return {
            ok: ended.reason?.kind === 'completed' && Boolean(ended.text?.trim()),
            accepted: true, requestId, turn: ended.turn,
            text: ended.text ?? '', reason: ended.reason ?? null,
            asOfSeq: now.asOfSeq,
          };
        }
      }
      lastSeq = now.asOfSeq;
      if (now.maxTurn > before.maxTurn && !collector.size) {
        // turn/end may be in this same page and collector already ended; handled above.
      }
    }
    return { ok: false, accepted: true, requestId, timeout: true, asOfSeq: lastSeq, reason: { kind: 'timeout' } };
  }
  return { prompt, snapshot };
}
