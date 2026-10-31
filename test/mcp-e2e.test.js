/**
 * MCP 端到端协议测试
 * 真起 StdioServerTransport，用 JSON-RPC 走一遍 initialize -> tools/list -> tools/call。
 * 这是验证「能被 AI Agent 真正调用」的唯一可靠方式。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'mcp-server', 'index.js');
const PROJECT_DIR = ROOT; // 含中文，顺带验证中文路径经 MCP 层往返

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

function startServer() {
  const p = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  let buf = '';
  const waiters = [];
  const stderrLog = [];

  p.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      const w = waiters.find((x) => x.id === msg.id);
      if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  p.stderr.on('data', (d) => { stderrLog.push(d.toString('utf8')); });

  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const wait = (id, ms = 30000) => new Promise((resolve, reject) => {
    const w = { id, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting id=' + id + '\nstderr: ' + stderrLog.join(''))); }
    }, ms);
  });

  return { p, send, wait, stderrLog };
}

function textOf(result) {
  const c = result && result.result && result.result.content;
  if (!c || !c[0]) return '';
  return c[0].text || '';
}

(async () => {
  const srv = startServer();
  let nextId = 1;
  const rpc = async (method, params, ms = 30000) => {
    const id = nextId++;
    srv.send({ jsonrpc: '2.0', id, method, params });
    return srv.wait(id, ms);
  };

  try {
    console.log('\n--- 1. initialize 握手 ---');
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' }
    });
    assert('initialize 返回 result', !!init.result, JSON.stringify(init));
    assert('返回 serverInfo', !!(init.result && init.result.serverInfo),
           JSON.stringify(init.result && init.result.serverInfo));
    if (init.result && init.result.serverInfo) {
      console.log('        server = ' + init.result.serverInfo.name + ' v' + init.result.serverInfo.version);
    }

    // 通知（无 id）
    srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 300));

    console.log('\n--- 2. tools/list ---');
    const list = await rpc('tools/list', {});
    const tools = (list.result && list.result.tools) || [];
    assert('tools/list 返回工具列表', tools.length > 0, 'got ' + tools.length);
    const names = tools.map((t) => t.name);
    console.log('        tools = ' + names.join(', '));
    ['shell_exec', 'shell_cd', 'shell_cwd', 'shell_env_set', 'shell_env_get', 'shell_reset']
      .forEach((n) => assert('暴露工具 ' + n, names.includes(n)));

    // 回归：dispatcher 里能处理的工具，必须都在 tools/list 里登记过。
    // 否则 Agent 永远看不到它（desktop_perceive 曾踩过这个坑：handler 有，声明漏了）。
    const src = fs.readFileSync(SERVER, 'utf8');
    const dispatched = [...new Set([...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]))]
      .filter((n) => /^(shell|desktop|memory)_/.test(n));
    const undeclared = dispatched.filter((n) => !names.includes(n));
    assert('所有可调用工具都已登记进 tools/list', undeclared.length === 0,
           '未登记: ' + undeclared.join(', '));
    const unhandled = names.filter((n) => !dispatched.includes(n));
    assert('所有登记工具都有 handler', unhandled.length === 0, '无 handler: ' + unhandled.join(', '));
    console.log('        dispatcher ' + dispatched.length + ' 个 / 声明 ' + names.length + ' 个');

    console.log('\n--- 3. tools/call: shell_exec ---');
    const r1 = await rpc('tools/call', { name: 'shell_exec', arguments: { command: 'Write-Output "mcp-hello"' } });
    assert('shell_exec 正常返回', textOf(r1).trim() === 'mcp-hello', JSON.stringify(textOf(r1)));

    console.log('\n--- 4. tools/call: shell_cd 中文路径（全链路回归）---');
    const r2 = await rpc('tools/call', { name: 'shell_cd', arguments: { path: PROJECT_DIR } });
    const cdText = textOf(r2);
    assert('shell_cd 切到中文路径', cdText.includes('desktopos'), cdText);
    console.log('        ' + cdText);

    console.log('\n--- 5. 目录持久化（跨 MCP 调用）---');
    const r3 = await rpc('tools/call', { name: 'shell_cwd', arguments: {} });
    assert('shell_cwd 保持中文目录', textOf(r3).trim().toLowerCase() === PROJECT_DIR.toLowerCase(), textOf(r3));

    console.log('\n--- 6. 中文输出经 MCP 往返 ---');
    const r4 = await rpc('tools/call', { name: 'shell_exec', arguments: { command: 'Write-Output "中文往返-成功"' } });
    assert('中文内容无损', textOf(r4).includes('中文往返-成功'), JSON.stringify(textOf(r4)));

    console.log('\n--- 7. 会话持久化：先 cd 再 exec ---');
    const r5 = await rpc('tools/call', { name: 'shell_exec', arguments: { command: '(Get-Location).Path' } });
    assert('exec 仍在 cd 后的目录', textOf(r5).trim().toLowerCase() === PROJECT_DIR.toLowerCase(), textOf(r5));

    console.log('\n--- 8. 环境变量工具 ---');
    await rpc('tools/call', { name: 'shell_env_set', arguments: { name: 'MCP_E2E', value: '持久化ok' } });
    const r6 = await rpc('tools/call', { name: 'shell_env_get', arguments: { name: 'MCP_E2E' } });
    assert('环境变量跨调用保持', textOf(r6).includes('持久化ok'), textOf(r6));

    console.log('\n--- 9. 错误不击穿 MCP 层 ---');
    const r7 = await rpc('tools/call', { name: 'shell_exec', arguments: { command: 'Get-Item -LiteralPath "C:\\__不存在__"' } });
    assert('错误以文本返回，未崩溃', textOf(r7).length > 0, JSON.stringify(textOf(r7)));
    const r8 = await rpc('tools/call', { name: 'shell_exec', arguments: { command: 'Write-Output "alive"' } });
    assert('出错后仍可继续调用', textOf(r8).trim() === 'alive', textOf(r8));

    console.log('\n--- 10. shell_exec_verified：建中文目录并独立验证 ---');
    const vdir = path.join(PROJECT_DIR, '验证目录-自测');
    try { fs.rmSync(vdir, { recursive: true, force: true }); } catch {}
    const v1 = await rpc('tools/call', {
      name: 'shell_exec_verified',
      arguments: {
        command: "New-Item -ItemType Directory -Path '" + vdir + "' -Force | Out-Null",
        expect: { isDir: vdir }
      }
    });
    assert('验证通过（中文目录确实建出来了）', v1.result.isError !== true, JSON.stringify(textOf(v1)));
    console.log('        ' + textOf(v1).split('\n')[0]);
    try { fs.rmSync(vdir, { recursive: true, force: true }); } catch {}

    console.log('\n--- 11. shell_exec_verified：验证不过要报错 ---');
    const v2 = await rpc('tools/call', {
      name: 'shell_exec_verified',
      arguments: {
        command: 'Write-Output "do-nothing"',
        expect: { pathExists: 'C:\\__绝对不存在__\\x' },
        retries: 0
      }
    });
    assert('验证失败返回 isError', v2.result.isError === true, JSON.stringify(textOf(v2)));
    console.log('        ' + textOf(v2).split('\n')[0]);

    console.log('\n--- 12. 双通道感知：desktop_list_windows ---');
    const p1 = await rpc('tools/call', { name: 'desktop_list_windows', arguments: {} });
    const p1t = textOf(p1);
    assert('返回屏幕与窗口信息', p1t.includes('屏幕') && p1t.includes('窗口'), p1t.slice(0, 120));
    assert('无乱码替换字符', !p1t.includes('\uFFFD'), p1t.slice(0, 120));
    console.log('        ' + p1t.split('\n')[0]);

    console.log('\n--- 13. 视觉通道：desktop_screenshot ---');
    const p2 = await rpc('tools/call', { name: 'desktop_screenshot', arguments: { includePng: false } });
    assert('不带图时返回文本', textOf(p2).includes('x'), JSON.stringify(textOf(p2)));

    const p3 = await rpc('tools/call', { name: 'desktop_screenshot', arguments: { includePng: true } });
    const p3c = (p3.result && p3.result.content) || [];
    assert('带图时返回 image 内容', p3c.some((c) => c.type === 'image' && c.mimeType === 'image/png'),
           JSON.stringify(p3c.map((c) => c.type)));
    const img = p3c.find((c) => c.type === 'image');
    if (img) {
      const head = Buffer.from(img.data, 'base64').slice(0, 8).toString('base64');
      assert('图片是合法 PNG', head.startsWith('iVBORw0K'), head);
    }

    console.log('\n--- 14. 交叉验证：desktop_perceive ---');
    const p4 = await rpc('tools/call', { name: 'desktop_perceive', arguments: { includePng: false } });
    const p4t = textOf(p4);
    assert('返回交叉验证结论', p4t.includes('交叉验证'), p4t.slice(0, 150));
    assert('感知结果无乱码', !p4t.includes('\uFFFD'), p4t.slice(0, 150));
    console.log('        ' + p4t.split('\n')[1]);

    console.log('\n--- 15. 执行层：只读与无副作用动作（安全子集）---');
    const a0 = await rpc('tools/call', { name: 'desktop_cursor', arguments: {} });
    assert('desktop_cursor 返回坐标', /光标位置: \(\d+, \d+\)/.test(textOf(a0)), textOf(a0));
    console.log('        ' + textOf(a0));

    const a1 = await rpc('tools/call', {
      name: 'desktop_move', arguments: { x: 30, y: 30, verify: true }
    });
    const a1t = textOf(a1);
    assert('desktop_move 返回结果', a1t.includes('move'), a1t);
    assert('move 带 verify 结论', a1t.includes('验证'), a1t);
    console.log('        ' + a1t.replace(/\n/g, ' | '));

    console.log('\n--- 16. 执行层工具已暴露 ---');
    const list2 = await rpc('tools/list', {});
    const names2 = ((list2.result && list2.result.tools) || []).map((t) => t.name);
    ['desktop_cursor', 'desktop_move', 'desktop_click', 'desktop_type',
     'desktop_key', 'desktop_scroll', 'desktop_focus_window']
      .forEach((n) => assert('暴露工具 ' + n, names2.includes(n)));
    console.log('        工具总数: ' + names2.length);

    console.log('\n--- 17. 记忆层：感知结果自动入索引 ---');
    const m1 = await rpc('tools/call', { name: 'memory_stats', arguments: {} });
    const m1t = textOf(m1);
    assert('memory_stats 可读', m1t.includes('窗口索引'), m1t);
    assert('感知后索引非空', /窗口索引 [1-9]/.test(m1t), m1t);
    console.log('        ' + m1t.split('\n').slice(0, 2).join(' | '));

    console.log('\n--- 18. 记忆层：指代定位（"刚才那个窗口"）---');
    const m2 = await rpc('tools/call', { name: 'memory_recall', arguments: { query: '刚才那个窗口' } });
    const m2t = textOf(m2);
    assert('指代能定位到目标', m2.result.isError !== true, m2t);
    assert('返回可点击坐标', /坐标: \(\d+, \d+\)/.test(m2t), m2t);
    assert('提示下一步 click', m2t.includes('desktop_click'), m2t);
    console.log('        ' + m2t.split('\n').slice(0, 2).join(' | '));

    console.log('\n--- 19. 记忆层：未命中应明确报错 ---');
    const m3 = await rpc('tools/call', { name: 'memory_recall', arguments: { query: '绝对不存在的程序xyz' } });
    assert('未命中返回 isError', m3.result.isError === true, textOf(m3));
    console.log('        ' + textOf(m3).split('\n')[0]);

    console.log('\n--- 20. 记忆层：操作时间线 ---');
    const m4 = await rpc('tools/call', { name: 'memory_timeline', arguments: { limit: 10 } });
    const m4t = textOf(m4);
    assert('时间线含 perceive 记录', m4t.includes('perceive'), m4t.slice(0, 150));
    assert('时间线含 act 记录', m4t.includes('act'), m4t.slice(0, 300));
    console.log('        ' + m4t.split('\n')[0]);

    console.log('\n--- 21. 元素级：枚举控件（UIA）---');
    // 从窗口列表里取一个句柄（句柄已包含在输出中）
    const lw = await rpc('tools/call', { name: 'desktop_list_windows', arguments: {} });
    const hm = textOf(lw).match(/handle=(\d+)/);
    assert('窗口列表带句柄', !!hm, textOf(lw).slice(0, 120));

    let elCount = 0;
    let handleUsed = null;
    if (hm) {
      handleUsed = Number(hm[1]);
      const el = await rpc('tools/call', {
        name: 'desktop_elements', arguments: { handle: handleUsed, maxElements: 100 }
      });
      const elt = textOf(el);
      assert('desktop_elements 有响应', elt.length > 0, elt.slice(0, 120));
      const cm = elt.match(/控件 (\d+) 个/);
      if (cm) elCount = Number(cm[1]);
      console.log('        handle=' + handleUsed + ' -> ' + (cm ? cm[0] : elt.slice(0, 60)));
      // Electron/Chromium 可能返回 0，这也是合法结果（工具应给出解释而非崩溃）
      if (elCount === 0) {
        assert('返回 0 时给出解释而非崩溃', /未枚举到控件/.test(elt), elt.slice(0, 120));
      }
    }

    console.log('\n--- 22. 元素级：点不存在的控件应报错且不误触 ---');
    if (handleUsed) {
      const ce = await rpc('tools/call', {
        name: 'desktop_click_element',
        arguments: { handle: handleUsed, name: '绝对不存在的控件名xyz' }
      });
      assert('找不到控件时返回 isError', ce.result.isError === true, textOf(ce));
      assert('错误信息说明未找到', /not found|未找到|找不到/i.test(textOf(ce)), textOf(ce));
      console.log('        ' + textOf(ce).split('\n')[0].slice(0, 80));
    }

    console.log('\n--- 23. 元素级工具已暴露 ---');
    const list3 = await rpc('tools/list', {});
    const names3 = ((list3.result && list3.result.tools) || []).map((t) => t.name);
    ['desktop_elements', 'desktop_click_element'].forEach((n) =>
      assert('暴露工具 ' + n, names3.includes(n)));
    console.log('        工具总数: ' + names3.length);

    console.log('\n--- 24. CDP：Chromium 内部通道（端到端）---');
    const { findBrowser } = require('../src/cdp/launch.js');
    const CDP_PAGE =
      'data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><body style="padding:24px">' +
        '<h1>中文标题测试</h1>' +
        '<input id="kw" placeholder="请输入关键词" style="padding:8px;width:240px">' +
        '<button id="go" onclick="document.getElementById(\'out\').textContent=\'已点击：\'+document.getElementById(\'kw\').value">搜索</button>' +
        '<div id="out"></div></body>');

    if (!findBrowser()) {
      console.log('  SKIP  本机没有 Edge / Chrome，跳过 CDP 端到端');
    } else {
      const lr = await rpc('tools/call', {
        name: 'desktop_browser_launch', arguments: { headless: true, url: 'about:blank' }
      }, 40000);
      assert('启动可调试浏览器', !lr.result.isError, textOf(lr));
      const port = Number((textOf(lr).match(/端口 (\d+)/) || [])[1]);
      assert('返回调试端口', Number.isInteger(port), textOf(lr));

      const or = await rpc('tools/call', {
        name: 'desktop_cdp_open', arguments: { port, url: CDP_PAGE, navigate: true }
      }, 40000);
      assert('建立 CDP 会话', !or.result.isError, textOf(or));
      const sid = (textOf(or).match(/会话 (\S+) /) || [])[1];
      assert('返回会话 id', !!sid, textOf(or));

      const er = await rpc('tools/call', { name: 'desktop_cdp_elements', arguments: { session: sid } }, 40000);
      const elText = textOf(er);
      assert('枚举出控件', /\[button\] 搜索/.test(elText), elText);
      assert('输入框在列表里', /\[textbox\] 请输入关键词/.test(elText), elText);
      assert('中文控件名无乱码', !elText.includes('\uFFFD'), elText);
      assert('已去重（无重复 StaticText 投影）',
             (elText.match(/\[StaticText\] 搜索/g) || []).length === 0, elText);

      const tr = await rpc('tools/call', {
        name: 'desktop_cdp_type',
        arguments: { text: '中文关键词', target: '请输入', session: sid }
      }, 40000);
      assert('中文输入成功', !tr.result.isError, textOf(tr));

      const vr = await rpc('tools/call', {
        name: 'desktop_cdp_eval',
        arguments: { expression: "document.getElementById('kw').value", session: sid }
      }, 40000);
      assert('输入框内容为中文且无损', textOf(vr).trim() === '中文关键词', textOf(vr));

      const cr = await rpc('tools/call', {
        name: 'desktop_cdp_click', arguments: { name: '搜索', session: sid }
      }, 40000);
      assert('按名称点击控件', !cr.result.isError && /已点击/.test(textOf(cr)), textOf(cr));

      const rr = await rpc('tools/call', {
        name: 'desktop_cdp_eval',
        arguments: { expression: "document.getElementById('out').textContent", session: sid }
      }, 40000);
      assert('点击真的生效了', textOf(rr).includes('已点击：中文关键词'), textOf(rr));

      const sr = await rpc('tools/call', { name: 'desktop_cdp_screenshot', arguments: { session: sid } }, 40000);
      const sc = sr.result && sr.result.content && sr.result.content[0];
      assert('页面截图返回图片', !!(sc && sc.type === 'image' && sc.data), JSON.stringify(sc && sc.type));
      assert('截图是合法 PNG', !!(sc && Buffer.from(sc.data, 'base64').slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));

      const xr = await rpc('tools/call', {
        name: 'desktop_cdp_click', arguments: { name: '绝对不存在xyz', session: sid }
      }, 40000);
      assert('点不存在的控件返回 isError', !!xr.result.isError, textOf(xr));

      const clr = await rpc('tools/call', { name: 'desktop_cdp_close', arguments: {} }, 40000);
      assert('关闭会话并终止浏览器', /浏览器进程已终止/.test(textOf(clr)), textOf(clr));
    }

    console.log('\n--- 25. 自愈诊断器 ---');
    const dg = await rpc('tools/call', {
      name: 'desktop_diagnose', arguments: { error: 'Access is denied.' }
    }, 40000);
    assert('诊断出权限类别', /access-denied/.test(textOf(dg)), textOf(dg));
    assert('给出可行动的下一步', /下一步:/.test(textOf(dg)), textOf(dg));
    assert('标注重试无意义', /重试无意义/.test(textOf(dg)), textOf(dg));

    const os = require('os');
    const healDir = path.join(os.tmpdir(), 'desktopos-e2e-heal-' + Date.now());
    const healFile = path.join(healDir, 'x', 'y.txt');
    try {
      const hv = await rpc('tools/call', {
        name: 'shell_exec_verified',
        arguments: {
          command: `New-Item -ItemType File -Path '${healFile}' | Out-Null`,
          expect: { isFile: healFile },
          retries: 1,
        }
      }, 40000);
      assert('父目录缺失时自愈成功', !hv.result.isError, textOf(hv));
      assert('报告了自动修补', /自动修补/.test(textOf(hv)), textOf(hv));
      assert('目标文件真的被创建', fs.existsSync(healFile), healFile);
    } finally {
      try { fs.rmSync(healDir, { recursive: true, force: true }); } catch {}
    }

    const ce = await rpc('tools/call', {
      name: 'desktop_click_element', arguments: { handle: 999999, name: '绝不存在的按钮xyz' }
    }, 40000);
    const ceText = textOf(ce);
    assert('工具报错返回 isError', !!ce.result.isError, ceText);
    assert('报错自动附带诊断', /诊断: /.test(ceText), ceText);
    assert('诊断类别是控件或句柄问题', /诊断: (element-not-found|invalid-handle)/.test(ceText), ceText);
    assert('诊断给出下一步', /下一步: /.test(ceText), ceText);

    console.log('\n--- 26. shell_reset ---');
    const r9 = await rpc('tools/call', { name: 'shell_reset', arguments: {} });
    assert('reset 正常返回', textOf(r9).length > 0, textOf(r9));
    const r10 = await rpc('tools/call', { name: 'shell_exec', arguments: { command: 'Write-Output "after-reset"' } });
    assert('reset 后仍可用', textOf(r10).trim() === 'after-reset', textOf(r10));

  } catch (e) {
    fail++;
    console.log('\n  FAIL  协议测试异常: ' + e.message);
  } finally {
    try { srv.p.kill(); } catch {}
  }

  console.log('\n========================================');
  console.log('  MCP E2E 结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})();
