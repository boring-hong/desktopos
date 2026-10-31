/**
 * CDP 手动调试工具（不参与 npm test）
 *
 *   node test/_dbg-cdp.js launch           启动一个隔离的调试实例（默认 headless）
 *   node test/_dbg-cdp.js survey           只读：列出当前可连的 CDP 端点
 *   node test/_dbg-cdp.js smoke            全自动冒烟：启动 -> 打开页面 -> 取控件 -> 点击 -> 输入 -> 截图
 *   node test/_dbg-cdp.js smoke --headed   同上，但显示窗口（会真跳出来）
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { launch } = require('../src/cdp/launch');
const { Browser, survey } = require('../src/cdp/index');

const TMP_PROFILE = path.join(os.tmpdir(), 'desktopos-cdp-smoke');

function hr(t) { console.log('\n=== ' + t + ' ==='); }

async function doLaunch(opts) {
  hr('启动');
  const r = await launch({
    headless: !opts.headed,
    userDataDir: TMP_PROFILE,
    url: 'about:blank',
  });
  console.log('browser :', r.browser.name, r.browser.path);
  console.log('port    :', r.port);
  console.log('profile :', r.profileDir);
  console.log('endpoint:', r.endpoint.browser);
  return r;
}

async function doSurvey() {
  hr('扫描');
  const list = await survey();
  if (!list.length) {
    console.log('没有发现任何 CDP 端点（本机浏览器都没开调试端口）');
    return;
  }
  for (const e of list) {
    console.log(`port ${e.port}  ${e.browser}`);
    e.pages.forEach((p) => console.log('   - [' + p.type + '] ' + p.title + ' | ' + p.url));
  }
}

const PAGE = `data:text/html;charset=utf-8,` + encodeURIComponent(`<!doctype html>
<html><body style="font-family:system-ui;padding:24px">
  <h1>中文标题测试</h1>
  <input id="kw" placeholder="请输入关键词" style="padding:8px;width:240px">
  <button id="go" onclick="document.getElementById('out').textContent='已点击：'+document.getElementById('kw').value">搜索</button>
  <button id="cancel">取消</button>
  <a href="#x">一个链接</a>
  <div id="out" style="margin-top:16px;color:#c00"></div>
</body></html>`);

async function doSmoke(opts) {
  const r = await doLaunch(opts);
  try {
    hr('连接 + 列页面');
    const browser = await Browser.attach({ port: r.port });
    console.log('targets:', JSON.stringify(await browser.targets()));

    const s = await browser.open({ index: 0 });
    console.log('session ok:', s.sessionId);

    hr('导航');
    await s.navigate(PAGE);
    await new Promise((res) => setTimeout(res, 800));
    console.log('where:', JSON.stringify(await s.where()));

    hr('控件树（默认 interestingOnly）');
    const els = await s.elements();
    console.log('共', els.length, '个：');
    els.slice(0, 20).forEach((e) => console.log('  [' + e.role + '] ' + e.name + (e.value ? ' = ' + e.value : '')));

    hr('中文输入');
    await s.type('中文关键词', { target: '请输入' });
    console.log('输入框内容 =', JSON.stringify(await s.eval("document.getElementById('kw').value")));

    hr('点击按钮');
    const clicked = await s.click('搜索');
    console.log('点了:', JSON.stringify({ name: clicked.name, role: clicked.role, x: clicked.x, y: clicked.y }));
    console.log('页面回显 =', JSON.stringify(await s.eval("document.getElementById('out').textContent")));

    hr('截图');
    const shot = await s.screenshot();
    const outPath = path.join(os.tmpdir(), 'desktopos-cdp-smoke.png');
    fs.writeFileSync(outPath, Buffer.from(shot.base64, 'base64'));
    console.log('已保存:', outPath, fs.statSync(outPath).size + ' bytes');

    hr('歧义与错误路径');
    try { await s.click('按钮'); } catch (e) { console.log('（预期）', e.message.split('\n')[0]); }
    try { await s.click('绝对不存在xyz'); } catch (e) { console.log('（预期）', e.message.split('\n')[0]); }

    browser.close();
  } finally {
    try { r.proc.kill(); } catch { /* 已退出 */ }
    console.log('\n浏览器进程已关闭');
  }
}

(async () => {
  const [, , cmd = 'survey', ...rest] = process.argv;
  const opts = { headed: rest.includes('--headed') };
  try {
    if (cmd === 'launch') await doLaunch(opts);
    else if (cmd === 'smoke') await doSmoke(opts);
    else await doSurvey();
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
