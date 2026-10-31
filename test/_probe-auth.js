/**
 * 鉴权回归：验证「任意网页 POST 到 127.0.0.1 就能执行命令」这条路是否已堵死。
 *
 * 攻击模型：恶意页面用 fetch(..., {mode:'no-cors'}) 发跨站 POST。
 *   - Content-Type: text/plain 是 CORS 安全列表值 -> 简单请求 -> 不预检 -> 请求真的会发出去
 *   - 浏览器会附带 Origin 头
 * 所以防御必须做到：没有正确 token、或带 Origin，一律 403。
 */
const { ShellWorker } = require('../src/shell-worker/index.js');
const http = require('http');

const post = (port, body, headers) => new Promise((resolve) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port, path: '/exec', method: 'POST',
    headers: { 'Content-Length': Buffer.byteLength(payload), ...headers },
  }, (res) => {
    let b = '';
    res.on('data', (c) => b += c);
    res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 120) }));
  });
  req.on('error', (e) => resolve({ error: e.message }));
  req.write(payload);
  req.end();
});

(async () => {
  const w = new ShellWorker({});
  await w.start();
  const port = w.port;
  const cmd = Buffer.from('Write-Output PWNED', 'utf8').toString('base64');
  const body = { command: cmd };

  const cases = [
    ['恶意页：Origin + text/plain', { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example.com' }],
    ['恶意页：Origin + json',       { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }],
    ['无 token，无 Origin',          { 'Content-Type': 'application/json' }],
    ['错误 token',                   { 'Content-Type': 'application/json', 'X-DOS-Token': 'deadbeef' }],
    ['正确 token',                   { 'Content-Type': 'application/json', 'X-DOS-Token': w._token }],
  ];

  for (const [label, headers] of cases) {
    const r = await post(port, body, headers);
    console.log(`  ${label.padEnd(26)} -> status=${r.status} ${r.body || r.error || ''}`);
  }

  const evil1 = await post(port, body, { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example.com' });
  const evil2 = await post(port, body, { 'Content-Type': 'application/json' });
  const evil3 = await post(port, body, { 'Content-Type': 'application/json', 'X-DOS-Token': 'deadbeef' });
  const good = await post(port, body, { 'Content-Type': 'application/json', 'X-DOS-Token': w._token });

  const checks = [
    [evil1.status === 403, '跨站（Origin + text/plain）被拒'],
    [evil2.status === 403, '无 token 被拒'],
    [evil3.status === 403, '错误 token 被拒'],
    [good.status === 200, '带 token 正常执行'],
  ];

  console.log('');
  for (const [ok, label] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);

  const pass = checks.filter((c) => c[0]).length;
  await w.stop();
  console.log(`\n鉴权结果：通过 ${pass} / ${checks.length}`);
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
