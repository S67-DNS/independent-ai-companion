// 候选版本统一错误类型。
//
// 设计约束：调用方按 `code` 分支，**不按 message 分支**（message 是给人看的）。
// 所有机制层（Writer Fence / Memory Provenance / Delivery Outbox / Follow Client）
// 失败时都必须抛带 code 的 CandidateError，并且默认是 fail-closed 语义：
// 不确定就进入 unknown/blocked，不猜测成功、不自动重投。

export const ERR = Object.freeze({
  INVALID_ARGUMENT: 'invalid-argument',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',

  // Writer fence
  FENCE_LOST: 'fence-lost',
  LEASE_EXPIRED: 'lease-expired',
  WRITER_BUSY: 'writer-busy',
  NO_FENCE: 'no-fence',

  // Memory provenance / CAS
  CAS_MISMATCH: 'cas-mismatch',
  UNTRUSTED_MEMORY: 'untrusted-memory',
  MEMORY_DRIFT: 'memory-drift',
  RESERVATION_INVALID: 'reservation-invalid',

  // Delivery outbox
  DELIVERY_UNKNOWN: 'delivery-unknown',
  DELIVERY_NOT_RECONCILABLE: 'delivery-not-reconcilable',
  DELIVERY_LEASE_LOST: 'delivery-lease-lost',

  // Protocol / upstream
  UPSTREAM: 'upstream-error',
  TIMEOUT: 'timeout',
  CONTRACT: 'contract-violation',
  CAPABILITY_UNAVAILABLE: 'capability-unavailable',
  BLOCKED: 'blocked',
  INTERNAL: 'internal',
});

export class CandidateError extends Error {
  /** @param {string} code @param {string} message @param {object} [detail] */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'CandidateError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }

  static from(error, fallbackCode = ERR.INTERNAL) {
    if (error instanceof CandidateError) return error;
    const code = error && typeof error.code === 'string' && Object.values(ERR).includes(error.code)
      ? error.code
      : fallbackCode;
    return new CandidateError(code, String(error?.message ?? error), { cause: String(error?.stack ?? '') });
  }
}

export function isCode(error, ...codes) {
  return error instanceof CandidateError && codes.includes(error.code);
}
