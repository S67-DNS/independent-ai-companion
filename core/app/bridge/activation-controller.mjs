import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProductionConfig, activationAllowed, createBridgeRuntime } from './bridge-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = loadProductionConfig();
const MODE = process.argv[2] ?? '--status';
const APPROVED = process.env.OPENCORE_ACTIVATION_APPROVED === '1';

function print(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

async function main() {
  const enabled = activationAllowed(CONFIG);
  if (MODE === '--status') {
    print({ mode: 'status', enabled, personaActivation: CONFIG.deployment.personaActivation, messageProcessing: CONFIG.deployment.messageProcessing, qqOutbound: CONFIG.deployment.qqOutbound, approved: APPROVED, host: 'not started', gateway: 'not started', note: 'No side effects.' });
    return;
  }
  if (MODE !== '--start' && MODE !== '--stop') { print({ ok: false, error: 'use --status, --start or --stop' }); process.exit(2); }
  if (MODE === '--start' && (!enabled || !APPROVED)) {
    print({ ok: false, blocked: !enabled ? 'PERSONA_ACTIVATION_DISABLED' : 'COMMANDER_APPROVAL_REQUIRED', enabled, approved: APPROVED });
    return;
  }
  if (MODE === '--stop') {
    print({ ok: true, stopped: true, note: 'No auto-started process in this build; stop external Host/GatewayAdapter explicitly.' });
    return;
  }
  const host = { start: async () => {}, stop: async () => {} };
  const gateway = { start: async () => { throw new Error('GATEWAY_START_NOT_WIRED_IN_CONTROLLER'); }, stop: async () => {} };
  const runtime = createBridgeRuntime({ config: CONFIG, host, gateway });
  try { print({ ok: true, result: await runtime.start(), health: runtime.health() }); }
  catch (e) { print({ ok: false, error: String(e.message), health: runtime.health() }); process.exit(1); }
}

await main();
