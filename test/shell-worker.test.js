/**
 * Shell Worker 测试
 * 重点回归：中文路径 cd。
 * 旧的 stdin 管道方案在此必挂 —— PowerShell 用 CP936 解码管道输入，
 * UTF-8 中文被打成乱码。新方案走 HTTP + base64，应稳定通过。
 */

const path = require('path');
const { ShellWorker } = require('../src/shell-worker/index.js');

const PROJECT_DIR = path.resolve(__dirname, '..'); // 含中文: ...\代码\desktopos

let pass = 0;
let fail = 0;

function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

(async () => {
  const w = new ShellWorker({ initialCwd: PROJECT_DIR, cmdTimeout: 20000 });
  w.on('error', (e) => console.log('  [worker error]', e.message));

  console.log('\n--- 1. 启动 worker ---');
  await w.start();
  assert('worker alive', w.alive === true);

  console.log('\n--- 2. 基础 exec ---');
  const r1 = await w.exec('Write-Output "hello"');
  assert('exec 返回 hello', r1.trim() === 'hello', JSON.stringify(r1));

  console.log('\n--- 3. cd 到含中文的路径（核心回归点）---');
  const cwd1 = await w.cd(PROJECT_DIR);
  assert('cd 中文路径成功', cwd1.toLowerCase() === PROJECT_DIR.toLowerCase(),
         '期望 ' + PROJECT_DIR + ' / 实际 ' + cwd1);

  console.log('\n--- 4. cwd 跨请求持久化 ---');
  const cwd2 = await w.getCwd();
  assert('工作目录保持', cwd2.toLowerCase() === PROJECT_DIR.toLowerCase(), cwd2);

  console.log('\n--- 5. cd 后执行真实命令 ---');
  const r5 = await w.exec('(Get-Location).Path');
  assert('cd 后 exec 仍在新目录', r5.trim().toLowerCase() === PROJECT_DIR.toLowerCase(), r5);

  console.log('\n--- 6. 中文内容往返 ---');
  const r6 = await w.exec('Write-Output "中文测试-代码"');
  assert('中文输出无损返回', r6.includes('中文测试-代码'), JSON.stringify(r6));

  console.log('\n--- 7. 中文路径下创建/清理目录 ---');
  const tmpName = '临时目录-测试';
  const r7 = await w.exec(
    "New-Item -ItemType Directory -Path (Join-Path (Get-Location) '" + tmpName + "') -Force | Out-Null; " +
    "Test-Path (Join-Path (Get-Location) '" + tmpName + "')"
  );
  assert('中文目录创建成功', r7.trim().toLowerCase() === 'true', r7);
  await w.exec("Remove-Item -LiteralPath (Join-Path (Get-Location) '" + tmpName + "') -Recurse -Force");

  console.log('\n--- 8. 多行 / 复杂命令 ---');
  const r8 = await w.exec('$items = @(); $items += "a"; $items += "b"; $items += "c"; $items -join ","');
  assert('多行命令结果正确', r8.trim() === 'a,b,c', JSON.stringify(r8));

  console.log('\n--- 9. 环境变量持久化 ---');
  await w.setEnv('DESKTOPOS_TEST', '持久化生效');
  const env1 = await w.getEnv('DESKTOPOS_TEST');
  assert('环境变量写入并读回', env1 === '持久化生效', env1);
  const r9 = await w.exec('$env:DESKTOPOS_TEST');
  assert('环境变量跨请求可见', r9.includes('持久化生效'), r9);

  console.log('\n--- 10. 错误可捕获且不挂死 ---');
  const r10 = await w.exec('Get-Item -LiteralPath "C:\\__绝对不存在的路径__"', { timeout: 10000 });
  assert('错误信息回传（不静默）', r10.trim().length > 0, JSON.stringify(r10));
  const r10b = await w.exec('Write-Output "still-alive"', { timeout: 10000 });
  assert('出错后 worker 仍存活', r10b.trim() === 'still-alive', r10b);

  console.log('\n--- 11. 优雅退出 ---');
  await w.stop();
  assert('worker 已停止', w.alive === false);

  console.log('\n========================================');
  console.log('  结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常终止：', e);
  process.exit(1);
});
