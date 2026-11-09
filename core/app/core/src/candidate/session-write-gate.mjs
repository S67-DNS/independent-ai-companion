// 会话写入的唯一受控入口（Session Write Gate）。
//
// 「无 fence 写入口关闭」不是一句口号，需要能验证的边界：
//   * 整个候选代码库里，**只有本文件**允许 `INSERT INTO session_event`；
//     只有 `writer-fence.mjs` 允许改 `writer_claim`。（由 tests/42 静态扫描守卫）
//   * 任何业务模块想写会话状态，只能调用 `write()`；它在 `withFence` 事务里执行，
//     旧 writer 的延迟提交会因为 revision/runId 不匹配而整体回滚。
//
// Binding 也走同一条路：渠道 ↔ 会话的归属关系变了，必须由当前持有 fence 的
// writer 来改，否则一次重启后的旧进程就能把会话重新绑回已退役的 Session。

import { CandidateError, ERR } from './errors.mjs';
import { tx } from './db.mjs';
import { nowMs, newId } from './util.mjs';

const requireString = (v, f) => {
  if (typeof v !== 'string' || v.trim() === '') throw new CandidateError(ERR.INVALID_ARGUMENT, `${f} 必须是非空字符串`, { field: f });
  return v;
};

export function createSessionWriter({ db, fence, now = nowMs } = {}) {
  if (!db) throw new CandidateError(ERR.INVALID_ARGUMENT, 'createSessionWriter 需要 db');
  if (!fence) throw new CandidateError(ERR.INVALID_ARGUMENT, 'createSessionWriter 需要 fence');

  function audit(kind, detail, bindingId = null, conversationKey = null) {
    db.prepare('INSERT INTO binding_audit(at_ms, binding_id, conversation_key, kind, detail) VALUES (?,?,?,?,?)')
      .run(now(), bindingId, conversationKey, kind, detail == null ? null : JSON.stringify(detail));
  }

  return {
    /**
     * 绑定（或重新绑定）渠道会话 → DSH Session。必须在持有 fence 的事务里执行。
     */
    bind({ identity, channel, conversationKey, sessionId, presetId = null, owner = null, runId, revision }) {
      requireString(identity, 'identity');
      requireString(channel, 'channel');
      requireString(conversationKey, 'conversationKey');
      requireString(sessionId, 'sessionId');
      return fence.withFence({ sessionId, runId, revision }, (txdb) => {
        const at = now();
        const existing = txdb.prepare(
          'SELECT binding_id, session_id, lifecycle_revision, state FROM channel_binding WHERE channel = ? AND conversation_key = ?',
        ).get(channel, conversationKey);
        const bindingId = existing?.binding_id ?? newId('bind');
        if (existing) {
          txdb.prepare(`UPDATE channel_binding SET identity = ?, session_id = ?, lifecycle_revision = ?,
            preset_id = ?, owner = ?, state = 'active', updated_at_ms = ? WHERE binding_id = ?`)
            .run(identity, sessionId, revision, presetId, owner, at, bindingId);
        } else {
          txdb.prepare(`INSERT INTO channel_binding(binding_id, identity, channel, conversation_key, session_id,
            lifecycle_revision, preset_id, owner, state, created_at_ms, updated_at_ms)
            VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)`)
            .run(bindingId, identity, channel, conversationKey, sessionId, revision, presetId, owner, at, at);
        }
        audit(existing ? 'rebind' : 'bind', { identity, sessionId, presetId, owner, revision }, bindingId, conversationKey);
        return { bindingId, channel, conversationKey, sessionId, revision, created: !existing };
      });
    },

    /** 退役一个绑定（渠道切换 / 会话重建前）。同样需要 fence。 */
    retire({ channel, conversationKey, runId, revision, sessionId }) {
      requireString(channel, 'channel');
      requireString(conversationKey, 'conversationKey');
      return fence.withFence({ sessionId, runId, revision }, (txdb) => {
        const at = now();
        const row = txdb.prepare('SELECT binding_id FROM channel_binding WHERE channel = ? AND conversation_key = ?')
          .get(channel, conversationKey);
        if (!row) return { retired: false, reason: 'not-found' };
        txdb.prepare("UPDATE channel_binding SET state = 'retired', updated_at_ms = ? WHERE binding_id = ?").run(at, row.binding_id);
        audit('retire', { sessionId, revision }, row.binding_id, conversationKey);
        return { retired: true, bindingId: row.binding_id };
      });
    },

    /**
     * 写一条会话事件。唯一受控写入口。
     * @returns {{id:number, sessionId:string, revision:number, kind:string}}
     */
    write({ sessionId, runId, revision, kind, payload = null }) {
      requireString(sessionId, 'sessionId');
      requireString(kind, 'kind');
      return fence.withFence({ sessionId, runId, revision }, (txdb) => {
        const at = now();
        const info = txdb.prepare(
          'INSERT INTO session_event(session_id, run_id, revision, kind, payload, at_ms) VALUES (?,?,?,?,?,?)',
        ).run(sessionId, runId, revision, kind, payload == null ? null : JSON.stringify(payload), at);
        return { id: Number(info.lastInsertRowid), sessionId, revision, kind, atMs: at };
      });
    },

    get({ channel, conversationKey }) {
      const row = db.prepare('SELECT * FROM channel_binding WHERE channel = ? AND conversation_key = ?').get(channel, conversationKey);
      return row ? {
        bindingId: row.binding_id,
        identity: row.identity,
        channel: row.channel,
        conversationKey: row.conversation_key,
        sessionId: row.session_id,
        revision: Number(row.lifecycle_revision),
        presetId: row.preset_id,
        owner: row.owner,
        state: row.state,
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
      } : null;
    },

    listActive(sessionId = null) {
      const rows = sessionId
        ? db.prepare("SELECT * FROM channel_binding WHERE state = 'active' AND session_id = ? ORDER BY updated_at_ms DESC").all(sessionId)
        : db.prepare("SELECT * FROM channel_binding WHERE state = 'active' ORDER BY updated_at_ms DESC").all();
      return rows.map((row) => ({
        bindingId: row.binding_id, identity: row.identity, channel: row.channel,
        conversationKey: row.conversation_key, sessionId: row.session_id,
        revision: Number(row.lifecycle_revision), presetId: row.preset_id, owner: row.owner,
      }));
    },

    audit(limit = 100) {
      return db.prepare('SELECT * FROM binding_audit ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(Number(limit) | 0, 1000)))
        .map((r) => ({ id: Number(r.id), atMs: Number(r.at_ms), kind: r.kind, conversationKey: r.conversation_key, detail: r.detail ? JSON.parse(r.detail) : null }));
    },

    /** 供集成层在「已经拿到 fence 但没有实体会话」时做一次显式失败（不要静默放行）。 */
    denyUnbound({ channel, conversationKey }) {
      audit('denied', { reason: 'no-binding', channel }, null, conversationKey);
      throw new CandidateError(ERR.NO_FENCE, `渠道会话 ${channel}/${conversationKey} 没有有效绑定`, { channel, conversationKey });
    },
  };
}
