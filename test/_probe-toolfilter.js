const { spawn } = require('child_process');
function run(env, expectName, label) {
  return new Promise((resolve) => {
    const p = spawn('node', ['src/mcp-server/index.js'], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const done = (v) => { try { p.kill(); } catch {} resolve(v); };
    p.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) {
          const txt = m.result && m.result.content && m.result.content[0] && m.result.content[0].text;
          done({ label, isError: m.result && m.result.isError, text: String(txt || '').slice(0, 90) });
        }
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    setTimeout(() => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: expectName, arguments: {} } }) + '\n');
    }, 300);
    setTimeout(() => done({ label, timeout: true }), 15000);
  });
}
(async () => {
  let fail = 0;
  // 1) 被裁掉的工具必须被拒
  const a = await run({ DESKTOPOS_TOOLS: 'shell,diagnose' }, 'desktop_cdp_open', '裁剪后调用 cdp_open');
  console.log(`  ${a.isError && /已.*裁剪/.test(a.text) ? 'PASS' : 'FAIL'}  ${a.label} -> ${a.text}`);
  if (!(a.isError && /已.*裁剪/.test(a.text))) fail++;

  // 2) 保留的工具必须能用
  const b = await run({ DESKTOPOS_TOOLS: 'shell,diagnose' }, 'shell_cwd', '裁剪后调用 shell_cwd');
  const okB = !b.isError && /desktopos/i.test(b.text);
  console.log(`  ${okB ? 'PASS' : 'FAIL'}  ${b.label} -> ${b.text}`);
  if (!okB) fail++;

  // 3) 默认（无过滤）时该工具必须正常执行（走到真实逻辑，报 CDP 不可用而不是"被裁剪"）
  const c = await run({}, 'desktop_cdp_open', '默认模式调用 cdp_open');
  const okC = c.isError && /CDP/.test(c.text) && !/裁剪/.test(c.text);
  console.log(`  ${okC ? 'PASS' : 'FAIL'}  ${c.label} -> ${c.text}`);
  if (!okC) fail++;

  console.log(`\n过滤行为校验：${fail ? 'FAIL ' + fail : 'PASS 3/3'}`);
  process.exit(fail ? 1 : 0);
})();
