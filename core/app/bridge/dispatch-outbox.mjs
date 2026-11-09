import fs from 'node:fs';
import { createCandidateService } from '../core/src/candidate/service.mjs';
import { createOneBotDeliveryProvider, createGuardedDispatcher } from './onebot-delivery.mjs';

const CONFIG_PATH = '<WORKSPACE>/';
const SNOW = '<WORKSPACE>/';
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const onebot = JSON.parse(fs.readFileSync(SNOW + '\\config\\onebot_20000004.json', 'utf8').replace(/^\uFEFF/, ''));
const mode = process.argv[2] ?? '--status';
const c = config.core;
const service = createCandidateService({ root: c.root, dbPath: c.dbPath, memoryRoot: c.memoryRoot, stateDir: c.stateDir, rolesDir: c.rolesDir, presetsDir: c.presetsDir });
try {
  const provider = createOneBotDeliveryProvider({ base: 'http://127.0.0.1:3000', token: onebot.networks.httpServers[0].accessToken });
  const dispatcher = createGuardedDispatcher({ service, provider, config, env: process.env });
  if (mode === '--status') {
    console.log(JSON.stringify({ status: 'status-only', dispatcher: dispatcher.status(), pending: service.status().outbox, activation: { persona: config.deployment.personaActivation, messageProcessing: config.deployment.messageProcessing, qqOutbound: config.deployment.qqOutbound }, commanderEnv: process.env.OPENCORE_ALLOW_QQ_OUTBOUND === '1', realSend: false }, null, 2));
  } else if (mode === '--once') {
    const r = await dispatcher.dispatchOnce({ limit: 1 });
    console.log(JSON.stringify({ mode: 'once', result: r, realSend: dispatcher.enabled }, null, 2));
    if (!r.ok) process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ error: 'use --status or --once' }));
    process.exitCode = 2;
  }
} finally { service.close(); }
