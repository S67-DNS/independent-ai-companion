// Read-only adapter for the formal OneBot event shape and admin-private policy.
// It never sends; it only decides whether an event may enter the core.
function ownerOf(config) {
  const raw = config?.ownerQQ ?? config?.expected?.ownerQQ;
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function userIdOf(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function hasGroupSource(event) {
  if (!event || typeof event !== 'object') return true;
  if (event.message_type === 'group') return true;
  if (event.group_id !== null && event.group_id !== undefined && String(event.group_id).trim() !== '') return true;
  if (event.groupId !== null && event.groupId !== undefined && String(event.groupId).trim() !== '') return true;
  return false;
}
export function decideInbound(event, config) {
  const owner = ownerOf(config);
  if (!event || typeof event !== 'object') return { allow: false, reason: 'invalid-event' };
  if (event.post_type !== 'message') return { allow: false, reason: 'not-message' };
  if (event.message_type !== 'private') return { allow: false, reason: 'not-private' };
  if (event.sub_type !== 'friend') return { allow: false, reason: 'not-friend' };
  if (hasGroupSource(event)) return { allow: false, reason: 'group-source' };
  const uid = userIdOf(event.user_id);
  if (!owner || !uid) return { allow: false, reason: 'bad-identity' };
  if (uid !== owner) return { allow: false, reason: 'not-owner' };
  const allowPrivate = (config.allow?.private ?? []).map(String);
  const denyPrivate = (config.deny?.private ?? []).map(String);
  const key = `private:${uid}`;
  if (denyPrivate.includes(String(uid))) return { allow: false, reason: 'denied' };
  if (allowPrivate.length > 0 && !allowPrivate.includes(String(uid))) return { allow: false, reason: 'not-allowlisted' };
  if (allowPrivate.length === 0 && config.allowAllWhenEmpty !== true) return { allow: false, reason: 'empty-allowlist-fail-closed' };
  return { allow: true, reason: 'admin-private-owner', key, owner: String(owner) };
}
/**
 * 撤回通知（OneBot v11 notice/friend_recall）的入站判定。
 *
 * 与 decideInbound 分开：撤回不是 message，语义与消息链不同（不能进 standby 队列、
 * 不能触发 DSH）。但授权边界完全一致——只允许管理员私聊、deny 优先、allow 非空必须命中。
 * 群撤回（group_recall）在这里显式拒绝，与旧桥 private-only 策略一致。
 *
 * @returns {{allow:boolean, reason:string, key?:string, mid?:string, owner?:string}}
 */
export function decideRecallNotice(event, config) {
  const owner = ownerOf(config);
  if (!event || typeof event !== 'object') return { allow: false, reason: 'invalid-event' };
  if (event.post_type !== 'notice') return { allow: false, reason: 'not-notice' };
  if (event.notice_type === 'group_recall') return { allow: false, reason: 'group-recall' };
  if (event.notice_type !== 'friend_recall') return { allow: false, reason: 'not-friend-recall' };
  if (hasGroupSource(event)) return { allow: false, reason: 'group-source' };
  const uid = userIdOf(event.user_id);
  if (!owner || !uid) return { allow: false, reason: 'bad-identity' };
  if (uid !== owner) return { allow: false, reason: 'not-owner' };
  const rawMid = event.message_id ?? event.msg_id;
  const mid = rawMid === null || rawMid === undefined ? '' : String(rawMid).trim();
  if (!mid) return { allow: false, reason: 'missing-mid' };
  const allowPrivate = (config.allow?.private ?? []).map(String);
  const denyPrivate = (config.deny?.private ?? []).map(String);
  const key = `private:${uid}`;
  if (denyPrivate.includes(String(uid))) return { allow: false, reason: 'denied' };
  if (allowPrivate.length > 0 && !allowPrivate.includes(String(uid))) return { allow: false, reason: 'not-allowlisted' };
  if (allowPrivate.length === 0 && config.allowAllWhenEmpty !== true) return { allow: false, reason: 'empty-allowlist-fail-closed' };
  return { allow: true, reason: 'admin-private-recall', key, mid, owner: String(owner) };
}
export const fixtures = {
  adminPrivate: { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 20000001, sender: { user_id: 20000001 }, raw_message: 'test' },
  strangerPrivate: { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 20000002, sender: { user_id: 20000002 }, raw_message: 'test' },
  groupMessage: { post_type: 'message', message_type: 'group', sub_type: 'normal', user_id: 20000001, group_id: 123456, raw_message: 'test' },
  groupPrivate: { post_type: 'message', message_type: 'private', sub_type: 'group', user_id: 20000001, group_id: 123456, raw_message: 'test' },
  missingSubType: { post_type: 'message', message_type: 'private', user_id: 20000001, raw_message: 'test' },
  adminPrivateRecall: { post_type: 'notice', notice_type: 'friend_recall', user_id: 20000001, message_id: 900001, self_id: 20000002, time: 20000003 },
  strangerPrivateRecall: { post_type: 'notice', notice_type: 'friend_recall', user_id: 20000002, message_id: 900002, self_id: 20000002, time: 20000003 },
  groupRecall: { post_type: 'notice', notice_type: 'group_recall', user_id: 20000001, group_id: 123456, message_id: 900003, self_id: 20000002, time: 20000003 },
  recallMissingMid: { post_type: 'notice', notice_type: 'friend_recall', user_id: 20000001, self_id: 20000002, time: 20000003 },
};
