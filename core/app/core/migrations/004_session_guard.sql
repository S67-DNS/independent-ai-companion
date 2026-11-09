-- 004: Desktop 第二写入者检测（P1-2）
--
-- DSH 本身没有「写入者 lease」：Desktop UI 与PROJECT_NAME可以同时往同一个 Session 写。
-- 现有 Writer Fence 只能约束**PROJECT_NAME自己的**写入，约束不了 DSH UI。因此这里补一层
-- 可验证的**检测**：PROJECT_NAME给每个 prompt 铸一个 requestId（DSH 会把它持久化成
-- user/message.source.rpcId），事件流里出现不认识的 rpcId ⇒ 存在第二写入者。
--
-- 检测到之后的行为：该 Session 进入 foreign-writer 状态，PROJECT_NAME**停止发起新 prompt**，
-- 并把状态写进审计；必须人工核对后用 /api/candidate/clear-write-block 解除。
-- 这是「可识别、可恢复」的最小边界，不是全局写锁（做不到的事不假装做到）。
CREATE TABLE IF NOT EXISTS own_request (
  request_id TEXT PRIMARY KEY,
  session_id TEXT,
  at_ms      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_guard (
  session_id     TEXT PRIMARY KEY,
  state          TEXT NOT NULL DEFAULT 'clear',   -- clear | foreign-writer
  foreign_rpc_id TEXT,
  foreign_count  INTEGER NOT NULL DEFAULT 0,
  at_ms          INTEGER NOT NULL,
  cleared_at_ms  INTEGER,
  detail         TEXT
);

CREATE TABLE IF NOT EXISTS guard_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms      INTEGER NOT NULL,
  session_id TEXT,
  kind       TEXT NOT NULL,   -- own-request | foreign-detected | assert-blocked | clear
  rpc_id     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_guard_audit_session ON guard_audit(session_id, id);
