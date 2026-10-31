const { ShellWorker } = require('../src/shell-worker/index.js');

const withTimeout = (p, ms, label) => Promise.race([
  p.then(() => `${label}: resolved`).catch((e) => `${label}: rejected(${e.message})`),
  new Promise((r) => setTimeout(() => r(`${label}: STILL PENDING after ${ms}ms`), ms)),
]);

(async () => {
  const w = new ShellWorker({ cmdTimeout: 2000 });
  await w.start();
  console.log('started');

  console.log('--- 1) 正常命令 ---');
  console.log(await withTimeout(w.execFull('Write-Output ok'), 5000, 'ok-cmd'));

  console.log('--- 2) 故意跑一个超长命令（JS 侧 2s 超时）---');
  console.log(await withTimeout(w.execFull('Start-Sleep -Seconds 30'), 6000, 'long-cmd'));

  console.log('--- 3) 超时后立刻再跑一个普通命令 ---');
  console.log(await withTimeout(w.execFull('Write-Output after-timeout'), 6000, 'after-timeout'));

  console.log('--- 4) 关键：stop() 能不能救回来？---');
  console.log(await withTimeout(w.stop(), 6000, 'stop'));

  console.log('--- 5) reset 语义：stop 后再 start ---');
  console.log(await withTimeout(w.start(), 6000, 'restart'));

  console.log('--- 6) 重启后能否 exec ---');
  console.log(await withTimeout(w.execFull('Write-Output after-restart'), 6000, 'after-restart'));

  // 清理：强制 kill
  try { w._ps.kill(); } catch {}
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
