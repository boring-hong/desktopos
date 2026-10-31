const { PerceptionWorker } = require('../src/sensor/index.js');

(async () => {
  const w = new PerceptionWorker({ startTimeout: 40000, cmdTimeout: 40000 });
  w.on('error', (e) => console.log('[error]', e.message));
  console.log('启动 perception worker（首次需编译 C#，可能慢）...');
  const t0 = Date.now();
  await w.start();
  console.log('启动耗时 ' + (Date.now() - t0) + 'ms, alive=' + w.alive);

  console.log('\n=== 结构通道: listWindows ===');
  const t1 = Date.now();
  const lw = await w.listWindows();
  console.log('耗时 ' + (Date.now() - t1) + 'ms');
  console.log('屏幕: ' + JSON.stringify(lw.screen));
  console.log('窗口数: ' + lw.windows.length);
  lw.windows.slice(0, 12).forEach((x) => {
    console.log('  [' + x.process + '] ' + JSON.stringify(x.rect) +
                (x.focused ? '  <FOCUS>' : '') + '  ' + x.title.slice(0, 42));
  });

  console.log('\n=== 视觉通道: screenshot ===');
  const t2 = Date.now();
  const shot = await w.screenshot({ includePng: true });
  console.log('耗时 ' + (Date.now() - t2) + 'ms');
  console.log('尺寸: ' + shot.width + 'x' + shot.height + ', png bytes(b64 len)=' + shot.pngBase64.length);

  console.log('\n=== 双通道 + 交叉验证: perceive ===');
  const t3 = Date.now();
  const pv = await w.perceive();
  console.log('耗时 ' + (Date.now() - t3) + 'ms');
  console.log('交叉验证: ' + JSON.stringify(pv.crossValidation));
  pv.windows.slice(0, 12).forEach((x) => {
    console.log('  ' + (x.consistent ? 'OK  ' : 'MISS') +
                ' stdDev=' + String(x.stdDev).padStart(6) +
                ' inBounds=' + x.inBounds +
                ' hasContent=' + x.hasContent +
                '  ' + x.title.slice(0, 34));
  });

  await w.stop();
  console.log('\n已停止');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
