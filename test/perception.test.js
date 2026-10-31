/**
 * 感知层测试（双通道感知）
 * 覆盖：结构通道、视觉通道、交叉验证、中文标题完整性
 */

const { PerceptionWorker } = require('../src/sensor/index.js');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

(async () => {
  const w = new PerceptionWorker({ startTimeout: 40000, cmdTimeout: 40000 });
  w.on('error', (e) => console.log('  [error]', e.message));

  console.log('\n--- 1. 启动感知 worker（首次需编译 C#）---');
  const t0 = Date.now();
  await w.start();
  console.log('        启动耗时 ' + (Date.now() - t0) + 'ms');
  assert('worker alive', w.alive === true);

  console.log('\n--- 2. 结构通道：枚举窗口 ---');
  const lw = await w.listWindows();
  assert('返回屏幕尺寸有效', lw.screen.w > 0 && lw.screen.h > 0, JSON.stringify(lw.screen));
  assert('枚举到窗口', lw.windows.length > 0, 'got ' + lw.windows.length);
  assert('窗口含矩形信息', lw.windows.every((x) => x.rect && typeof x.rect.x === 'number'));
  assert('窗口含进程名', lw.windows.every((x) => typeof x.process === 'string'));
  console.log('        屏幕 ' + lw.screen.w + 'x' + lw.screen.h + '，窗口 ' + lw.windows.length + ' 个');
  console.log('        聚焦窗口: ' + (lw.windows.find((x) => x.focused) || {}).title);

  console.log('\n--- 3. 中文标题完整性（CP936 回归点）---');
  const bad = lw.windows.filter((x) => x.title.includes('\uFFFD'));
  assert('无 U+FFFD 替换字符', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  const cjk = lw.windows.filter((x) => /[\u4e00-\u9fa5]/.test(x.title));
  console.log('        含中文标题的窗口: ' + cjk.length + ' 个');
  if (cjk.length) console.log('        例: ' + cjk[0].title.slice(0, 40));

  console.log('\n--- 4. 最小化窗口识别 ---');
  const minz = lw.windows.filter((x) => x.minimized);
  assert('最小化标记与坐标一致',
    minz.every((x) => x.rect.x < -10000 || x.rect.y < -10000),
    JSON.stringify(minz.slice(0, 2)));
  console.log('        最小化窗口: ' + minz.length + ' 个');

  console.log('\n--- 5. 视觉通道：截屏 ---');
  const shot = await w.screenshot({ includePng: true });
  assert('截屏尺寸有效', shot.width > 0 && shot.height > 0, shot.width + 'x' + shot.height);
  const pngHead = Buffer.from(shot.pngBase64, 'base64').slice(0, 8).toString('base64');
  assert('PNG 魔数正确 (iVBORw0K)', pngHead.startsWith('iVBORw0K'), pngHead);
  console.log('        ' + shot.width + 'x' + shot.height + '，PNG ' +
              Math.round(shot.pngBase64.length * 3 / 4 / 1024) + ' KB');

  console.log('\n--- 6. 双通道交叉验证 ---');
  const pv = await w.perceive();
  const cv = pv.crossValidation || {};
  assert('窗口数与交叉验证总数一致', cv.total === pv.windows.length,
         cv.total + ' vs ' + pv.windows.length);
  assert('一致数 + 不一致数 = 总数',
    cv.consistent + (cv.mismatches || []).length === cv.total,
    JSON.stringify(cv));
  assert('每个窗口都有 stdDev', pv.windows.every((x) => typeof x.stdDev === 'number'));
  assert('consistent 与布尔字段自洽',
    pv.windows.every((x) => x.consistent === (x.inBounds && x.hasContent)));
  console.log('        共 ' + cv.total + '，一致 ' + cv.consistent +
              '，不一致 ' + (cv.mismatches || []).length);
  const reasons = {};
  (cv.mismatches || []).forEach((m) => { reasons[m.reason] = (reasons[m.reason] || 0) + 1; });
  console.log('        不一致原因分布: ' + JSON.stringify(reasons));

  console.log('\n--- 7. 不返回图片时响应更小 ---');
  const pv2 = await w.perceive({ includePng: false });
  assert('默认不带 png', pv2.pngBase64 === '', 'len=' + pv2.pngBase64.length);

  console.log('\n--- 8. 元素级结构通道（UIA）---');
  // 逐个试可见窗口，至少要有一个原生应用能枚举出控件。
  // Electron/Chromium 默认不暴露控件树，返回 0 属正常，所以只要求"至少一个"。
  const candidates = lw.windows.filter((x) => !x.minimized)
    .sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0))
    .slice(0, 6);

  let total = 0, best = null;
  for (const t of candidates) {
    try {
      const r = await w.elements(t.handle, { maxElements: 100 });
      if (r.count > total) { total = r.count; best = { win: t, r }; }
    } catch { /* 单个窗口失败不影响整体 */ }
  }
  assert('至少一个窗口能枚举出控件', total > 0, '全部返回 0');

  if (best) {
    const e0 = best.r.elements[0];
    assert('控件含名称', typeof e0.name === 'string' && e0.name.length > 0, JSON.stringify(e0));
    assert('控件含类型', typeof e0.type === 'string', JSON.stringify(e0));
    assert('控件含矩形', e0.rect && typeof e0.rect.w === 'number' && e0.rect.w > 0, JSON.stringify(e0.rect));
    assert('控件名无乱码', !best.r.elements.some((e) => e.name.includes('\uFFFD')),
           JSON.stringify(best.r.elements.filter((e) => e.name.includes('\uFFFD')).slice(0, 2)));
    console.log('        ' + best.win.process + ' 枚举到 ' + total + ' 个控件');
    best.r.elements.slice(0, 5).forEach((e) => {
      console.log('          ' + (e.type || '?').padEnd(10) +
                  (e.canInvoke ? '[I]' : '   ') + e.name.slice(0, 38));
    });
  }

  console.log('\n--- 9. 优雅退出 ---');
  await w.stop();
  assert('worker 已停止', w.alive === false);

  console.log('\n========================================');
  console.log('  感知层结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常终止：', e);
  process.exit(1);
});
