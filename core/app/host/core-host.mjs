import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidateService } from '../core/src/candidate/service.mjs';
import { IDENTITY_PRINCIPLES_HEADER } from '../core/src/candidate/identity.mjs';
import { createDshPrompt } from '../adapters/dsh-prompt.mjs';
import { decideInbound, decideRecallNotice } from '../adapters/formal-gateway-policy.mjs';
import { createLegacyLifecycleAdapter } from '../lifecycle/legacy-lifecycle.mjs';
import { createOneBotDeliveryProvider } from '../bridge/onebot-delivery.mjs';
import { createSocialV2Api } from './socialv2-api.mjs';
import { createSocialV2StateWriter, createSocialV2Store } from './social-v2-store.mjs';
import { loadFormalContext } from '../adapters/formal-context.mjs';
import { createWakeCoordinator } from './wake-coordinator.mjs';
import { handleWakeConfigRequest } from './wake-config-endpoint.mjs';
import { createPromptLibProviders } from './prompt-libs.mjs';
import { createSendDispatcher } from './send-dispatcher.mjs';
import { DEFAULT_ONEBOT_BASE, DEFAULT_LOCAL_UI_BASE, PRODUCTION_ONEBOT_PORTS } from '../shared/outbound-constants.mjs';
import { configureOutboundEgress, registerOutboundTarget, egressFetch } from './outbound-egress.mjs';
import { authorizeOutbound } from '../adapters/formal-outbound-policy.mjs';
import { ensureDeploymentFlagsPersisted, persistDeploymentFlags, resolveDeploymentFlags } from '../config/deployment-flags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.OPENCORE_CONFIG_PATH
  ? path.resolve(process.env.OPENCORE_CONFIG_PATH)
  : path.resolve(HERE, '..', '..', 'config', 'production.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const TEST_MODE = process.env.OPENCORE_HOST_TEST_MODE === '1';
const ONEBOT_BASE_RAW = process.env.OPENCORE_ONEBOT_BASE;

const TEST_PRODUCTION_MARKERS = ['<WORKSPACE>/production-marker' ];  // 占位：原值含真实部署路径，已排除
function assertTestModePaths(config, configPath) {
  if (!TEST_MODE) return;
  const hits = [];
  const visit = (value, key) => {
    if (typeof value === 'string') {
      const normalized = value.replaceAll('/', '\\').toLowerCase();
      if (TEST_PRODUCTION_MARKERS.some((m) => normalized.includes(m))) hits.push({ key, value });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${key}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, key ? `${key}.${k}` : k);
    }
  };
  visit(config, 'config');
  const normalizedConfigPath = String(configPath).replaceAll('/', '\\').toLowerCase();
  if (TEST_PRODUCTION_MARKERS.some((m) => normalizedConfigPath.includes(m))) hits.push({ key: 'OPENCORE_CONFIG_PATH', value: configPath });
  if (hits.length) {
    const error = new Error(`OPENCORE_TEST_PRODUCTION_PATH: test mode config points at production path(s): ${JSON.stringify(hits.slice(0, 5))}`);
    error.code = 'OPENCORE_TEST_PRODUCTION_PATH';
    error.hits = hits;
    throw error;
  }
}
assertTestModePaths(CONFIG, CONFIG_PATH);
// F1：启动时把旧 autonomousScheduler 迁移成两个独立新字段；新写入只写新字段。
const FLAG_MIGRATION = ensureDeploymentFlagsPersisted(CONFIG_PATH, CONFIG);
const DEPLOYMENT_FLAGS = FLAG_MIGRATION.flags;
CONFIG.deployment = {
  ...(CONFIG.deployment ?? {}),
  diveEnabled: DEPLOYMENT_FLAGS.diveEnabled === true,
  proactiveEnabled: DEPLOYMENT_FLAGS.proactiveEnabled === true,
};
delete CONFIG.deployment.autonomousScheduler;

/**
 * 测试模式硬护栏：绝不能靠“记得设 env”来避免打到生产 OneBot。
 * 缺失 / 非 loopback / 生产端口（至少 3000/3001）一律在 import 阶段失败，
 * 发生在 startCoreHost / listen 之前；非 test mode 不执行。
 */
function assertTestModeOneBotBase(raw) {
  const fail = (code, message) => { const error = new Error(`${code}: ${message}`); error.code = code; throw error; };
  if (!raw) fail('OPENCORE_TEST_ONEBOT_BASE_REQUIRED', 'OPENCORE_ONEBOT_BASE must be set when OPENCORE_HOST_TEST_MODE=1');
  let url;
  try { url = new URL(String(raw)); } catch { fail('OPENCORE_TEST_ONEBOT_BASE_INVALID', 'OPENCORE_ONEBOT_BASE is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('OPENCORE_TEST_ONEBOT_BASE_INVALID', 'OPENCORE_ONEBOT_BASE must use http(s)');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) fail('OPENCORE_TEST_ONEBOT_BASE_NOT_LOOPBACK', `${url.origin} is not a loopback URL`);
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (PRODUCTION_ONEBOT_PORTS.includes(port)) {
    fail('OPENCORE_TEST_ONEBOT_BASE_PRODUCTION_PORT', `${url.origin} points at production OneBot port ${port}`);
  }
}
if (TEST_MODE) assertTestModeOneBotBase(ONEBOT_BASE_RAW);
const ONEBOT_BASE = ONEBOT_BASE_RAW ? String(ONEBOT_BASE_RAW) : DEFAULT_ONEBOT_BASE;
const CONSOLE_TOKEN = process.env.OPENCORE_CONSOLE_TOKEN || CONFIG.core?.controlToken || null;
// Q9 seam 硬条件：测试模式默认关、只能 env 开启；开启时拒绝生产端口/生产路径。
if (TEST_MODE) {
  const prodRoot = '<WORKSPACE>/';
  const core = CONFIG.core ?? {};
  const hitsProd = Number(core.hostPort) === 31050
    || String(core.dbPath ?? '').startsWith(prodRoot)
    || String(core.stateDir ?? '').startsWith(prodRoot)
    || String(core.root ?? '').startsWith(prodRoot)
    || String(core.memoryRoot ?? '').startsWith(prodRoot);
  if (hitsProd) throw new Error('OPENCORE_HOST_TEST_MODE_FORBIDDEN_ON_PRODUCTION');
}
const COUNTERS = { inbound: 0, accepted: 0, denied: 0, deduped: 0, standby: 0, dshAccepted: 0, dshFailed: 0, outboxPending: 0, formalPrompts: 0, memoryBlocksInjected: 0, outbound: CONFIG.deployment?.qqOutbound === 'ENABLED' ? 'ENABLED' : 'DISABLED',
  // GAP-A：撤回通知（notice）计数；GAP-B：unknown_after_send 但已拿到平台回执的次数（D1 只计数、不补写）。
  notices: 0, noticeDenied: 0, recallApplied: 0, recallFailed: 0, unknownAfterSendWithReceipt: 0,
  proactiveChecks: 0, diveWakesTriggered: 0, diveWakesCompleted: 0, diveWakesFailed: 0, diveWakesRetried: 0 };

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (d) => { size += d.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function textOf(event) {
  const raw = event?.raw_message;
  if (typeof raw === 'string' && raw) return raw;
  if (Array.isArray(event?.message)) return event.message.map((p) => typeof p === 'string' ? p : (p?.type === 'text' ? p.data?.text ?? '' : '')).join('').trim();
  return '';
}

/**
 * 从 dispatchOnce 结果里提取「自己发出去的消息锚点」（GAP-B）。
 * 只读结构、不碰正文：
 *   sent=true 且 receipt.messageId 存在 ⇒ 可作为 L0 self 的 messageId；
 *   unknown_after_send 且 receipted=true ⇒ D1 只计数，**不补写 L0**（不伪造送达）。
 */
export function summarizeDispatchAnchor(dispatch) {
  const results = Array.isArray(dispatch?.results) ? dispatch.results : [];
  const sentItem = results.find((item) => item?.state === 'sent') ?? null;
  const receipt = sentItem?.receipts?.find((r) => r?.ok === true && r?.receipt?.messageId != null)?.receipt ?? null;
  const unknownWithReceipt = results.filter((item) => item?.state === 'unknown_after_send' && item?.receipted === true);
  return {
    sent: Boolean(sentItem),
    messageId: receipt?.messageId != null ? String(receipt.messageId) : null,
    unknownWithReceipt: unknownWithReceipt.length,
    unknownDeliveryIds: unknownWithReceipt.map((item) => item?.deliveryId ?? null),
  };
}

/**
 * Host 侧出站结果决策（纯函数，便于单测）：
 *   - 只有 state==='sent' 才写 L0 self（D1：unknown_after_send 即使有 receipt 也不补写）；
 *   - unknown_after_send 且有 receipt ⇒ 只给计数器加数（不写正文、不猜测送达）。
 */
export function decideSelfRecord(dispatch, counters = {}) {
  const anchor = summarizeDispatchAnchor(dispatch);
  if (anchor.unknownWithReceipt > 0) {
    counters.unknownAfterSendWithReceipt = (Number(counters.unknownAfterSendWithReceipt) || 0) + anchor.unknownWithReceipt;
  }
  return { record: anchor.sent, messageId: anchor.messageId, anchor };
}

export function assertFormalContext(config, formal = loadFormalContext(config)) {
  const extra = {
    configuredSessionMatchesExpected: config.formal.sessionId === config.expected.sessionId,
    configuredSessionMatchesHeader: config.formal.sessionId === formal.header.id,
    configuredPresetMatchesHeader: formal.header.agentPreset === config.expected.agentPreset,
    manifestPresetMatchesExpected: formal.manifest.preset === config.expected.agentPreset,
    manifestSessionMatchesExpected: formal.manifest.sessionId === config.expected.sessionId,
  };
  const failed = [...Object.entries(formal.checks), ...Object.entries(extra)]
    .filter(([, ok]) => !ok).map(([name]) => name);
  if (!formal.allChecksPass || failed.length) {
    const error = new Error(`FORMAL_CONTEXT_MISMATCH: ${failed.join(',')}`);
    error.code = 'FORMAL_CONTEXT_MISMATCH';
    throw error;
  }
  return formal;
}

export function assembleOpenCorePrompt({ identityBlock, turnContext, prelude = '', text }) {
  if (!identityBlock?.text?.trim()) throw new Error('OPENCORE_IDENTITY_REQUIRED');
  // fail closed：只有经过 systemBlock() 的整卡才带人格原则段。
  // 任何只有角色名的降级块（旧式短句）都不得进入 Prompt。
  if (!identityBlock.text.includes(IDENTITY_PRINCIPLES_HEADER)) throw new Error('OPENCORE_IDENTITY_INCOMPLETE');
  if (!turnContext?.injection || typeof text !== 'string' || !text.trim()) {
    throw new Error('OPENCORE_TURN_CONTEXT_REQUIRED');
  }
  const sections = [identityBlock.text.trim()];
  const trustedMemory = turnContext.injection.text.trim();
  if (trustedMemory) sections.push(`【PROJECT_NAME权威记忆 · provenance 已验证】\n${trustedMemory}`);
  if (prelude.trim()) sections.push(prelude.trim());
  sections.push(text);
  return sections.join('\n\n');
}

/**
 * 纯断言：整卡 role / roleSha256 必须与 formal manifest 一致。
 * 失败即 fail closed（抛错），绝不在装配层退回「短句角色定义」。
 * 单独导出是为了让测试可以在不启动 Host、不连 DSH 的情况下验证哈希门槛。
 */
export function assertIdentityBlockMatchesFormal(formal, identityBlock) {
  if (!identityBlock?.text?.trim() || !identityBlock?.identity) {
    throw new Error('OPENCORE_IDENTITY_REQUIRED');
  }
  if (!identityBlock.text.includes(IDENTITY_PRINCIPLES_HEADER)) throw new Error('OPENCORE_IDENTITY_INCOMPLETE');
  const identitySha = formal?.roleSha256;
  if (identitySha && (identityBlock.identity.role !== formal?.manifest?.role || identityBlock.identity.roleSha256 !== identitySha)) {
    const error = new Error('OPENCORE_IDENTITY_FORMAL_MISMATCH');
    error.code = 'OPENCORE_IDENTITY_FORMAL_MISMATCH';
    throw error;
  }
}

function assertIdentityMatchesFormal(formal, identityBlock) {
  assertIdentityBlockMatchesFormal(formal, identityBlock);
}

/**
 * 把 dispatcher.submit 的结果转成旧 wakeCoordinator / 计数逻辑能吃的 dispatch 形状。
 * 注意：L0 记账已经由 dispatcher 在 ack 之后完成；这里只用于状态观察与静默锚点。
 */
export function dispatchLikeFromSubmit(result = {}) {
  const state = result?.state;
  const mapped = state === 'sent' ? 'sent'
    : state === 'unknown_after_send' ? 'unknown_after_send'
      : state === 'failed' ? 'failed' : 'pending';
  return {
    results: [{
      deliveryId: result?.deliveryId ?? null,
      state: mapped,
      receipts: result?.messageId ? [{ ok: true, receipt: { messageId: result.messageId } }] : [],
    }],
  };
}

export async function startCoreHost({ port = CONFIG.core.hostPort } = {}) {
  const c = CONFIG.core;
  if (TEST_MODE && globalThis.__OPENCORE_EGRESS_PRELOADED__ !== true) {
    throw new Error('OPENCORE_EGRESS_PRELOAD_REQUIRED: test mode Host must be started with --import test-accept/egress-preload.mjs');
  }
  configureOutboundEgress({ mode: TEST_MODE ? 'test' : 'production', dir: c.stateDir });
  if (TEST_MODE) {
    registerOutboundTarget(ONEBOT_BASE, 'onebot');
    registerOutboundTarget(CONFIG.formal.dshBase, 'dsh');
  }
  fs.mkdirSync(c.memoryRoot, { recursive: true });
  fs.mkdirSync(c.stateDir, { recursive: true });
  const standbyPath = path.join(c.stateDir, 'standby-inbound.jsonl');
  const service = createCandidateService({ root: c.root, dbPath: c.dbPath, memoryRoot: c.memoryRoot, stateDir: c.stateDir, rolesDir: c.rolesDir, presetsDir: c.presetsDir });
  const dsh = createDshPrompt({ base: CONFIG.formal.dshBase, sessionId: CONFIG.formal.sessionId });
  const startupFormal = TEST_MODE
    ? { manifest: { sessionId: CONFIG.formal?.sessionId ?? 'test', preset: CONFIG.expected?.agentPreset ?? 'test', role: CONFIG.expected?.role ?? null, workspace: c.root }, checks: {}, roleSha256: (() => { try { return service.identity.systemBlock().identity?.roleSha256 ?? null; } catch { return null; } })(), allChecksPass: true }
    : assertFormalContext(CONFIG);
  if (!TEST_MODE) assertIdentityMatchesFormal(startupFormal, service.identity.systemBlock());

  function requireFormalBinding(key, formal) {
    let binding = service.writer.get({ channel: 'qq', conversationKey: key });
    if (!binding || binding.state !== 'active') {
      service.bindConversation({
        channel: 'qq', conversationKey: key, sessionId: formal.manifest.sessionId,
        presetId: formal.manifest.preset, owner: key, mode: 'reserved2',
        workspace: formal.manifest.workspace, cwd: formal.manifest.workspace,
      });
      binding = service.writer.get({ channel: 'qq', conversationKey: key });
    }
    const valid = binding && binding.state === 'active'
      && binding.sessionId === formal.manifest.sessionId
      && binding.presetId === formal.manifest.preset
      && binding.owner === key
      && binding.identity === formal.manifest.role;
    if (!valid) {
      const error = new Error('OPENCORE_BINDING_FORMAL_MISMATCH');
      error.code = 'OPENCORE_BINDING_FORMAL_MISMATCH';
      throw error;
    }
    return binding;
  }

  async function prepareFormalPrompt({ formal, key, text, recent = true }) {
    const identityBlock = service.identity.systemBlock();
    assertIdentityMatchesFormal(formal, identityBlock);
    const turnContext = service.buildTurnContext({ maxInjectChars: 6000 });
    const prelude = recent ? await memoryPrelude(key, text) : '';
    return {
      text: assembleOpenCorePrompt({ identityBlock, turnContext, prelude, text }),
      memoryIncluded: turnContext.injection.included.length,
      memoryQuarantined: turnContext.quarantined.length,
    };
  }

  const wakePath = path.join(c.stateDir, 'lifecycle-wake-events.jsonl');
  const LOCAL_UI_BASE = process.env.OPENCORE_LOCAL_UI_BASE ? String(process.env.OPENCORE_LOCAL_UI_BASE) : DEFAULT_LOCAL_UI_BASE;
  let localUiConversationId = null;
  let wakeCoordinator = null;
  // 只写任务 ID/时间/原因等元数据；绝不写 prompt、记忆正文或会话内容。
  function appendWakeRecord(record) {
    try {
      fs.mkdirSync(path.dirname(wakePath), { recursive: true });
      fs.appendFileSync(wakePath, JSON.stringify({ ...record, recordedAt: new Date().toISOString() }) + '\n', 'utf8');
    } catch { /* lifecycle observability must not break Host */ }
  }
  async function mirrorLocalUi(role, text, sourceMsgId, atUtc = Date.now()) {
    if (!text || !sourceMsgId) return null;
    try {
      if (!localUiConversationId) {
        const boot = await (await egressFetch(`${LOCAL_UI_BASE}/api/bootstrap`, { signal: AbortSignal.timeout(1200) }, { label: 'local-ui-bootstrap' })).json();
        localUiConversationId = boot?.active?.sourceConvId || boot?.conversations?.[0]?.sourceConvId || null;
      }
      if (!localUiConversationId) return null;
      const r = await egressFetch(`${LOCAL_UI_BASE}/api/conversations/${encodeURIComponent(localUiConversationId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ sourceMsgId: String(sourceMsgId).slice(0, 200), role, content: String(text), atUtc, attachments: [] }] }),
        signal: AbortSignal.timeout(2500),
      }, { label: 'local-ui-messages' });
      return await r.json().catch(() => null);
    } catch { return null; }
  }
  async function memoryPrelude(key, currentText = '') {
    const parts = [];
    try {
      const r = await egressFetch(`${LOCAL_UI_BASE}/api/messages`, { signal: AbortSignal.timeout(1500) }, { label: 'local-ui-prelude' });
      const msgs = (await r.json())?.messages ?? [];
      const recent = [];
      for (const m of msgs.slice(-10)) {
        const t = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim();
        if (!t) continue;
        if (m.role === 'user' && t === currentText && m === msgs[msgs.length - 1]) continue;
        recent.push(`${m.role === 'assistant' ? 'CORE_ENTITY' : '管理员'}：${t.slice(0, 500)}`);
      }
      if (recent.length) parts.push('最近对话：\n' + recent.slice(-8).join('\n'));
    } catch { /* local UI may be closed; fall back to social state */ }
    try {
      const state = JSON.parse(fs.readFileSync(path.join(CONFIG.formal.qqRoot, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
      const st = state?.conversations?.[key] ?? {};
      const topics = Array.isArray(st.activeTopics) ? st.activeTopics.map((x) => typeof x === 'string' ? x : x?.topic ?? x?.title).filter(Boolean) : [];
      const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.map((x) => x?.text ?? x?.content).filter(Boolean) : [];
      const promises = Array.isArray(st.promises) ? st.promises.filter((x) => x && x.status !== 'done' && x.status !== 'cancelled').map((x) => x?.text ?? x?.content).filter(Boolean) : [];
      if (topics.length) parts.push('当前话题：' + topics.slice(0, 5).join('；'));
      if (thoughts.length) parts.push('未说出口的话：' + thoughts.slice(0, 5).join('；'));
      if (promises.length) parts.push('未完成约定：' + promises.slice(0, 5).join('；'));
    } catch { /* state is optional */ }
    return parts.length ? `【前情提要】\n${parts.join('\n')}\n\n` : '';
  }

  function wakePrompt(ev) {
    const key = ev?.key ? `会话 ${ev.key}。` : '';
    if (ev?.type === 'sleep-wake') {
      return `【自主生活・潜水醒来】${key}你刚从定时潜水中醒来。先检查管理员是否有需要回应的新消息；有就正常回复，没有就继续安静待着，不要为了证明存在而刷消息。`;
    }
    if (ev?.type === 'proactive-check') {
      return `【自主生活・主动检查】${key}这是主动生活的检查点。先看有没有值得接的话题或未完成的约定；没有就继续潜水，不要为了主动而主动。`;
    }
    return `【自主生活・回复后检查】${key}检查上一轮回复之后是否又有需要处理的新消息；没有就继续安静。`;
  }
  // social-v2.json 的唯一写入入口：Host 创建一把带跨进程锁的 writer，同时注入
  // lifecycle 与 store/api；任何一方都不能再 atomicWrite 整份 state。
  const qqStateDir = path.join(CONFIG.formal.qqRoot, 'state');
  const socialV2StateFile = CONFIG.deployment?.legacyLifecycleState || path.join(qqStateDir, 'social-v2.json');
  const socialV2StateWriter = createSocialV2StateWriter({
    stateFile: socialV2StateFile,
    staleMs: Number(CONFIG.core?.stateLockStaleMs) > 0 ? Number(CONFIG.core.stateLockStaleMs) : undefined,
    retryMs: Number(CONFIG.core?.stateLockRetryMs) > 0 ? Number(CONFIG.core.stateLockRetryMs) : undefined,
    retries: Number(CONFIG.core?.stateLockRetries) > 0 ? Number(CONFIG.core.stateLockRetries) : undefined,
    logger: (record) => console.error(JSON.stringify(record)),
  });
  const lifecycle = createLegacyLifecycleAdapter({
    stateFile: socialV2StateFile,
    stateWriter: socialV2StateWriter,
    config: CONFIG,
    enabled: DEPLOYMENT_FLAGS.diveEnabled === true || DEPLOYMENT_FLAGS.proactiveEnabled === true,
    writable: DEPLOYMENT_FLAGS.diveEnabled === true || DEPLOYMENT_FLAGS.proactiveEnabled === true,
    diveEnabled: DEPLOYMENT_FLAGS.diveEnabled === true,
    proactiveEnabled: DEPLOYMENT_FLAGS.proactiveEnabled === true,
    intervalMs: Number(CONFIG.core?.lifecycleIntervalMs) > 0 ? Number(CONFIG.core.lifecycleIntervalMs) : 5000,
    onSkip: (record) => appendWakeRecord({
      kind: 'wake-task-skipped', taskId: record?.taskId ?? null, type: record?.type ?? null,
      key: record?.key ?? null, dueAtMs: record?.dueAtMs ?? null, reason: record?.reason ?? null,
    }),
    onWake: async (ev) => {
      if (ev?.type === 'sleep-wake') COUNTERS.diveWakesTriggered += 1;
      if (ev?.type === 'proactive-check') COUNTERS.proactiveChecks += 1;
      const authorization = wakeCoordinator?.authorizeWake(ev) ?? { ok: true };
      if (!authorization.ok) {
        appendWakeRecord({ kind: 'wake-skipped', taskId: ev?.id ?? null, type: ev?.type ?? null, key: ev?.key ?? null, dueAt: ev?.dueAt ?? null, reason: authorization.reason });
        return;
      }
      if (ev?.key !== 'private:20000001') {
        appendWakeRecord({ kind: 'wake-skipped', taskId: ev?.id ?? null, type: ev?.type ?? null, key: ev?.key ?? null, dueAt: ev?.dueAt ?? null, reason: 'non-owner-lifecycle' });
        return;
      }
      let dshResult = null;
      let dispatch = null;
      let outbound = null;
      let wakeOk = false;
      let dshFailed = false;
      try {
        if (CONFIG.deployment?.personaActivation === 'ENABLED' && CONFIG.deployment?.messageProcessing === 'ENABLED') {
          const formal = TEST_MODE ? startupFormal : assertFormalContext(CONFIG);
          const binding = requireFormalBinding(ev.key, formal);
          const prepared = await prepareFormalPrompt({ formal, key: ev.key, text: wakePrompt(ev) });
          // #2：prompt 组装/排队可能耗时；真正发送前再复核一次 task generation/有效期。
          const sendAuthorization = wakeCoordinator?.authorizeWake(ev) ?? { ok: true };
          if (!sendAuthorization.ok) {
            appendWakeRecord({ kind: 'wake-skipped', taskId: ev?.id ?? null, type: ev?.type ?? null, key: ev?.key ?? null, dueAt: ev?.dueAt ?? null, reason: sendAuthorization.reason, stage: 'before-send' });
            return;
          }
          COUNTERS.formalPrompts += 1;
          COUNTERS.memoryBlocksInjected += prepared.memoryIncluded;
          dshResult = await dsh.prompt(prepared.text);
          if (dshResult.ok) {
            COUNTERS.dshAccepted += 1;
            await mirrorLocalUi('assistant', dshResult.text, `wake:${ev.id}:${dshResult.requestId}`);
            const wakePolicy = authorizeOutbound({
              target: ev.key, source: 'wake-reply', sourceKey: ev.key, tool: 'send_message',
              caller: { internal: true }, config: CONFIG,
            });
            let submitted;
            if (!wakePolicy.allowed) {
              COUNTERS.outboundBlocked += 1;
              submitted = { accepted: false, state: 'blocked', reason: wakePolicy.reason, deliveryId: null, messageId: null };
              appendWakeRecord({ kind: 'wake-outbound-blocked', taskId: ev?.id ?? null, key: ev?.key ?? null, reason: wakePolicy.reason });
            } else {
              submitted = await outboundDispatcher.submit({
                key: ev.key, text: dshResult.text, intentId: `wake:${ev.id}:${dshResult.requestId}`,
                tool: 'send_message', source: 'wake-reply', wait: true,
                timeoutMs: Number(CONFIG.core?.replyWaitMs) || 8000,
              });
            }
            if (submitted.state === 'accepted') COUNTERS.outboxPending += 1;
            dispatch = dispatchLikeFromSubmit(submitted);
            // 只有确认成功的可见出站才更新锚点；失败/unknown/被闸拒绝的尝试不延长静默。
            outbound = wakeCoordinator?.noteOutboundResult(ev.key, dispatch) ?? null;
            wakeOk = dshResult?.ok === true && outbound?.confirmed === true;
            if (submitted.state === 'unknown_after_send') {
              console.error(JSON.stringify({ kind: 'unknown-after-send', phase: 'wake', deliveryId: submitted.deliveryId }));
            }
          } else {
            dshFailed = true;
            COUNTERS.dshFailed += 1;
          }
        }
        if (ev?.type === 'sleep-wake') {
          if (wakeOk) COUNTERS.diveWakesCompleted += 1;
          else COUNTERS.diveWakesFailed += 1;
        }
        appendWakeRecord({
          kind: 'wake-processed', taskId: ev?.id ?? null, type: ev?.type ?? null, key: ev?.key ?? null,
          dueAt: ev?.dueAt ?? null, dshPrompt: Boolean(dshResult), dshOk: Boolean(dshResult?.ok),
          outboundConfirmed: outbound?.confirmed === true, outboundStates: outbound?.states ?? null,
        });
        if (ev?.type === 'sleep-wake' && dshFailed) scheduleDiveRetry(ev, 'dsh-failed');
      } catch (e) {
        COUNTERS.dshFailed += 1;
        if (ev?.type === 'sleep-wake') {
          COUNTERS.diveWakesFailed += 1;
          scheduleDiveRetry(ev, 'wake-error');
        }
        appendWakeRecord({ kind: 'wake-error', taskId: ev?.id ?? null, type: ev?.type ?? null, key: ev?.key ?? null, dueAt: ev?.dueAt ?? null, reason: String(e.message) });
      }
    }
  });
  function scheduleDiveRetry(ev, reason) {
    if (ev?.type !== 'sleep-wake' || !DEPLOYMENT_FLAGS.diveEnabled) return null;
    const delay = Math.max(100, Number(CONFIG.core?.wakeFailureRetryMs) || 30000);
    try {
      const retry = lifecycle.scheduleDive(ev.key, { minMs: delay, maxMs: delay });
      if (retry?.scheduled) {
        COUNTERS.diveWakesRetried += 1;
        appendWakeRecord({ kind: 'wake-retry-scheduled', taskId: ev?.id ?? null, type: 'sleep-wake', key: ev.key, reason, retryTaskId: retry.task?.id ?? null, retryDueAtMs: retry.task?.dueAtMs ?? null });
      } else {
        appendWakeRecord({ kind: 'wake-retry-not-scheduled', taskId: ev?.id ?? null, type: 'sleep-wake', key: ev.key, reason, blocked: retry?.blocked ?? null });
      }
      return retry;
    } catch (error) {
      appendWakeRecord({ kind: 'wake-retry-error', taskId: ev?.id ?? null, type: 'sleep-wake', key: ev.key, reason, error: String(error?.message ?? error) });
      return null;
    }
  }
  wakeCoordinator = createWakeCoordinator({
    lifecycle,
    idleDiveMs: Number(CONFIG.core?.idleDiveMs) > 0 ? Number(CONFIG.core.idleDiveMs) : 300000,
    logger: (record) => appendWakeRecord({
      kind: record.kind, taskId: record.taskId ?? null, type: record.type ?? null, key: record.key ?? null,
      reason: record.reason ?? null, generation: record.generation ?? null, states: record.states ?? null,
      scheduled: record.scheduled ?? null, dueAt: record.dueAt ?? null,
    }),
  });
  const snowOnebot = (() => { try { return JSON.parse(fs.readFileSync('<WORKSPACE>/', 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } })();
  const onebotToken = process.env.OPENCORE_ONEBOT_TOKEN || snowOnebot?.networks?.httpServers?.[0]?.accessToken || null;
  const deliveryProvider = onebotToken ? createOneBotDeliveryProvider({ base: ONEBOT_BASE, token: onebotToken }) : null;
  // ── SOCIALV2 L0/L1/L2 端口（B 方案：直接读写同一份 state 文件） ─────────────
  // 合并注意：原 B 方案在这里调用一个只发"角色名 + 让模型自己去查卡"的短提示函数，
  // 而 FIX #3 已把该函数整体删除。合并后统一走 service.identity.systemBlock() 整卡；
  // 取不到卡时 fail closed（ok:false、空 hint），绝不回退到任何降级短提示。
  const socialV2Store = createSocialV2Store({
    stateFile: socialV2StateFile,
    stateWriter: socialV2StateWriter,
    logger: (message) => console.error(String(message)),
  });
  // GAP-C：prompt 真源（slang / stickers / voices）。只读 state/ 与 <repo>/audio，
  // 不联网、不写盘（D6 复制 loader、D7 不做 OneBot 同步）；取不到时由 api 标 available:false。
  const promptLibs = createPromptLibProviders({
    stateDir: qqStateDir,
    repoRoot: CONFIG.formal?.qqRoot ?? null,
    config: CONFIG,
    ttlMs: Number(CONFIG.core?.promptLibTtlMs) > 0 ? Number(CONFIG.core.promptLibTtlMs) : 30000,
    logger: (message) => console.error(String(message)),
  });
  const socialV2Api = createSocialV2Api({
    stateFile: socialV2StateFile,
    store: socialV2Store,
    historyDir: path.join(qqStateDir, 'history'),
    config: CONFIG,
    configPath: path.join(CONFIG.formal.qqRoot, 'config.json'),
    stateDir: qqStateDir,
    logger: (message) => console.error(String(message)),
    // GAP-C：三个 prompt 真源 provider；未接线时 api 会返回 available:false（不再静默占位）。
    slangProvider: promptLibs.slang,
    stickerProvider: promptLibs.stickers,
    voiceProvider: promptLibs.voices,
    roleProvider: () => {
      try {
        const block = service.identity.systemBlock();
        return { configured: true, ok: true, name: block.identity?.role ?? CONFIG.expected?.role ?? null, hint: block.text };
      } catch (error) {
        return { configured: true, ok: false, name: CONFIG.expected?.role ?? null, hint: '', error: String(error?.message ?? error) };
      }
    },
    selfProfile: { nickname: null, userId: CONFIG.expected?.botUin ?? null, line: null },
    groupMembersProvider: onebotToken
      ? async (groupId) => {
        const response = await egressFetch(ONEBOT_BASE + '/get_group_member_list', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + onebotToken },
          body: JSON.stringify({ group_id: groupId }),
          signal: AbortSignal.timeout(15000),
        }, { label: 'onebot-group-members' });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || body.status !== 'ok' || body.retcode !== 0) {
          throw new Error(`OneBot get_group_member_list 失败: ${body?.retcode ?? response.status}`);
        }
        return body.data;
      }
      : null,
  });
  const outboundDispatcher = createSendDispatcher({
    service,
    provider: deliveryProvider,
    l0: { record: (x) => socialV2Api.recordSelfSent({ key: x.key, text: x.text, messageId: x.messageId, time: x.atMs }) },
    config: CONFIG,
    logger: console,
    stateDir: c.stateDir,
    hostId: `host:${port}`,
  });
  let lifecycleStarted = null;
  const seen = new Set();
  function appendStandby(record) {
    fs.mkdirSync(path.dirname(standbyPath), { recursive: true });
    fs.appendFileSync(standbyPath, JSON.stringify(record) + '\n', 'utf8');
  }
  const server = http.createServer(async (req, res) => {
    const outboundUnavailable = () => {
      const current = outboundDispatcher.state;
      if (current === 'ready') return null;
      const recovering = current === 'recovering' || current === 'booting';
      const status = outboundDispatcher.status();
      return {
        httpStatus: 503,
        body: {
          ok: false,
          error: recovering ? 'OUTBOUND_RECOVERING' : 'OUTBOUND_DEGRADED',
          reason: outboundDispatcher.reason ?? current,
          state: current,
          blockedBy: status.recovery?.blockedBy ?? null,
          outbound: 'DISABLED',
        },
      };
    };
    const agentAuth = (req, target) => {
      const headers = req.headers ?? {};
      const consoleTokenOk = Boolean(CONSOLE_TOKEN) && headers['x-console-token'] === CONSOLE_TOKEN;
      const agentCall = String(headers['x-agent-call'] ?? '') === '1';
      const agentToken = headers['x-agent-token'];
      let agentTokenOk = false;
      const ownerKey = `private:${CONFIG.expected?.ownerQQ ?? CONFIG.ownerQQ ?? ''}`;
      try {
        agentTokenOk = typeof agentToken === 'string' && agentToken.length > 0
          && (socialV2Store.tokenMatches(target, agentToken)
            || (ownerKey !== target && socialV2Store.tokenMatches(ownerKey, agentToken)));
      } catch { /* missing conversation = unauthorized */ }
      return { consoleTokenOk, agentCall, agentTokenOk, ok: consoleTokenOk && agentCall && agentTokenOk };
    };
    const sendAuthError = (res, code = 'UNAUTHORIZED') => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: code, code }));
    };
    const sendBadRequest = (res, code = 'BAD_REQUEST', message = null) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: code, ...(message ? { message } : {}) }));
    };
    const sendPolicyDenied = (res, reason) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN', reason }));
    };
    const sendNotImplemented = (res, reason) => {
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'NOT_IMPLEMENTED', code: 'NOT_IMPLEMENTED', reason }));
    };
    const toIntentResponse = (intentId, result, deduped = false) => {
      const state = result?.state ?? 'failed';
      const base = {
        ok: state !== 'failed',
        intentId,
        deliveryId: result?.deliveryId ?? null,
        state,
        waitedMs: Number(result?.waitedMs) || 0,
        timedOut: result?.timedOut === true,
        ...(deduped || result?.deduped === true ? { deduped: true } : {}),
      };
      if (state === 'sent' && result?.messageId) base.messageId = result.messageId;
      if (state === 'accepted') base.note = '已入队，未确认送达';
      if (state === 'unknown_after_send') base.note = '可能已发出，不会自动重发';
      return base;
    };
    if (req.method === 'POST' && req.url === '/api/config/deployment-flags') {
      if (String(req.headers['x-console-token'] ?? '') !== String(CONSOLE_TOKEN ?? '')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }));
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req, 16 * 1024)); } catch { sendBadRequest(res, 'INVALID_JSON'); return; }
      const requested = {};
      if (typeof body?.diveEnabled === 'boolean') requested.diveEnabled = body.diveEnabled;
      if (typeof body?.proactiveEnabled === 'boolean') requested.proactiveEnabled = body.proactiveEnabled;
      if (Object.keys(requested).length === 0) { sendBadRequest(res, 'FLAGS_REQUIRED'); return; }
      const current = resolveDeploymentFlags(CONFIG);
      const flags = { ...current, ...requested };
      try {
        const written = persistDeploymentFlags(CONFIG_PATH, CONFIG, flags);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, flags: written.flags, changed: written.changed, restartRequired: true }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'CONFIG_WRITE_FAILED', message: String(error?.message ?? error) }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/outbound/intent') {
      const intentId = String(req.headers['x-opencore-intent-id'] ?? '').trim();
      if (!intentId) { sendBadRequest(res, 'INTENT_ID_REQUIRED'); return; }
      if (intentId.length < 8 || intentId.length > 128) { sendBadRequest(res, 'INTENT_ID_INVALID'); return; }
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { sendBadRequest(res, 'INVALID_JSON'); return; }
      const target = String(body?.target ?? '').trim();
      const tool = String(body?.tool ?? 'send_message').trim();
      const text = String(body?.text ?? '');
      const source = String(body?.source ?? 'mcp');
      if (!target) { sendBadRequest(res, 'TARGET_REQUIRED'); return; }
      if (!text.trim()) { sendBadRequest(res, 'TEXT_REQUIRED'); return; }
      if (text.length > 2000) { sendBadRequest(res, 'TEXT_TOO_LONG'); return; }
      const caller = agentAuth(req, target);
      if (!caller.ok) { sendAuthError(res); return; }
      const policy = authorizeOutbound({
        target, source, sourceKey: body?.sourceKey ?? null, tool,
        caller, config: CONFIG,
      });
      if (!policy.allowed) { sendPolicyDenied(res, policy.reason); return; }
      if (body?.replyToMessageId !== undefined && body?.replyToMessageId !== null && String(body.replyToMessageId) !== '') {
        sendNotImplemented(res, 'replyToMessageId is v2 only');
        return;
      }
      const unavailable = outboundUnavailable();
      if (unavailable) {
        res.writeHead(unavailable.httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(unavailable.body));
        return;
      }
      try {
        const result = await outboundDispatcher.submit({
          key: target, text, intentId, tool, source,
          wait: true,
          timeoutMs: Number(CONFIG.core?.replyWaitMs) || 8000,
        });
        if (result?.state === 'blocked' || result?.accepted === false) {
          if (result?.code === 'conflict' || /intentId.*(冲突|占用)|intent-conflict/i.test(String(result?.reason ?? ''))) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'INTENT_CONFLICT', code: 'INTENT_CONFLICT' }));
            return;
          }
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'OUTBOUND_DEGRADED', reason: result.reason ?? null, state: result.state ?? null }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(toIntentResponse(intentId, result)));
      } catch (error) {
        const code = String(error?.code ?? '');
        if (code === 'conflict' || code === 'INTENT_CONFLICT' || /intent|幂等|conflict/i.test(String(error?.message ?? ''))) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'INTENT_CONFLICT', code: 'INTENT_CONFLICT' }));
          return;
        }
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'INTENT_FAILED', message: String(error?.message ?? error) }));
      }
      return;
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, deployment: CONFIG.deployment, port, status: service.status(), counters: COUNTERS,
        paths: { db: c.dbPath, memory: c.memoryRoot, state: c.stateDir, standbyQueue: standbyPath },
        network: c.network,
        chain: {
          entry: 'opencore-core', formalContext: 'enforced', binding: 'enforced',
          memoryAssembly: 'service.buildTurnContext', dshSession: startupFormal.manifest.sessionId,
          preset: startupFormal.manifest.preset,
        },
        activation: CONFIG.deployment?.personaActivation === 'ENABLED' ? 'ACTIVE' : 'OWNER_INBOUND_STANDBY',
        inboundStandby: CONFIG.deployment?.inboundStandby === 'ENABLED',
        outbound: { mode: COUNTERS.outbound, testMode: TEST_MODE, ...outboundDispatcher.status() }
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/outbound/intent')) {
      const token = req.headers['x-console-token'];
      if (!CONSOLE_TOKEN || token !== CONSOLE_TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      let intentId = null;
      try { intentId = new URL(req.url, 'http://127.0.0.1').searchParams.get('intentId'); } catch { /* ignore */ }
      const intent = intentId ? outboundDispatcher.queryIntent(intentId) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, intent }));
      return;
    }
    if (TEST_MODE && req.method === 'POST' && req.url === '/__test__/send') {
      const unavailable = outboundUnavailable();
      if (unavailable) {
        res.writeHead(unavailable.httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(unavailable.body));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req, 16 * 1024));
        const outbox = await outboundDispatcher.submit({
          key: body.key ?? CONFIG.expected?.ownerKey ?? 'private:0',
          text: String(body.text ?? 'test-mode-message').slice(0, 2000),
          intentId: body.intentId ?? null,
          tool: 'send_message',
          source: 'test-mode',
          reconcileSupport: body.reconcileSupport === 'query' ? 'query' : 'none',
          wait: body.wait !== false,
          timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 3000,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, testMode: true, outbox }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/lifecycle/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lifecycle: lifecycle.status(), wake: wakeCoordinator?.status() ?? null, autonomousScheduler: null, deployment: CONFIG.deployment, dshPrompt: c.network?.dshPrompt === true, qqOutbound: COUNTERS.outbound }));
      return;
    }
    if (req.method === 'POST' && req.url === '/lifecycle/wake-config') {
      // 受控端点：MCP qq_set_wake_config 的唯一入口；不再直写 social-v2.json。
      try {
        const body = JSON.parse(await readBody(req, 32 * 1024));
        const expectedToken = process.env.OPENCORE_HOST_CONTROL_TOKEN || CONFIG.core?.controlToken || null;
        const handled = handleWakeConfigRequest({
          body,
          headers: req.headers,
          expectedToken,
          allow: CONFIG.allow,
          ownerQQ: CONFIG.expected?.ownerQQ,
          apply: (key, config) => wakeCoordinator.setWakeConfig(key, config),
        });
        res.writeHead(handled.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(handled.body));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: String(error?.message ?? error) } }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/inbound') {
      COUNTERS.inbound += 1;
      try {
        const raw = JSON.parse(await readBody(req));
        const event = raw.rawEvent ?? raw;
        const decision = decideInbound(event, CONFIG);
        if (!decision.allow) {
          COUNTERS.denied += 1;
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: decision.reason, outbound: 'DISABLED' }));
          return;
        }
        COUNTERS.accepted += 1;
        const key = decision.key;
        const messageId = String(event.message_id ?? event.messageId ?? raw.correlationId ?? '');
        const text = textOf(event);
        if (!text) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'empty-message' })); return; }

        const unavailable = outboundUnavailable();
        if (unavailable) {
          res.writeHead(unavailable.httpStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify(unavailable.body));
          return;
        }

        const processActive = CONFIG.deployment?.personaActivation === 'ENABLED' && CONFIG.deployment?.messageProcessing === 'ENABLED';
        if (!processActive) {
          if (CONFIG.deployment?.inboundStandby !== 'ENABLED') {
            res.writeHead(423, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'PERSONA_ACTIVATION_DISABLED', activation: CONFIG.deployment?.personaActivation, messageProcessing: CONFIG.deployment?.messageProcessing, inboundStandby: CONFIG.deployment?.inboundStandby, outbound: 'DISABLED' }));
            return;
          }
          if (messageId && seen.has(messageId)) {
            COUNTERS.deduped += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, deduped: true, standby: true, messageId, outbound: 'DISABLED' }));
            return;
          }
          if (messageId) seen.add(messageId);
          const correlationId = String(raw.correlationId ?? messageId ?? ('standby:' + Date.now()));
          const record = {
            schema: 'opencore-standby-inbound-v1',
            at: new Date().toISOString(),
            correlationId, messageId,
            source: raw.synthetic === true ? 'synthetic' : 'qq',
            channel: 'qq', target: key,
            userId: String(event.user_id ?? ''), groupId: event.group_id ?? null,
            botUin: CONFIG.expected?.botUin, ownerQQ: CONFIG.expected?.ownerQQ,
            identity: CONFIG.expected?.role, sessionId: CONFIG.formal?.sessionId,
            status: 'STANDBY', disposition: 'queued_for_owner_activation',
            messageType: event.message_type ?? null, subType: event.sub_type ?? null,
            text, rawEvent: event
          };
          appendStandby(record);
          COUNTERS.standby += 1;
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, standby: true, status: 'STANDBY', correlationId, messageId, target: key, identity: CONFIG.expected?.role, sessionId: CONFIG.formal?.sessionId, queue: standbyPath, outbound: 'DISABLED' }));
          return;
        }

        if (messageId && seen.has(messageId)) {
          COUNTERS.deduped += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deduped: true, messageId, outbound: 'DISABLED' }));
          return;
        }
        if (messageId) seen.add(messageId);
        const formal = TEST_MODE ? startupFormal : assertFormalContext(CONFIG);
        const binding = requireFormalBinding(key, formal);
        const inbound = service.submitUserMessage({ channel: 'qq', conversationKey: key, text, extra: { correlationId: raw.correlationId ?? messageId, messageId } });
        // 唯一 per-key 状态机：入站更新锚点、bump generation、取消旧 dive/task 并重新计时。
        wakeCoordinator.noteInbound(key);
        // L0：入站消息追加到 recentMessages（不阻断主链；失败只计数）。
        try {
          await socialV2Api.recordInbound({
            key,
            sender: event.sender?.card || event.sender?.nickname || String(event.user_id ?? ''),
            userId: event.user_id ?? null,
            text,
            isOwner: key === `private:${CONFIG.expected?.ownerQQ}`,
            messageId: messageId || null,
            time: Date.now(),
          });
        } catch { COUNTERS.socialV2L0Failures = (COUNTERS.socialV2L0Failures ?? 0) + 1; }
        await mirrorLocalUi('user', text, `qq:${messageId}:u`);
        const prepared = await prepareFormalPrompt({ formal, key, text });
        COUNTERS.formalPrompts += 1;
        COUNTERS.memoryBlocksInjected += prepared.memoryIncluded;
        const prompt = await dsh.prompt(prepared.text);
        if (!prompt.ok) {
          COUNTERS.dshFailed += 1;
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, inbound: { runId: inbound.runId, sessionId: binding.sessionId }, dsh: prompt, outbound: 'DISABLED' }));
          return;
        }
        COUNTERS.dshAccepted += 1;
        await mirrorLocalUi('assistant', prompt.text, `qq:${messageId}:a`);
        try { lifecycle.scheduleReply(key, { replyAt: Date.now(), replyId: prompt.requestId, recentMessages: [] }); } catch { /* lifecycle scheduling cannot block the reply */ }
        const inboundPolicy = authorizeOutbound({
          target: key, source: 'inbound-reply', sourceKey: key, tool: 'send_message',
          caller: { internal: true }, config: CONFIG,
        });
        let submitted;
        if (!inboundPolicy.allowed) {
          COUNTERS.outboundBlocked += 1;
          submitted = { accepted: false, state: 'blocked', reason: inboundPolicy.reason, deliveryId: null, messageId: null };
        } else {
          submitted = await outboundDispatcher.submit({
            key, text: prompt.text, intentId: `internal:${messageId}:${prompt.requestId}`,
            tool: 'send_message', source: 'inbound-reply', wait: true,
            timeoutMs: Number(CONFIG.core?.replyWaitMs) || 8000,
          });
        }
        if (submitted.state === 'accepted') COUNTERS.outboxPending += 1;
        // 只有确认成功的可见出站才延长静默；被闸拒绝/失败/unknown 不更新锚点。
        wakeCoordinator.noteOutboundResult(key, dispatchLikeFromSubmit(submitted));
        if (submitted.state === 'unknown_after_send') {
          console.error(JSON.stringify({ kind: 'unknown-after-send', phase: 'inbound', deliveryId: submitted.deliveryId }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, inbound: { runId: inbound.runId, sessionId: binding.sessionId }, opencore: { formalContext: true, binding: true, memoryIncluded: prepared.memoryIncluded, memoryQuarantined: prepared.memoryQuarantined, outbox: submitted }, dsh: { requestId: prompt.requestId, turn: prompt.turn, reason: prompt.reason }, outbox: submitted, outbound: 'ENABLED' }));
        return;
      } catch (e) {
        COUNTERS.dshFailed += 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message), outbound: 'DISABLED' }));
        return;
      }
    }
    if (req.method === 'POST' && req.url === '/inbound/notice') {
      // GAP-A：撤回通知入口。与 /inbound 完全分离：不进 standby 队列、不触发 DSH、不发 QQ。
      // 写路径仍然走已注入的唯一 writer（socialV2Api → store.markRecalled → mutate → writer）。
      COUNTERS.notices += 1;
      try {
        const raw = JSON.parse(await readBody(req, 32 * 1024));
        const event = raw.rawEvent ?? raw;
        // 不信网关传来的 decision：本地再判一次（纵深防御）。
        const decision = decideRecallNotice(event, CONFIG);
        if (!decision.allow) {
          COUNTERS.noticeDenied += 1;
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: decision.reason }));
          return;
        }
        const applied = await socialV2Api.recordRecall({ key: decision.key, mid: decision.mid });
        if (applied?.ok === true) COUNTERS.recallApplied += 1;
        else COUNTERS.recallFailed += 1;
        res.writeHead(applied?.ok === true ? 200 : 500, { 'content-type': 'application/json' });
        // 只回计数与 id，不回正文。
        res.end(JSON.stringify({
          ok: applied?.ok === true,
          recall: {
            key: decision.key,
            mid: decision.mid,
            deduped: applied?.deduped === true,
            tombstone: applied?.tombstone?.appended === true,
            touched: Number(applied?.touched) || 0,
            memoryRemoved: Number(applied?.memoryRemoved) || 0,
          },
        }));
        return;
      } catch (error) {
        COUNTERS.recallFailed += 1;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        return;
      }
    }
    if (await socialV2Api.handleHttp(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  // S5 恢复 → S6 开闸 → S7 listen；恢复完成前不对外提供发送能力（listen 后 submit 仍在 degraded/锁冲突时拒绝）。
  const recoveryReport = await outboundDispatcher.recover();
  const outboundGateOpened = outboundDispatcher.open();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  if (DEPLOYMENT_FLAGS.diveEnabled === true || DEPLOYMENT_FLAGS.proactiveEnabled === true) lifecycleStarted = lifecycle.start();
  return {
    service, server, url: `http://127.0.0.1:${port}`, standbyPath, lifecycleStarted,
    outboundDispatcher, recoveryReport, outboundGateOpened,
    close: async () => { try { outboundDispatcher.stop(); } catch { /* ignore */ } try { wakeCoordinator?.stop(); } catch { /* ignore */ } try { lifecycle.stop(); } catch { /* ignore */ } await new Promise((resolve) => server.close(resolve)); service.close(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = await startCoreHost();
  console.log(JSON.stringify({ host: host.url, status: CONFIG.deployment?.personaActivation === 'ENABLED' ? 'ACTIVE' : (CONFIG.deployment?.inboundStandby === 'ENABLED' ? 'OWNER_INBOUND_STANDBY' : 'STARTED_BY_EXPLICIT_INVOCATION'), outbound: CONFIG.deployment?.qqOutbound ?? 'DISABLED', lifecycleStarted: host.lifecycleStarted }));
}
