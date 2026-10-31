const { PerceptionWorker } = require('../src/sensor/index.js');

(async () => {
  const w = new PerceptionWorker({ startTimeout: 40000, cmdTimeout: 60000 });
  await w.start();
  const lw = await w.listWindows();
  console.log('屏幕 ' + lw.screen.w + 'x' + lw.screen.h + '，窗口共 ' + lw.windows.length + ' 个\n');

  const vis = lw.windows.filter((x) => !x.minimized)
    .sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0));

  console.log('handle      process          rect                  focused  元素  耗时');
  console.log('-'.repeat(80));

  for (const t of vis) {
    const t0 = Date.now();
    let count = '-', err = '';
    try {
      const r = await w.elements(t.handle, { maxElements: 200 });
      count = String(r.count);
    } catch (e) { err = e.message.split('\n')[0].slice(0, 22); }
    const ms = Date.now() - t0;
    console.log(
      String(t.handle).padEnd(11) +
      (t.process || '').padEnd(16) +
      (`(${t.rect.x},${t.rect.y} ${t.rect.w}x${t.rect.h})`).padEnd(21) +
      (t.focused ? '  *     ' : '        ') +
      String(count).padStart(4) + '  ' + String(ms).padStart(5) + 'ms ' + err
    );
  }

  await w.stop();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
