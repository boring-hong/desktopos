const { ShellWorker } = require('../src/shell-worker/index.js');

(async () => {
  const w = new ShellWorker({ cmdTimeout: 15000 });
  await w.start();

  const cases = [
    ['找不到路径(默认)', 'Get-Item -LiteralPath "C:\\__nope__"'],
    ['找不到路径(带2>&1)', 'Get-Item -LiteralPath "C:\\__nope__" 2>&1'],
    ['不存在命令', 'ThisIsNotACommand'],
    ['正常输出', 'Write-Output "ok"'],
    ['原生命令stderr', 'cmd.exe /c "echo oops 1>&2"'],
  ];

  for (const [label, cmd] of cases) {
    try {
      const r = await w.execFull(cmd);
      console.log(label.padEnd(20), JSON.stringify(r));
    } catch (e) {
      console.log(label.padEnd(20), 'THREW: ' + e.message);
    }
  }

  await w.stop();
})().catch((e) => { console.error(e); process.exit(1); });
