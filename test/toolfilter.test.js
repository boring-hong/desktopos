/**
 * 工具过滤（allowlist / denylist）测试
 *
 * 为什么需要这个功能：主流 MCP 客户端只支持按**服务器**启停，没有工具级开关。
 * 装了多套能力重叠的服务器之后，模型每次调用都得猜用哪个 —— 工具越多越容易选错。
 * 裁面只能在服务器侧做。
 *
 * 这个测试盯三件事：
 *   1. 不设过滤时必须暴露全部工具（OSS 默认体验不能被改坏）
 *   2. 设了过滤后 tools/list 必须只剩选中的
 *   3. **被裁掉的工具在 tools/call 层也必须被拒** ——
 *      只裁 tools/list 是不够的：客户端工具表可能是缓存/陈旧的，
 *      模型也可能记得旧名字，那时调用会绕过裁剪照常执行，配置看着生效其实没有。
 */

const path = require('path');
const { spawn } = require('child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server', 'index.js');

let pass = 0;
let fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

/** 起一个服务器，跑 initialize → 可选 tools/list / tools/call，然后关掉 */
function rpc(opts = {}) {
  const { env = {}, listTools = false, call = null, timeout = 20000 } = opts;
  return new Promise((resolve) => {
    const proc = spawn('node', [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { proc.kill(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeout);

    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }

        if (m.id === 1) {
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          if (listTools) {
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          } else if (call) {
            proc.stdin.write(JSON.stringify({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: { name: call, arguments: {} },
            }) + '\n');
          }
        } else if (m.id === 2) {
          clearTimeout(timer);
          finish({ result: m.result, error: m.error });
        }
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'toolfilter-test', version: '1.0.0' },
      },
    }) + '\n');
  });
}

(async () => {
  console.log('\n--- 1. 不设过滤：暴露全部 ---');
  const all = await rpc({ listTools: true });
  const allNames = ((all.result && all.result.tools) || []).map((t) => t.name);
  assert('默认暴露全部工具', allNames.length === 33, '实际 ' + allNames.length);
  assert('默认含 shell_exec', allNames.includes('shell_exec'));
  assert('默认含 desktop_cdp_open', allNames.includes('desktop_cdp_open'));

  console.log('\n--- 2. 按分组过滤 ---');
  const g = await rpc({ env: { DESKTOPOS_TOOLS: 'shell,diagnose' }, listTools: true });
  const gNames = ((g.result && g.result.tools) || []).map((t) => t.name);
  assert('shell+diagnose = 8 个工具', gNames.length === 8, '实际 ' + gNames.length + ': ' + gNames.join(','));
  assert('含 7 个 shell_*', gNames.filter((n) => n.startsWith('shell_')).length === 7);
  assert('含 desktop_diagnose', gNames.includes('desktop_diagnose'));
  assert('不含 cdp 工具', !gNames.some((n) => n.includes('cdp')));

  console.log('\n--- 3. 按工具名过滤 ---');
  const n = await rpc({
    env: { DESKTOPOS_TOOLS: 'shell_exec,desktop_perceive' },
    listTools: true,
  });
  const nNames = ((n.result && n.result.tools) || []).map((t) => t.name);
  assert('按名字精确裁剪 = 2', nNames.length === 2, nNames.join(','));

  console.log('\n--- 4. exclude 优先于 only ---');
  const e = await rpc({
    env: { DESKTOPOS_TOOLS: 'shell', DESKTOPOS_TOOLS_EXCLUDE: 'shell_reset,shell_env_get' },
    listTools: true,
  });
  const eNames = ((e.result && e.result.tools) || []).map((t) => t.name);
  assert('shell 7 个减去 2 个 = 5', eNames.length === 5, eNames.join(','));
  assert('被排除的确实不在了', !eNames.includes('shell_reset') && !eNames.includes('shell_env_get'));

  console.log('\n--- 5. 执行期必须也挡住被裁掉的工具 ---');
  const blocked = await rpc({ env: { DESKTOPOS_TOOLS: 'shell,diagnose' }, call: 'desktop_cdp_open' });
  const bText = (blocked.result && blocked.result.content && blocked.result.content[0] && blocked.result.content[0].text) || '';
  assert('调用被裁工具返回 isError', !!(blocked.result && blocked.result.isError), JSON.stringify(blocked).slice(0, 160));
  assert('错误信息说明是被裁剪的', /裁剪/.test(bText), bText.slice(0, 120));

  console.log('\n--- 6. 保留下来的工具必须照常工作 ---');
  const okCall = await rpc({ env: { DESKTOPOS_TOOLS: 'shell,diagnose' }, call: 'shell_cwd' });
  const okText = (okCall.result && okCall.result.content && okCall.result.content[0] && okCall.result.content[0].text) || '';
  assert('保留的工具能正常执行', !okCall.result.isError && okText.length > 0, okText.slice(0, 120));

  console.log('\n========================================');
  console.log('  工具过滤结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常终止：', e && e.message);
  process.exit(1);
});
