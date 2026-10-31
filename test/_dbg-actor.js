/**
 * Actor 手动验证工具 —— 会真实操作你的桌面
 *
 * 用法（务必先看清，运行会抢走鼠标和键盘焦点）：
 *   node test/_dbg-actor.js cursor
 *   node test/_dbg-actor.js move 500 300
 *   node test/_dbg-actor.js click 500 300
 *   node test/_dbg-actor.js click 500 300 right
 *   node test/_dbg-actor.js key "alt+tab"
 *   node test/_dbg-actor.js type "中文输入测试"
 *   node test/_dbg-actor.js focus 123456
 *   node test/_dbg-actor.js scroll 500 300 -240
 *
 * 所有动作默认带 verify：前后各截一次屏，报告像素变化率，
 * 用来判断"这一下到底点出反应没有"。
 *
 * 建议流程：
 *   1. 先 `node test/_dbg-perception.js` 看窗口矩形
 *   2. 用矩形中心坐标来 click
 *   3. 看 verify 的 diffRatio 是否说明界面变了
 */

const { ActorWorker } = require('../src/actor/index.js');

const [cmd, ...rest] = process.argv.slice(2);

(async () => {
  if (!cmd) {
    console.log('请指定动作：cursor | move | click | key | type | focus | scroll');
    console.log('例：node test/_dbg-actor.js click 500 300');
    process.exit(0);
  }

  const a = new ActorWorker({ startTimeout: 40000, cmdTimeout: 30000 });
  a.on('error', (e) => console.error('[error]', e.message));
  await a.start();
  console.log('actor ready (会真实操作桌面，5 秒后开始)');
  await new Promise((r) => setTimeout(r, 5000)); // 给用户切走焦点的时间

  let r;
  switch (cmd) {
    case 'cursor': {
      const c = await a.getCursor();
      console.log('光标:', c);
      break;
    }
    case 'move':
      r = await a.move(Number(rest[0]), Number(rest[1]), { verify: true });
      break;
    case 'click':
      r = await a.click(Number(rest[0]), Number(rest[1]),
                        { button: rest[2] || 'left', count: Number(rest[3]) || 1, verify: true });
      break;
    case 'key':
      r = await a.key(rest[0], { verify: true });
      break;
    case 'type':
      r = await a.type(rest[0], { verify: true });
      break;
    case 'focus':
      r = await a.focus(Number(rest[0]), { verify: true });
      break;
    case 'scroll':
      r = await a.scroll(Number(rest[0]), Number(rest[1]), Number(rest[2] || -120), { verify: true });
      break;
    default:
      console.error('未知动作:', cmd);
      await a.stop();
      process.exit(1);
  }

  if (r) {
    console.log('动作 :', r.note);
    if (r.verify) {
      console.log('验证 :', r.verify.changed ? '界面有变化' : '界面无变化',
                  '(diffRatio=' + r.verify.diffRatio + ')');
    }
  }

  await a.stop();
  console.log('已停止');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
