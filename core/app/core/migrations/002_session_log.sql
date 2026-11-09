-- 002: 会话事件写入面（Writer Fence 的唯一受控写入口）
--
-- 这张表在候选版本里代表「会被写进 DSH 会话的那部分状态」的最小替身：
-- 生产环境里真正的写入是 DSH 的 sessions.prompt / 事件日志；隔离环境没有
-- 真实 DSH，所以用一个同构的本地事件表来证明 fence 语义（谁持权、谁能提交、
-- 旧 writer 的延迟提交会被拒绝）。表本身不是第二套会话存储 —— 它不承载
-- DSH 事件链，也不被任何读取路径当作真相源。
CREATE TABLE IF NOT EXISTS session_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT,
  at_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_event_session ON session_event(session_id, id);
