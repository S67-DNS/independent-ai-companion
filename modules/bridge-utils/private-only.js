// OPENCORE-QQ-PRIVATE-ONLY-001：管理员私聊专用入口判定（纯函数，便于单测）。
// 只信任 cfg.ownerQQ；绝不从消息正文、显示名、群名片、群头衔或自报身份推断管理员。
// 默认拒绝：字段缺失、类型未知、来源为群聊/群临时会话，一律 false。

function ownerOf(cfg) {
  const raw = cfg?.ownerQQ;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function userIdOf(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function hasGroupSource(event) {
  if (!event || typeof event !== 'object') return true;
  if (event.message_type === 'group') return true;
  if (event.group_id !== null && event.group_id !== undefined && String(event.group_id).trim() !== '') return true;
  if (event.groupId !== null && event.groupId !== undefined && String(event.groupId).trim() !== '') return true;
  return false;
}

/** 只接受 post_type=message / message_type=private / sub_type=friend / 无 group 来源 / user_id=owner。 */
export function isAdminPrivateMessage(event, cfg) {
  if (!event || typeof event !== 'object') return false;
  if (event.post_type !== 'message') return false;
  if (event.message_type !== 'private') return false;
  if (event.sub_type !== 'friend') return false; // group/group_temp/other/缺失 一律拒绝
  if (hasGroupSource(event)) return false;
  const owner = ownerOf(cfg);
  const uid = userIdOf(event.user_id);
  if (!owner || !uid) return false;
  return uid === owner;
}

/** 仅允许管理员私聊的拍一拍；群内拍一拍、非管理员私聊拍一拍一律拒绝。 */
export function isAdminPrivatePoke(event, cfg) {
  if (!event || typeof event !== 'object') return false;
  if (event.post_type !== 'notice') return false;
  if (event.notice_type !== 'notify') return false;
  if (event.sub_type !== 'poke') return false;
  if (hasGroupSource(event)) return false;
  const owner = ownerOf(cfg);
  const uid = userIdOf(event.user_id ?? event.sender_id ?? event.sender?.user_id);
  if (!owner || !uid) return false;
  return uid === owner;
}

/** 仅允许管理员私聊的 friend_recall；群撤回和不合法私聊撤回不进入记忆链。 */
export function isAdminPrivateRecall(event, cfg) {
  if (!event || typeof event !== 'object') return false;
  if (event.post_type !== 'notice') return false;
  if (event.notice_type !== 'friend_recall') return false;
  if (hasGroupSource(event)) return false;
  const owner = ownerOf(cfg);
  const uid = userIdOf(event.user_id);
  if (!owner || !uid) return false;
  return uid === owner;
}

export function isGroupSource(event) {
  return hasGroupSource(event);
}

/** 中央闸门：只有 private:<ownerQQ> 是允许的会话 key（供唤醒定时器/HTTP 路由共用）。 */
export function isAdminPrivateKey(key, cfg) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return false;
  if (m[1] !== 'private') return false;
  const owner = ownerOf(cfg);
  const id = Number(m[2]);
  if (!owner || !Number.isSafeInteger(id) || id <= 0) return false;
  return id === owner && String(key) === `private:${owner}`;
}
