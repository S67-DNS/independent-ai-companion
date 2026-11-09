-- 005: 出站意图全局唯一（delivery_intent）+ 投递引用列 + 结算 epoch
--
-- 设计依据：fixes/c-send-design/C-HARDENING.md §A（幂等全局唯一）/ §B.4（settlement_epoch CAS）
--
-- 要点：
--   * 全局唯一由 delivery_intent.intent_id PRIMARY KEY 保证（不是 delivery.intent_id）；
--   * delivery.intent_id 可空、非唯一（一个意图可对应 N 条投递：多气泡）；
--   * 历史行 intent_id 允许 NULL（不参与新约束）；
--   * settlement_epoch 用于"迟到 reconcile 不得反写终态"的 CAS（每行每次结算 +1）。
--
-- 幂等：由 db.mjs 的 schema_migrations（version+checksum）保证只执行一次；
--       手工执行请用 tools/migrate-delivery-intent.mjs（带 pragma 检查/事务/幂等标记）。

CREATE TABLE IF NOT EXISTS delivery_intent (
  intent_id      TEXT PRIMARY KEY,
  channel        TEXT NOT NULL,
  target         TEXT NOT NULL,
  tool           TEXT NOT NULL,
  source         TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'accepted',
  delivery_ids   TEXT NOT NULL DEFAULT '[]',
  message_ids    TEXT NOT NULL DEFAULT '[]',
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  settled_at_ms  INTEGER,
  last_error     TEXT,
  CHECK (length(intent_id) BETWEEN 8 AND 128),
  CHECK (state IN ('accepted','sent','failed','unknown_after_send')),
  CHECK (json_valid(delivery_ids)),
  CHECK (json_valid(message_ids))
);

CREATE INDEX IF NOT EXISTS idx_delivery_intent_created
  ON delivery_intent(created_at_ms DESC);

-- 历史行保持 NULL；不建唯一索引（1 意图 → N 投递）
ALTER TABLE delivery ADD COLUMN intent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_delivery_intent_ref
  ON delivery(intent_id) WHERE intent_id IS NOT NULL;

-- 所有状态迁移自增：迟到 reconcile 用 CAS 比较该值
ALTER TABLE delivery ADD COLUMN settlement_epoch INTEGER NOT NULL DEFAULT 0;
