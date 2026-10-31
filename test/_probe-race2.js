/**
 * 冷启动并发探针（干净版）：直接看 spawn 出来的子进程 PID，
 * 不依赖 CIM 命令行匹配（那样会把自己也算进去）。
 */
const { ShellWorker } = require('../src/shell-worker/index.js');

async function main() {
  const spawned = [];   // 所有真实 spawn 出来的 worker 实例
  const origCtor = ShellWorker.prototype.start;

  let worker = null;
  async function ensureWorker() {
    if (worker && worker.alive) return worker;
    const w = new ShellWorker({ initialCwd: process.cwd(), timeout: 60000 });
    spawned.push(w);
    worker = w;
    await w.start();
    return w;
  }

  const t0 = Date.now();
  const rs = await Promise.all([
    ensureWorker(), ensureWorker(), ensureWorker(), ensureWorker(), ensureWorker(),
  ]);

  const uniqReturned = new Set(rs);
  const livePids = spawned.filter((w) => w._ps && w._ps.pid && !w._ps.killed);

  console.log('并发调用次数      :', 5);
  console.log('实际 new 出的实例 :', spawned.length);
  console.log('返回的实例种类    :', uniqReturned.size);
  console.log('存活的子进程 PID  :', livePids.map((w) => w._ps.pid).join(', '));
  console.log('存活的监听端口    :', livePids.map((w) => w._port).join(', '));
  console.log('耗时              :', Date.now() - t0, 'ms');

  // 只把"被引用"的那个算作有效，其余即泄漏
  const leaked = spawned.filter((w) => w !== worker);
  console.log('\n=== 判定 ===');
  console.log('泄漏实例数        :', leaked.length);
  if (leaked.length > 0) {
    console.log('BUG: 并发冷启动创建了多余 worker，且无人引用（进程 + 端口泄漏）');
  } else {
    console.log('OK: 单例成立');
  }

  for (const w of spawned) { try { w._ps.kill(); } catch {} }
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
