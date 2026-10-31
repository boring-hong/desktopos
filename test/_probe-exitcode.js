const { ShellWorker } = require('../src/shell-worker/index.js');
(async () => {
  const w = new ShellWorker({});
  await w.start();

  // 1) 先跑一个会失败的原生命令，污染 $LASTEXITCODE
  const a = await w.execFull('cmd /c exit 3');
  console.log('native fail  ->', JSON.stringify({exitCode:a.exitCode, out:a.output, err:a.error}));

  // 2) 紧接着跑一个纯 PowerShell 命令（不碰 $LASTEXITCODE）
  const b = await w.execFull('Write-Output "pure-ps-ok"');
  console.log('pure PS      ->', JSON.stringify({exitCode:b.exitCode, out:b.output}));

  // 3) 再跑一个纯 PS 命令
  const c = await w.execFull('Get-Date -Format yyyy');
  console.log('pure PS #2   ->', JSON.stringify({exitCode:c.exitCode, out:c.output}));

  // 4) 验证 $LASTEXITCODE 的实际值
  const d = await w.execFull('Write-Output "LASTEXITCODE=$LASTEXITCODE"');
  console.log('lex probe    ->', JSON.stringify({exitCode:d.exitCode, out:d.output}));

  // 5) 复现：res.exitCode || 0 对 -1 的处理
  const e = await w.execFull('cmd /c exit -1');
  console.log('negative     ->', JSON.stringify({exitCode:e.exitCode}));

  await w.stop();
})().catch(e => { console.error('FAIL', e); process.exit(1); });

