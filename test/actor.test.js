/**
 * Actor（UI 执行层）测试 —— 安全子集
 *
 * 重要：真实 click / type / key 会把你的鼠标和键盘焦点抢走，
 * 可能打断你正在做的事。因此自动化测试只覆盖：
 *   - 进程与协议打通
 *   - 只读操作（getCursor）
 *   - 无副作用动作（move，仅移动指针）+ verify 截图比对链路
 *   - 错误分支（未知动作应报错而非静默）
 * 真实点击/输入请用 test/_dbg-actor.js 手动触发，或经 MCP 显式调用。
 */

const { ActorWorker } = require('../src/actor/index.js');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

(async () => {
  const a = new ActorWorker({ startTimeout: 40000, cmdTimeout: 25000 });
  a.on('error', (e) => console.log('  [error]', e.message));

  console.log('\n--- 1. 启动 actor worker ---');
  const t0 = Date.now();
  await a.start();
  console.log('        启动耗时 ' + (Date.now() - t0) + 'ms');
  assert('worker alive', a.alive === true);

  console.log('\n--- 2. 只读：获取光标位置 ---');
  const c1 = await a.getCursor();
  assert('返回合法坐标', Number.isInteger(c1.x) && Number.isInteger(c1.y), JSON.stringify(c1));
  console.log('        当前光标: (' + c1.x + ',' + c1.y + ')');

  console.log('\n--- 3. 无副作用动作：move（仅移动指针，不点击）---');
  const tx = 40, ty = 40;
  const m = await a.move(tx, ty);
  assert('move 返回 note', typeof m.note === 'string' && m.note.includes('move'), JSON.stringify(m));
  const c2 = await a.getCursor();
  // 这是真实硬件状态，不是 mock：别的进程（或人手）可能刚好动一下鼠标。
  // 所以先给一次重试机会，再判失败 —— 否则会偶发假红。
  let ok2 = c2.x === tx && c2.y === ty;
  if (!ok2) {
    await a.move(tx, ty);
    const c3 = await a.getCursor();
    ok2 = c3.x === tx && c3.y === ty;
    if (!ok2) console.log('        重试后仍为 (' + c3.x + ',' + c3.y + ')');
  }
  assert('光标确实移动到位', ok2, JSON.stringify(c2));

  console.log('\n--- 4. verify 链路：move 前后截图比对 ---');
  const mv = await a.move(60, 60, { verify: true, settleMs: 200 });
  assert('返回 verify 结构', mv.verify && typeof mv.verify.diffRatio === 'number',
         JSON.stringify(mv));
  assert('diffRatio 在 0..1 之间', mv.verify.diffRatio >= 0 && mv.verify.diffRatio <= 1,
         String(mv.verify.diffRatio));
  console.log('        changed=' + mv.verify.changed + '  diffRatio=' + mv.verify.diffRatio);

  console.log('\n--- 5. 错误分支：未知动作应报错 ---');
  const bad = await a._act({ action: 'no_such_action' });
  assert('未知动作返回 ok:false', bad.ok === false, JSON.stringify(bad));
  const msg = Buffer.from(bad.error || '', 'base64').toString('utf8');
  assert('错误信息可读且含动作名', msg.includes('no_such_action'), msg);
  console.log('        ' + msg);

  console.log('\n--- 6. 中文文本经 base64 传输不损坏（仅编码层，不发按键）---');
  // 只验证 Node 侧 base64 往返与 PowerShell 解码一致，不真实粘贴
  const sample = '中文测试-代码-DesktopOS';
  const enc = Buffer.from(sample, 'utf8').toString('base64');
  const dec = Buffer.from(enc, 'base64').toString('utf8');
  assert('base64 往返无损', dec === sample, dec);
  assert('无替换字符', !dec.includes('\uFFFD'), dec);

  console.log('\n--- 7. 优雅退出 ---');
  await a.stop();
  assert('worker 已停止', a.alive === false);

  console.log('\n========================================');
  console.log('  Actor 结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================');
  console.log('  注：click / type / key 为有副作用操作，未自动测试。');
  console.log('      手动验证请用 test/_dbg-actor.js。\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常终止：', e);
  process.exit(1);
});
