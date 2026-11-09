import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = '<WORKSPACE>/';

export function loadProductionConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function activationAllowed(config) {
  return config?.deployment?.personaActivation === 'ENABLED'
    && config?.deployment?.messageProcessing === 'ENABLED'
    && config?.deployment?.qqOutbound === 'ENABLED';
}

/**
 * Explicit-only orchestrator. It never starts on import and never runs a timer.
 * Host starts before the gateway consumer; stop order is gateway -> host.
 */
export function createBridgeRuntime({ config, host, gateway, logger = console } = {}) {
  const state = { started: false, starting: false, enabled: false, lastError: null, history: [] };
  const log = (msg) => logger.log?.(`[bridge-runtime] ${msg}`);
  state.enabled = activationAllowed(config);
  async function start() {
    if (state.started) return { started: true, already: true };
    if (!state.enabled) { log('start refused: persona/message/outbound activation is not fully enabled'); return { started: false, blocked: 'PERSONA_ACTIVATION_DISABLED' }; }
    if (state.starting) return { started: false, blocked: 'START_IN_PROGRESS' };
    state.starting = true;
    try {
      await host.start();
      state.history.push('host.start');
      try {
        await gateway.start();
        state.history.push('gateway.start');
      } catch (e) {
        state.lastError = String(e?.message ?? e);
        try { await host.stop(); } catch { /* best effort */ }
        state.history.push('host.stop(rollback)');
        throw e;
      }
      state.started = true;
      log('started: host -> gateway');
      return { started: true };
    } finally { state.starting = false; }
  }
  async function stop({ emergency = false } = {}) {
    let gatewayError = null;
    try { if (state.started || state.starting) await gateway.stop({ emergency }); } catch (e) { gatewayError = e; state.lastError = String(e?.message ?? e); }
    try { if (state.started || state.starting) await host.stop(); } catch (e) { state.lastError ??= String(e?.message ?? e); }
    state.started = false;
    state.history.push(emergency ? 'emergency-stop' : 'stop');
    log('stopped: gateway -> host');
    if (gatewayError) throw gatewayError;
    return { stopped: true, order: ['gateway', 'host'] };
  }
  function health() {
    return { enabled: state.enabled, started: state.started, history: [...state.history], lastError: state.lastError };
  }
  return { start, stop, health };
}
