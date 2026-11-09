import fs from 'node:fs';
import path from 'node:path';
import { createLegacyLifecycleAdapter, loadLegacyState, computeWakeSafety, nextWakeAt, planWait, looksLikeUnfinished, evaluateWakeTriggers } from './legacy-lifecycle.mjs';

const ROOT = '<WORKSPACE>/';
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'v0.3.0-r1', 'config', 'production.json'), 'utf8'));
const STATE = CONFIG.deployment.legacyLifecycleState;

/** New-Host integration handle. It is explicit-only and has no DSH/QQ dependency. */
export function createHostLifecycle({ enabled = CONFIG.deployment.autonomousScheduler === 'ENABLED', stateFile = STATE, lockFile = null, writable = false, onWake, onSkip = null, intervalMs = 5000, now, random } = {}) {
  return createLegacyLifecycleAdapter({ stateFile, lockFile, enabled, writable, config: CONFIG, onWake, onSkip, intervalMs, now, random });
}
export { loadLegacyState, computeWakeSafety, nextWakeAt, planWait, looksLikeUnfinished, evaluateWakeTriggers };
