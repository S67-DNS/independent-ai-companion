// 故障注入：按环境变量 OPENCORE_CRASH_AT 在指定检查点强杀当前进程。
//
// 为什么用 SIGKILL 而不是 process.exit：exit 会跑 finally/atexit，测不出
// 「事务已开始但未提交」的真实崩溃窗口。SIGKILL 让进程停在指令之间，
// 落盘/落库的中间态才会被保留下来，恢复逻辑才有意义。
//
// 用法（子进程脚本）：
//   crashpoint('claim-after');       // 命中即死
//   crashpoint.maybe('before-ack'); // 同义
//   crashpoint.point;               // 当前配置的崩溃点

const configured = () => process.env.OPENCORE_CRASH_AT || '';

export function crashpoint(name) {
  if (!name) return false;
  if (configured() !== name) return false;
  // 先尽力把已写内容推到磁盘，再死 —— 模拟「写了一半」而不是「根本没写」。
  try {
    process.stderr.write(`[crashpoint] hit ${name} (pid=${process.pid}) -> SIGKILL\n`);
    process.stderr.write(''); // flush
  } catch { /* ignore */ }
  process.kill(process.pid, 'SIGKILL');
  // 不可达；保险起见再 exit 一次。
  process.exit(137);
  return true;
}

crashpoint.maybe = crashpoint;
crashpoint.enabled = () => Boolean(configured());
crashpoint.point = () => configured();

export default crashpoint;
