-- 003: 身份 ↔ 渠道 Binding
--
-- PROJECT_NAME掌握核心主体身份与渠道绑定；DSH 只负责执行。渠道（QQ / 本地窗口 / …）
-- 只是协议适配器，不能自己保存「这段会话属于谁」。
--
-- binding 变更必须带上写入者当前持有的 lifecycle_revision（由 Writer Fence 提供），
-- 否则一次「旧 writer 延迟写」就会把会话重新绑回已经退役的 Session。
CREATE TABLE IF NOT EXISTS channel_binding (
  binding_id         TEXT PRIMARY KEY,
  identity           TEXT NOT NULL,     -- roles/<role>.md 的 role 名
  channel            TEXT NOT NULL,     -- qq | local-window | cli ...
  conversation_key   TEXT NOT NULL,     -- private:<id> / group:<id> / local:<uuid>
  session_id         TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL,
  preset_id          TEXT,
  owner              TEXT,
  state              TEXT NOT NULL DEFAULT 'active',   -- active | retired
  created_at_ms      INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL,
  UNIQUE(channel, conversation_key)
);
CREATE INDEX IF NOT EXISTS idx_binding_session ON channel_binding(session_id, state);

CREATE TABLE IF NOT EXISTS binding_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms          INTEGER NOT NULL,
  binding_id     TEXT,
  conversation_key TEXT,
  kind           TEXT NOT NULL,   -- bind | rebind | retire | denied
  detail         TEXT
);
