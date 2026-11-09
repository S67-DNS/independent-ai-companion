import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENABLE_FILE = path.join(ROOT, 'state', 'mcp-send-enabled.json');
const LOAD_MARKER = path.join(ROOT, 'state', 'mcp-send-policy-loaded.json');

// Runtime evidence that this exact MCP generation actually imported the policy.
try {
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(LOAD_MARKER, JSON.stringify({
    pid: process.pid,
    loadedAt: new Date().toISOString(),
    node: process.version,
    policy: enabled() ? 'QQ_OUTBOUND_ENABLED' : 'QQ_OUTBOUND_DISABLED',
    guardPoints: ['agentApi', 'agentApiLongPoll', 'onebot'],
    policyFile: fileURLToPath(import.meta.url),
    enabled: enabled()
  }, null, 2));
} catch { /* marker is diagnostic only; policy remains fail-closed */ }

// Central QQ outbound paths used by the active MCP server. Read-only paths are
// deliberately not listed. Default is deny. Authorization accepts either the
// commander environment flag or the stronger, locally persisted mode-B operator
// authorization. The latter can take effect on an MCP-only reload, without a
// DSH restart or a second environment truth source.
const SEND_PATHS = [
  /^\/api\/send\/(group|reply|private|image|file)(?:[?#]|$)/,
  /^\/api\/socialV2\/send-(?:burst|message|poke|sticker|voice)(?:[?#]|$)/,
  /^\/api\/qzone\/(?:post|delete)(?:[?#]|$)/,
  /^\/api\/self\/profile(?:[?#]|$)/,
];
const SEND_ACTIONS = /^(?:send_|set_|qzone_|set_self_|set_profile|set_avatar)/;

function enabled() {
  try {
    const v = JSON.parse(fs.readFileSync(ENABLE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (v?.enabled !== true || v?.commanderAuthorized !== true) return false;
    if (process.env.OPENCORE_MCP_SEND_ALLOW === '1') return true;
    return v?.mode === 'B' && v?.updatedBy === 'operator';
  } catch { return false; }
}

export function isMcpSendPath(p) {
  return SEND_PATHS.some((re) => re.test(String(p ?? '')));
}

export function assertMcpOutboundAllowed(p) {
  if (!isMcpSendPath(p)) return;
  if (!enabled()) {
    const error = new Error('QQ_OUTBOUND_DISABLED: MCP send is disabled until explicit commander activation');
    error.code = 'QQ_OUTBOUND_DISABLED';
    error.path = p;
    throw error;
  }
}

export function assertMcpOneBotActionAllowed(action) {
  if (!SEND_ACTIONS.test(String(action ?? ''))) return;
  if (!enabled()) {
    const error = new Error('QQ_OUTBOUND_DISABLED: MCP OneBot send action is disabled until explicit commander activation');
    error.code = 'QQ_OUTBOUND_DISABLED';
    error.action = action;
    throw error;
  }
}

export function mcpSendPolicyStatus() {
  const isEnabled = enabled();
  return { enabled: isEnabled, enableFile: ENABLE_FILE, outbound: isEnabled ? 'ENABLED' : 'DISABLED' };
}
