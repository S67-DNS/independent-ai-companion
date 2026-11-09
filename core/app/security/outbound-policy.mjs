export const OUTBOUND_DECISION = Object.freeze({
  ALLOW: 'ALLOW',
  DENY_PERSONA_DISABLED: 'PERSONA_ACTIVATION_DISABLED',
  DENY_OUTBOUND_DISABLED: 'QQ_OUTBOUND_DISABLED',
  DENY_REQUIRES_COMMANDER: 'REQUIRES_COMMANDER_AUTHORIZATION',
});

const SEND_TOOLS = new Set([
  'qq_send_message', 'qq_reply', 'qq_send_private_message', 'qq_send_group_message',
  'qq_send_image', 'qq_send_sticker', 'qq_send_voice', 'qq_say', 'qq_send_file',
  'qq_send_poke', 'qq_send_burst', 'qq_send_qzone', 'qq_send_meme',
]);

export function decideOutbound(config, { tool = null, channel = 'qq' } = {}) {
  if (config?.deployment?.personaActivation !== 'ENABLED') return { allow: false, reason: OUTBOUND_DECISION.DENY_PERSONA_DISABLED };
  if (config?.deployment?.qqOutbound !== 'ENABLED') return { allow: false, reason: OUTBOUND_DECISION.DENY_OUTBOUND_DISABLED };
  if (tool && SEND_TOOLS.has(String(tool))) return { allow: false, reason: OUTBOUND_DECISION.DENY_REQUIRES_COMMANDER };
  return { allow: false, reason: OUTBOUND_DECISION.DENY_REQUIRES_COMMANDER };
}

export function guardMcpSend(config, tool, args = null) {
  const decision = decideOutbound(config, { tool });
  if (!decision.allow) {
    const error = new Error(`QQ outbound blocked: ${decision.reason}`);
    error.code = 'QQ_OUTBOUND_DISABLED';
    error.decision = decision;
    error.tool = tool;
    error.args = args;
    throw error;
  }
  return decision;
}
