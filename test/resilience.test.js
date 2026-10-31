/**
 * 韧性与安全回归测试
 *
 * 覆盖三处曾经的硬伤（都由独立评审发现并复现）：
 *   1. 鉴权：本地 HTTP 端点原先无任何校验 —— 任意网页用
 *      Content-Type: text/plain（CORS 安全列表值，不触发预检）POST 到
 *      127.0.0.1:<port>/exec 就能执行 PowerShell。现在必须带 token，
 *      且带 Origin 头的请求一律 403。
 *   2. 卡死恢复：一条卡住的命令会让单线程 runspace 永远回不去，之后所有
 *      请求全部超时；旧 stop() 还会 await 一个没有超时的 /shutdown，于是
 *      逃生门自己也挂死。现在命令超时会自动重启 worker 并重放 cwd/env，
 *      stop() 保证有限时间返回。
 *   3. 并发冷启动：ensureWorker 在 start 未完成时 alive 仍是 false，
 *      并发调用会各 spawn 一个 PowerShell，多出来的成为泄漏进程。
 *      现在并发 start 共用同一个 Promise。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { ShellWorker } = require('../src/shell-worker/index.js');

const PROJECT_DIR = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

const rawPost = (port, body, headers) => new Promise((resolve) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: '/exec', method: 'POST',
    headers: { 'Content-Length': Buffer.byteLength(payload), ...headers }
  }, (res) => {
    let b = '';
    res.on('data', (c) => b += c);
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', (e) => resolve({ error: e.message }));
  req.write(payload);
  req.end();
});

/** 有限时间内拿到结果，否则判定为挂住 */
const within = (p, ms) => Promise.race([
  p.then((v) => ({ settled: true, value: v })).catch((e) => ({ settled: true, error: e.message })),
  new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
]);

(async () => {
  const w = new ShellWorker({ initialCwd: PROJECT_DIR, cmdTimeout: 20000 });
  w.on('error', () => {}); // 重启过程中的 close 事件属正常

  console.log('\n--- 1. 鉴权：跨站请求必须被拒 ---');
  await w.start();
  const port = w.port;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const cmdBody = { command: b64('Write-Output PWNED') };

  const crossSite = await rawPost(port, cmdBody,
    { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example.com' });
  assert('带 Origin 的跨站请求被 403', crossSite.status === 403, JSON.stringify(crossSite));

  const noToken = await rawPost(port, cmdBody, { 'Content-Type': 'application/json' });
  assert('无 token 被 403', noToken.status === 403, JSON.stringify(noToken));

  const badToken = await rawPost(port, cmdBody,
    { 'Content-Type': 'application/json', 'X-DOS-Token': 'deadbeef' });
  assert('错误 token 被 403', badToken.status === 403, JSON.stringify(badToken));

  assert('token 不是空串', typeof w._token === 'string' && w._token.length >= 32);

  const withToken = await rawPost(port, cmdBody,
    { 'Content-Type': 'application/json', 'X-DOS-Token': w._token });
  assert('带正确 token 正常执行', withToken.status === 200, JSON.stringify(withToken));

  console.log('\n--- 2. 命令超时后会话自动恢复 ---');
  await w.cd(PROJECT_DIR);
  await w.setEnv('DOS_REG_TEST', 'kept-after-reset');

  const hung = await within(w.execFull('Start-Sleep -Seconds 30', { timeout: 1500 }), 15000);
  assert('卡死命令按时超时报错', hung.settled && !hung.value && /timed out/i.test(hung.error || ''),
    JSON.stringify(hung));

  const after = await within(w.execFull('Write-Output survived'), 15000);
  assert('超时后会话自动恢复，命令可执行',
    after.settled && after.value && after.value.output.trim() === 'survived',
    JSON.stringify(after));

  const cwdAfter = await within(w.getCwd(), 15000);
  assert('自动重启后 cwd 被还原',
    cwdAfter.settled && cwdAfter.value &&
    cwdAfter.value.toLowerCase() === PROJECT_DIR.toLowerCase(),
    JSON.stringify(cwdAfter));

  const envAfter = await within(w.getEnv('DOS_REG_TEST'), 15000);
  assert('自动重启后环境变量被还原',
    envAfter.settled && envAfter.value === 'kept-after-reset',
    JSON.stringify(envAfter));

  console.log('\n--- 3. 卡死状态下 stop() 仍须有限时间返回 ---');
  // 故意再卡住一次，紧接着立刻 stop
  w.execFull('Start-Sleep -Seconds 30', { timeout: 60000, autoReset: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const stopped = await within(w.stop(), 12000);
  assert('卡死时 stop() 不挂住', stopped.settled === true, JSON.stringify(stopped));
  assert('stop() 后 alive 为 false', w.alive === false);

  console.log('\n--- 4. 并发冷启动只 spawn 一个进程 ---');
  const w2 = new ShellWorker({ initialCwd: PROJECT_DIR, cmdTimeout: 20000 });
  const spawned = [];
  const origSpawnOnce = w2._spawnOnce.bind(w2);
  w2._spawnOnce = async () => { spawned.push(Date.now()); return origSpawnOnce(); };

  const rs = await within(Promise.all([
    w2.start(), w2.start(), w2.start(), w2.start(), w2.start(),
  ]), 40000);
  assert('并发 start 全部成功', rs.settled && Array.isArray(rs.value), JSON.stringify(rs && rs.error));
  assert('并发 start 只 spawn 一次', spawned.length === 1, '实际 spawn ' + spawned.length + ' 次');
  const c2 = await within(w2.execFull('Write-Output one'), 15000);
  assert('并发启动后会话可用', c2.settled && c2.value.output.trim() === 'one', JSON.stringify(c2));
  await w2.stop();

  console.log('\n--- 5. 超大请求体应被拒 ---');
  const w3 = new ShellWorker({ initialCwd: PROJECT_DIR, cmdTimeout: 20000 });
  await w3.start();
  const huge = 'A'.repeat(5 * 1024 * 1024); // 5 MB > 4 MB 上限
  const big = await within(rawPost(w3.port, { command: huge },
    { 'Content-Type': 'application/json', 'X-DOS-Token': w3._token }), 20000);
  assert('超大 body 返回 413 而不是被读进内存',
    big.settled && big.value && big.value.status === 413,
    JSON.stringify(big && big.value));
  await w3.stop();

  console.log('\n========================================');
  console.log('  韧性/安全结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常终止：', e && e.message);
  process.exit(1);
});
