// 阶段 E：把 A/B/C/D 组合成一个可运行的候选服务。
//
// 目标不是「再抽象一层」，而是**把三条机制串成一条真实路径**，并且让每一条
// 安全不变量在集成层仍然成立：
//
//   入站：渠道消息 → (1) 绑定校验 → (2) 取 Writer Fence → (3) 事务内写会话事件
//                    → (4) 释放 fence。没有 fence 就没有写入口。
//   出站：agent 回复 → (5) 生成注入上下文（记忆必须通过 provenance 闸门）
//                    → (6) 入持久 Outbox → (7) claim → markSendStarted
//                    → (8) provider.send → ack / unknown_after_send。
//   恢复：进程重启 → (9) memory.reconcile() 标 drift → (10) outbox.recoverOrphans()
//                    → (11) 对不可对账的在途投递保持 unknown，绝不自动重发。
//
// 这一层**不冒充** DSH：它不实现 Agent Runtime、不调模型、不写 DSH 事件链。
// DSH 仍然是唯一 Runtime；这里做的是PROJECT_NAME控制面（身份/绑定/权限/记忆/投递/恢复）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CandidateError, ERR } from './errors.mjs';
import { openDb, tableCounts } from './db.mjs';
import { nowMs, sha256Hex, ensureDir } from './util.mjs';
import { createWriterFence } from './writer-fence.mjs';
import { createSessionWriter } from './session-write-gate.mjs';
import { createMemoryStore, TRUST } from './memory-provenance.mjs';
import { buildInjection } from './memory-inject.mjs';
import { createOutbox, DELIVERY_STATE } from './delivery-outbox.mjs';
import { createPresetRegistry, bindSession } from './preset-registry.mjs';
import { createIdentity } from './identity.mjs';
import { socialV2PolicyFingerprint } from './policy-fingerprint.mjs';

const IDENTITY_WRITER = (role) => `identity:${role}`;

/**
 * @param {{
 *   root: string,
 *   dbPath?: string,
 *   memoryRoot?: string,
 *   stateDir?: string,
 *   rolesDir?: string,
 *   presetsDir?: string,
 *   now?: () => number,
 *   leaseMs?: number,
 *   provider?: object,
 * }} options
 */
export function createCandidateService(options = {}) {
  const root = options.root;
  if (!root) throw new CandidateError(ERR.INVALID_ARGUMENT, 'createCandidateService 需要 root');
  const now = options.now ?? nowMs;
  const dbPath = options.dbPath ?? path.join(root, 'data', 'opencore.db');
  const memoryRoot = options.memoryRoot ?? path.join(root, 'data', 'memory');
  const stateDir = options.stateDir ?? path.join(root, 'state');
  const rolesDir = options.rolesDir ?? path.join(root, 'roles');
  const presetsDir = options.presetsDir ?? path.join(root, 'dsh', 'agent-presets');
  const leaseMs = options.leaseMs ?? 30_000;

  ensureDir(path.dirname(dbPath));
  ensureDir(memoryRoot);

  const db = openDb(dbPath, { busyTimeoutMs: 8000 });
  const fence = createWriterFence({ db, now, defaultLeaseMs: leaseMs });
  const writer = createSessionWriter({ db, fence, now });
  const memory = createMemoryStore({ root: memoryRoot, db, now });
  const outbox = createOutbox({ db, now, leaseMs: leaseMs * 4 });
  const presets = createPresetRegistry({ presetsDir, db, now });
  const identity = createIdentity({ root, stateDir, rolesDir });

  function close() {
    try { db.close(); } catch { /* ignore */ }
  }

  return {
    root, dbPath, memoryRoot, db, fence, writer, memory, outbox, presets, identity,

    close,

    // ── 诊断 ────────────────────────────────────────────────────────────────
    doctor() {
      const checks = [];
      const push = (name, fn) => {
        try {
          const value = fn();
          checks.push({ name, ok: true, value });
        } catch (error) {
          checks.push({ name, ok: false, code: error.code ?? null, message: String(error.message) });
        }
      };
      push('schema', () => tableCounts(db));
      push('identity', () => identity.doctor());
      push('memoryRoot', () => ({ root: memory.root, exists: fs.existsSync(memoryRoot) }));
      push('presets', () => ({ dir: presetsDir, count: presets.listPresets().length, ids: presets.listPresets() }));
      push('outbox', () => ({
        pending: outbox.list({ state: DELIVERY_STATE.PENDING, limit: 500 }).length,
        unknown: outbox.list({ state: DELIVERY_STATE.UNKNOWN_AFTER_SEND, limit: 500 }).length,
        manual: outbox.list({ state: DELIVERY_STATE.MANUAL, limit: 500 }).length,
      }));
      return { ok: checks.every((c) => c.ok), checks };
    },

    status() {
      return {
        dbPath,
        counts: tableCounts(db),
        bindings: writer.listActive(),
        memory: memory.listForInjection().map((m) => ({ relPath: m.relPath, generation: m.generation, trust: m.trust, hash: m.hash?.slice(0, 12) })),
        deliveries: outbox.list({ limit: 20 }).map((d) => ({ deliveryId: d.deliveryId, channel: d.channel, target: d.target, state: d.state, attempts: d.attemptCount })),
      };
    },

    // ── B：隔离环境准备合成权威记忆 ────────────────────────────────────────
    /**
     * 把种子文件写进隔离 memory 目录并登记。
     * 隔离环境绝不碰真实 `~/.dsh/memory`：`memoryRoot` 必须在 root/data 下。
     */
    seedAuthorityMemory(files = {}) {
      const rootReal = fs.realpathSync(memoryRoot);
      const seeded = [];
      for (const name of Object.keys(files)) {
        if (name.includes('..') || path.isAbsolute(name)) throw new CandidateError(ERR.INVALID_ARGUMENT, `非法记忆文件名：${name}`);
        const abs = path.join(rootReal, name);
        ensureDir(path.dirname(abs));
        // 幂等：文件已存在就不重写。重写会改变文件身份（inode/birthtime），
        // 会被 provenance 判成「外部修改」，把一条本来可信的记忆变成 drift。
        if (!fs.existsSync(abs)) {
          fs.writeFileSync(abs, String(files[name]), 'utf8');
          seeded.push(name);
        }
        let verdict;
        try {
          verdict = memory.verify(name);
        } catch (error) {
          if (error?.code === ERR.NOT_FOUND) throw error;
          throw error;
        }
        // verify() 对「未登记」不抛错，而是返回 registered:false —— 这里按事实补登记。
        if (!verdict.registered) {
          memory.adopt({ relPath: name, writerIdentity: 'authority', trust: TRUST.AUTHORITY });
        }
      }
      return { seeded };
    },

    // ── D：绑定渠道会话 → DSH Session（preset 必须已解析） ─────────────────
    bindConversation({
      channel, conversationKey, sessionId, presetId, owner = null,
      workspace = null, cwd = null, runId = null, revision = null, mode = 'simulation',
    }) {
      const handle = presets.resolve(presetId, { strict: true }); // 未知 preset → NOT_FOUND（fail closed）
      const id = identity.read();
      const policy = socialV2PolicyFingerprint({ mode, preset: handle.presetId, owner });
      let token = { runId, revision };
      let releaseAfter = false;
      if (token.runId == null || token.revision == null) {
        const claimed = fence.claim({ sessionId, writerIdentity: IDENTITY_WRITER(id.role), ttlMs: leaseMs });
        token = { runId: claimed.runId, revision: claimed.revision };
        releaseAfter = true;
      }
      try {
        const binding = writer.bind({
          identity: id.role, channel, conversationKey, sessionId,
          presetId: handle.presetId, owner, ...token,
        });
        presets.record(handle.presetId);
        const sessionBinding = presets.bindSession({
          sessionId, presetId: handle.presetId, fingerprint: handle.fingerprint,
          owner, workspace, cwd, role: id.role, eventChainHead: null,
        });
        return { ...binding, presetFingerprint: handle.fingerprint, policyFingerprint: policy, sessionBinding };
      } finally {
        if (releaseAfter) {
          try { fence.release({ sessionId, ...token }); } catch { /* 失败不掩盖主错误 */ }
        }
      }
    },

    // ── A：入站消息写入（唯一受控写路径） ────────────────────────────────
    submitUserMessage({ channel, conversationKey, text, extra = null }) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new CandidateError(ERR.INVALID_ARGUMENT, 'text 必须是非空字符串');
      }
      const binding = writer.get({ channel, conversationKey });
      if (!binding || binding.state !== 'active') {
        writer.denyUnbound({ channel, conversationKey });
      }
      const id = identity.read();
      const claimed = fence.claim({ sessionId: binding.sessionId, writerIdentity: IDENTITY_WRITER(id.role), ttlMs: leaseMs });
      try {
        const event = writer.write({
          sessionId: binding.sessionId,
          runId: claimed.runId,
          revision: claimed.revision,
          kind: 'user/message',
          payload: { text, channel, conversationKey, identity: id.role, ...(extra ?? {}) },
        });
        return { ...event, runId: claimed.runId, bindingRevision: binding.revision };
      } finally {
        // 即使写入失败也要释放，避免把会话锁死；release 失败不影响异常本身。
        try { fence.release({ sessionId: binding.sessionId, runId: claimed.runId, revision: claimed.revision }); } catch { /* ignore */ }
      }
    },

    // ── B：组装回合上下文（身份 + 通过闸门的记忆） ──────────────────────
    buildTurnContext({ maxInjectChars = 6000 } = {}) {
      const id = identity.read();
      const entries = memory.listForInjection();
      const injection = buildInjection({ entries, maxChars: maxInjectChars, now });
      // 被隔离（drift / untrusted）的条目不会出现在 entries 里，但它们必须可见：
      // 否则「某条记忆被外部改过、已经被拦下」这件事在运行期是静默的。
      const quarantined = db.prepare("SELECT path, trust FROM memory_registry WHERE trust IN ('drift','untrusted') ORDER BY path")
        .all().map((r) => ({ relPath: String(r.path), trust: String(r.trust) }));
      return {
        identity: id,
        injection,
        // 被 buildInjection 拒收的条目（例如调用方直接塞进来的不可信内容）。
        rejected: injection.rejected,
        quarantined,
      };
    },

    // ── C：出站投递 ──────────────────────────────────────────────────────
    enqueueReply({ channel, target, text, idempotencyKey = null, idempotent = false, reconcileSupport = 'none', sessionId = null, partsTotal = 1, intentId = null, tool = 'send_message', source = 'host', fingerprint = null }) {
      // P1：意图全局唯一。调用方（Host/dispatcher）应显式给 intentId；
      // 旧调用方缺省时生成 auto_*，保证「新写入必带 intent_id」（outbox 层本身强制）。
      const resolvedIntentId = intentId === null || intentId === undefined || String(intentId).length === 0
        ? `auto_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
        : String(intentId);
      return outbox.enqueue({
        channel, target, payload: { text }, idempotencyKey, idempotent, reconcileSupport, sessionId, partsTotal,
        intentId: resolvedIntentId, tool, source, fingerprint,
      });
    },

    /**
     * 领一条并投递一次。返回结构化结果，调用方据此决定 UI 文案。
     * 语义：provider.send 抛错 ≠ 失败（可能已经发出去了）→ unknown_after_send。
     * P1 可选：deliveryId 定向认领；maxAttempts 超限直接 failed（不发给 provider）。
     */
    async dispatchOnce({ provider = options.provider, limit = 1, deliveryId = null, maxAttempts = null } = {}) {
      if (!provider || typeof provider.send !== 'function') {
        throw new CandidateError(ERR.CAPABILITY_UNAVAILABLE, '没有可用的 Delivery provider', { capability: 'delivery.provider' });
      }
      const claimed = outbox.claim({ limit, leaseMs: leaseMs * 4, deliveryId });
      const results = [];
      for (const item of claimed) {
        if (maxAttempts !== null && Number(item.n) > Number(maxAttempts)) {
          outbox.fail({ attemptId: item.attemptId, error: `max-attempts-exceeded:${item.n}`, retryable: false });
          results.push({ deliveryId: item.deliveryId, state: DELIVERY_STATE.FAILED, receipts: [], error: 'max-attempts' });
          continue;
        }
        let sendStarted = false;
        // receipts 提到 try 之外：unknown_after_send 分支也要能把"已落库的回执"透出，
        // 出站 messageId（QQ message_id）是 L0/L2 的撤回/self 检索锚点。
        // 只透出 receipt 结构本身，绝不把正文带进返回值或日志。
        const receipts = [];
        try {
          outbox.markSendStarted({ attemptId: item.attemptId });
          sendStarted = true;
          const delivery = outbox.get(item.deliveryId);
          const parts = delivery?.partsTotal ?? 1;
          for (let partNo = 1; partNo <= parts; partNo += 1) {
            const res = await provider.send({ delivery, attempt: item, partNo });
            if (res && res.ok) {
              outbox.recordPartReceipt({ attemptId: item.attemptId, partNo, ok: true, receipt: res.receipt ?? null });
              // 回执必须一路透出到调用方（Host 用它给 recordSelfSent 提供 messageId）。
              receipts.push({ partNo, ok: true, receipt: res.receipt ?? null });
            } else {
              outbox.recordPartReceipt({ attemptId: item.attemptId, partNo, ok: false, receipt: res?.error ?? null });
              receipts.push({ partNo, ok: false });
            }
          }
          const allOk = receipts.every((r) => r.ok);
          const anyOk = receipts.some((r) => r.ok);
          if (allOk) {
            outbox.ack({ attemptId: item.attemptId, receipt: { parts: receipts } });
            results.push({ deliveryId: item.deliveryId, state: DELIVERY_STATE.SENT, receipts });
          } else if (anyOk) {
            // 部分成功：状态是 partial，不自动重发剩余部分（需要人工/对账决定）。
            outbox.ack({ attemptId: item.attemptId, receipt: { parts: receipts, partial: true } });
            results.push({ deliveryId: item.deliveryId, state: DELIVERY_STATE.PARTIAL, receipts });
          } else {
            outbox.fail({ attemptId: item.attemptId, error: 'provider-rejected', retryable: true });
            results.push({ deliveryId: item.deliveryId, state: 'retry-pending', receipts });
          }
        } catch (error) {
          if (sendStarted) {
            // 关键：发送已经开始，结果不可知 → unknown，绝不重发。
            outbox.markUnknownAfterSend({ attemptId: item.attemptId, reason: String(error?.message ?? error) });
            // receipted=true ⇒ 发送其实已拿到平台回执，只是 ack/后续步骤失败。
            // 调用方据此计 unknown_after_send_with_receipt（只计数，不写正文、不猜测送达）。
            const receipted = receipts.some((r) => r.ok === true && r.receipt != null && r.receipt.messageId != null);
            results.push({
              deliveryId: item.deliveryId,
              state: DELIVERY_STATE.UNKNOWN_AFTER_SEND,
              receipts,
              receipted,
              error: String(error?.message ?? error),
            });
          } else {
            outbox.fail({ attemptId: item.attemptId, error: String(error?.message ?? error), retryable: true });
            results.push({ deliveryId: item.deliveryId, state: 'retry-pending', error: String(error?.message ?? error) });
          }
        }
      }
      return { claimed: claimed.length, results };
    },

    // ── 恢复 ─────────────────────────────────────────────────────────────
    /**
     * 重启恢复。注意是 async：可对账的投递需要问 provider，而 provider.reconcile 是外部 IO，
     * 不能在持有 SQLite 写锁的时候调用（outbox 内部也是「先放锁、再问、再短事务落结果」）。
     */
    async recover() {
      const memoryReport = memory.reconcile();
      const outboxReport = await outbox.recoverOrphans();
      const expired = await outbox.expireLeases();
      return {
        memory: memoryReport,
        outbox: outboxReport,
        expiredLeases: expired,
        // 跑完之后仍处于 unknown 的条目：必须由人决定，不能自动重发。
        unresolved: outbox.list({ state: DELIVERY_STATE.UNKNOWN_AFTER_SEND, limit: 500 })
          .map((d) => ({ deliveryId: d.deliveryId, channel: d.channel, target: d.target, attempts: d.attemptCount })),
      };
    },

    // ── D：会话跟随（G0） ────────────────────────────────────────────────
    attachFollow({ sessionId, transport, onEvent, onBaseline }) {
      if (!transport) throw new CandidateError(ERR.CAPABILITY_UNAVAILABLE, '未提供 follow transport', { capability: 'session.follow' });
      return import('./follow-client.mjs').then(({ createFollowClient }) => {
        const client = createFollowClient({ transport, now });
        const handle = client.follow({ sessionId, onEvent, onBaseline });
        return handle;
      });
    },

    /** 计算当前候选配置指纹（供报告引用）。 */
    configFingerprint() {
      const id = identity.doctor();
      return {
        sha256: sha256Hex(JSON.stringify({ root, dbPath, memoryRoot, leaseMs, identity: id })),
        identity: id,
      };
    },
  };
}
