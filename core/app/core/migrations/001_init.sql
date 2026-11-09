-- OPENCORE-CONSTRUCTION-001 / candidate schema v1
-- 单一 SQLite 数据库（PROJECT_NAME控制面）。不引入第二通用队列、不引入第二权威记忆系统：
-- 这些表都是PROJECT_NAME既有 state 持久化的扩展，正文仍留在原来的权威文件中。
--
-- 约定：
--   * 所有 *_at_ms / *_expires_at_ms 都是 Unix epoch 毫秒（整数）。
--   * 所有写会话/记忆/投递的事务必须 BEGIN IMMEDIATE，并在 COMMIT 前复核 fence。
--   * 失败一律 fail-closed：宁可把状态留在 unknown，也不猜测成功。

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── A. Writer ownership / session fencing ────────────────────────────────────
CREATE TABLE IF NOT EXISTS writer_claim (
  session_id            TEXT PRIMARY KEY,
  lifecycle_revision    INTEGER NOT NULL DEFAULT 0,
  active_writer_run_id  TEXT,
  owner_identity        TEXT,
  owner_pid             INTEGER,
  owner_pid_start_ticks TEXT,          -- 防 pid 复用：进程创建时间（Windows FILETIME/Unix starttime）
  owner_nonce           TEXT,
  state                 TEXT NOT NULL DEFAULT 'idle',   -- idle | active
  claimed_at_ms         INTEGER NOT NULL DEFAULT 0,
  heartbeat_at_ms       INTEGER NOT NULL DEFAULT 0,
  lease_expires_at_ms   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS writer_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms       INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- claim | renew | release | denied | fence-lost | takeover
  run_id      TEXT,
  revision    INTEGER,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_writer_audit_session ON writer_audit(session_id, id);

-- ── B. Authority memory provenance / CAS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_registry (
  path            TEXT PRIMARY KEY,     -- 相对 memory 根的规范化路径（posix 分隔符）
  content_hash    TEXT NOT NULL,        -- sha256 hex
  size            INTEGER NOT NULL,
  file_identity   TEXT NOT NULL,        -- dev:ino:birthtimeMs（同路径替换 / 同字节重建的区分依据）
  generation      INTEGER NOT NULL,     -- 每次权威写入 +1
  writer_identity TEXT NOT NULL,        -- 写入者身份（authority / agent:<id> / shell:external）
  trust           TEXT NOT NULL,        -- authority | trusted | untrusted | drift
  updated_at_ms   INTEGER NOT NULL,
  reservation_id  TEXT
);

CREATE TABLE IF NOT EXISTS memory_reservation (
  reservation_id      TEXT PRIMARY KEY,
  path                TEXT NOT NULL,
  expected_hash       TEXT NOT NULL,
  expected_generation INTEGER NOT NULL,
  writer_identity     TEXT NOT NULL,
  created_at_ms       INTEGER NOT NULL,
  expires_at_ms       INTEGER NOT NULL,
  state               TEXT NOT NULL DEFAULT 'open'   -- open | committed | rolled-back | expired
);

CREATE TABLE IF NOT EXISTS memory_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms          INTEGER NOT NULL,
  path           TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- adopt | reserve | write | cas-reject | external-change | drift | rollback | quarantine
  generation     INTEGER,
  content_hash   TEXT,
  writer         TEXT,
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_audit_path ON memory_audit(path, id);

-- ── C. Persistent delivery outbox ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery (
  delivery_id         TEXT PRIMARY KEY,
  channel             TEXT NOT NULL,
  target              TEXT NOT NULL,
  session_id          TEXT,
  idempotency_key     TEXT,
  idempotent          INTEGER NOT NULL DEFAULT 0,
  reconcile_support   TEXT NOT NULL DEFAULT 'none',  -- query | none
  payload             TEXT NOT NULL,
  parts_total         INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'pending',
  -- pending | claimed | sending | sent | partial | unknown_after_send | failed | manual
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  current_attempt_id  TEXT,
  owner_pid           INTEGER,
  owner_pid_start_ticks TEXT,
  owner_nonce         TEXT,
  lease_expires_at_ms INTEGER,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL,
  sent_at_ms          INTEGER,
  last_error          TEXT,
  resolution          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_idem
  ON delivery(channel, target, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_state ON delivery(state, created_at_ms);

CREATE TABLE IF NOT EXISTS delivery_attempt (
  attempt_id        TEXT PRIMARY KEY,
  delivery_id       TEXT NOT NULL,
  n                 INTEGER NOT NULL,
  claimed_at_ms     INTEGER NOT NULL,
  send_started_at_ms INTEGER,
  ended_at_ms       INTEGER,
  phase             TEXT NOT NULL,  -- claimed | send_started | ack_received | failed | unknown
  outcome           TEXT,
  owner_nonce       TEXT,
  detail            TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempt_delivery ON delivery_attempt(delivery_id, n);

CREATE TABLE IF NOT EXISTS delivery_part_receipt (
  attempt_id  TEXT NOT NULL,
  part_no     INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  receipt     TEXT,
  at_ms       INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, part_no)
);

-- ── D. Preset registry / session binding / C0 continuity ─────────────────────
CREATE TABLE IF NOT EXISTS preset_registry (
  preset_id     TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  source_path   TEXT,
  resolved_at_ms INTEGER NOT NULL,
  valid         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS session_binding (
  session_id        TEXT PRIMARY KEY,
  preset_id         TEXT NOT NULL,
  preset_fingerprint TEXT NOT NULL,
  owner             TEXT,
  workspace         TEXT,
  cwd               TEXT,
  role              TEXT,
  event_chain_head  INTEGER,
  origin            TEXT NOT NULL DEFAULT 'candidate',  -- candidate | c0-readonly
  created_at_ms     INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'active'      -- active | retired
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  checksum   TEXT NOT NULL
);
