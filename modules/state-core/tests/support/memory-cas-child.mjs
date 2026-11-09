// 并发 CAS 测试用的真实子进程。
//
// 父进程先做好 adopt + reserve，再把「同一张 reservation、同一个 writerIdentity、
// 不同内容」交给两个子进程，让它们在同一个 go 信号之后同时 write。
// 正常结果是：恰好一个成功，另一个被 CAS 拦下，且磁盘只留下成功者的内容。
//
// 结果写到文件（不通过管道回传），避免受限环境下 piped stdio 的限制。

import fs from 'node:fs';
import { openDb } from '../../src/candidate/db.mjs';
import { createMemoryStore } from '../../src/candidate/memory-provenance.mjs';

const env = process.env;
const config = {
  root: env.MEMORY_CAS_ROOT,
  dbPath: env.MEMORY_CAS_DB,
  relPath: env.MEMORY_CAS_REL,
  reservationId: env.MEMORY_CAS_RESERVATION,
  expectedHash: env.MEMORY_CAS_EXPECTED_HASH,
  writerIdentity: env.MEMORY_CAS_WRITER ?? 'authority',
  content: Buffer.from(env.MEMORY_CAS_CONTENT_B64 ?? '', 'base64').toString('utf8'),
  readyPath: env.MEMORY_CAS_READY,
  goPath: env.MEMORY_CAS_GO,
  resultPath: env.MEMORY_CAS_RESULT,
  attempt: Number(env.MEMORY_CAS_ATTEMPT ?? '0'),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.writeFileSync(config.readyPath, 'ready', 'utf8');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(config.goPath)) {
    if (Date.now() > deadline) {
      fs.writeFileSync(config.resultPath, JSON.stringify({ ok: false, error: 'go-timeout' }), 'utf8');
      process.exit(3);
    }
    await sleep(2);
  }
  const db = openDb(config.dbPath, { migrate: false });
  const store = createMemoryStore({ root: config.root, db });
  let result;
  try {
    const written = store.write({
      relPath: config.relPath,
      content: config.content,
      writerIdentity: config.writerIdentity,
      reservationId: config.reservationId,
      expectedHash: config.expectedHash,
    });
    result = { ok: true, attempt: config.attempt, generation: written.generation, hash: written.hash };
  } catch (error) {
    result = {
      ok: false,
      attempt: config.attempt,
      code: error?.code ?? null,
      message: String(error?.message ?? error),
      problems: error?.detail?.problems ?? null,
    };
  }
  db.close();
  fs.writeFileSync(config.resultPath, JSON.stringify(result), 'utf8');
}

main().catch((error) => {
  fs.writeFileSync(config.resultPath, JSON.stringify({
    ok: false,
    error: 'child-crash',
    message: String(error?.stack ?? error),
  }), 'utf8');
  process.exit(1);
});
