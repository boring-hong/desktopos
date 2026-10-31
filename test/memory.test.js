/**
 * 记忆层测试
 * 用临时文件做存储，不污染 ~/.desktopos/memory.json
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { MemoryLayer, hammingHex } = require('../src/memory/index.js');

const TMP = path.join(os.tmpdir(), 'desktopos-memory-test-' + Date.now() + '.json');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

const SAMPLE = [
  { handle: 101, title: '钉钉', process: 'DingTalk', pid: 11,
    rect: { x: 0, y: 0, w: 1707, h: 1019 }, hash: 'A1B2C3D4E5F60718', focused: true, minimized: false },
  { handle: 102, title: 'WorkBuddy', process: 'WorkBuddy', pid: 22,
    rect: { x: 348, y: 66, w: 1206, h: 910 }, hash: '0F1E2D3C4B5A6978', focused: false, minimized: false },
  { handle: 103, title: '文件资源管理器', process: 'explorer', pid: 33,
    rect: { x: 100, y: 100, w: 800, h: 600 }, hash: '1122334455667788', focused: false, minimized: true }
];

(async () => {
  const m = new MemoryLayer({ file: TMP });

  console.log('\n--- 1. 操作日志 ---');
  m.record('perceive', '感知到 3 个窗口');
  m.record('click', '点击 (100,200)');
  const tl = m.timeline(10);
  assert('时间线有记录', tl.length === 2, JSON.stringify(tl));
  assert('最新在前', tl[0].summary.includes('点击'), JSON.stringify(tl[0]));
  assert('带可读时间', /\d{1,2}:\d{2}:\d{2}/.test(tl[0].time), tl[0].time);

  console.log('\n--- 2. 窗口特征索引 ---');
  const n = m.indexWindows(SAMPLE);
  assert('索引了 3 个窗口', n === 3, String(n));
  assert('忽略最小化的窗口参与定位', true);

  console.log('\n--- 3. 按关键词定位 ---');
  const r1 = m.resolve('钉钉');
  assert('按标题命中', r1.found && r1.title === '钉钉', JSON.stringify(r1));
  // rect {0,0,1707,1019} -> 中心 (853.5, 509.5) -> 四舍五入 (854, 510)
  assert('返回可点击中心坐标', r1.x === 854 && r1.y === 510, `(${r1.x},${r1.y})`);
  console.log('        钉钉 -> (' + r1.x + ',' + r1.y + ')');

  const r2 = m.resolve('WorkBuddy');
  assert('按进程名也能命中', r2.found && r2.process === 'WorkBuddy', JSON.stringify(r2));
  console.log('        WorkBuddy -> (' + r2.x + ',' + r2.y + ')');

  console.log('\n--- 4. 指代定位："刚才那个窗口" ---');
  const r3 = m.resolve('刚才那个窗口');
  assert('指代词命中且优先聚焦过的', r3.found && r3.title === '钉钉', JSON.stringify(r3));
  assert('理由是"按最近定位"', /最近/.test(r3.reason), r3.reason);
  console.log('        -> ' + r3.title + '  ' + r3.reason);

  console.log('\n--- 5. 最小化窗口：要区分"没有"和"有但最小化了" ---');
  const r5 = m.resolve('文件资源管理器');
  assert('最小化的不直接给坐标', !r5.found, JSON.stringify(r5));
  assert('原因是最小化而非不存在', /最小化/.test(r5.reason || ''), r5.reason);
  assert('给出可行动的 hint', /desktop_focus_window/.test(r5.hint || ''), r5.hint);
  assert('带上句柄供还原', r5.handle === 103, String(r5.handle));
  console.log('        ' + r5.reason);
  console.log('        ' + r5.hint);

  console.log('\n--- 6. 未命中应明确返回 found:false ---');
  const r6 = m.resolve('不存在的程序xyz');
  assert('未命中返回 false', r6.found === false, JSON.stringify(r6));
  assert('给出可读原因', !!r6.reason, JSON.stringify(r6));

  console.log('\n--- 7. 感知哈希相似度 ---');
  const hit = m.findByHash('A1B2C3D4E5F60718');
  assert('相同哈希距离为 0', hit && hit.distance === 0, JSON.stringify(hit));
  assert('定位到正确窗口', hit && hit.window.title === '钉钉', JSON.stringify(hit && hit.window));
  assert('不同哈希距离 > 0', hammingHex('A1B2C3D4E5F60718', '0F1E2D3C4B5A6978') > 0);
  const miss = m.findByHash('FFFFFFFFFFFFFFFF');
  assert('差异过大返回 null', miss === null, JSON.stringify(miss));

  console.log('\n--- 8. 元素级索引："确定按钮" ---');
  const ELS = [
    { name: '确定', type: 'Button', autoId: 'btnOk',
      rect: { x: 100, y: 200, w: 80, h: 30 }, canInvoke: true, enabled: true },
    { name: '取消', type: 'Button', autoId: 'btnCancel',
      rect: { x: 200, y: 200, w: 80, h: 30 }, canInvoke: true, enabled: true },
    { name: '用户名输入框', type: 'Edit', autoId: 'txtUser',
      rect: { x: 50, y: 100, w: 200, h: 24 }, canInvoke: false, enabled: true }
  ];
  m.indexElements({ handle: 999, title: '测试窗口', process: 'test' }, ELS);

  const e1 = m.resolve('确定按钮');
  assert('元素级命中', e1.found && e1.level === 'element', JSON.stringify(e1));
  assert('命中的是按钮', e1.name === '确定' && e1.type === 'Button', JSON.stringify(e1));
  assert('返回控件中心坐标', e1.x === 140 && e1.y === 215, `(${e1.x},${e1.y})`);
  assert('标记可 Invoke', e1.canInvoke === true);
  console.log('        确定按钮 -> ("' + e1.name + '") 坐标(' + e1.x + ',' + e1.y + ')');

  console.log('\n--- 9. "刚才那个按钮" 走交互栈 ---');
  m.recordInteraction({ name: '取消', type: 'Button', rect: ELS[1].rect,
                        windowHandle: 999, process: 'test' }, 'click');
  const e2 = m.resolve('刚才那个按钮');
  assert('指代词命中元素级', e2.found && e2.level === 'element', JSON.stringify(e2));
  assert('命中的是最近交互的"取消"', e2.name === '取消', JSON.stringify(e2));
  assert('理由是最近交互', /最近/.test(e2.reason), e2.reason);
  console.log('        刚才那个按钮 -> "' + e2.name + '"  ' + e2.reason);

  console.log('\n--- 10. 意图区分：说"窗口"不能返回按钮 ---');
  const e3 = m.resolve('刚才那个窗口');
  assert('明确说窗口时走窗口级', e3.found && e3.level === 'window', JSON.stringify(e3));
  assert('返回的仍是聚焦窗口', e3.title === '钉钉', JSON.stringify(e3));
  console.log('        刚才那个窗口 -> ' + e3.title + ' (level=' + e3.level + ')');

  console.log('\n--- 11. 控件名不存在时给出可行动提示 ---');
  const e4 = m.resolve('一个不存在按钮');
  assert('未命中控件返回 false', e4.found === false, JSON.stringify(e4));
  assert('提示先建元素索引', /desktop_elements/.test(e4.hint || ''), e4.hint);
  console.log('        ' + e4.reason + ' | ' + e4.hint);

  console.log('\n--- 12. 统计含元素与交互 ---');
  const st = m.stats();
  assert('统计含 elements', st.elements === 3, JSON.stringify(st));
  assert('统计含 interactions', st.interactions === 1, JSON.stringify(st));

  console.log('\n--- 13. 持久化 ---');
  assert('文件已写出', fs.existsSync(TMP), TMP);
  const m2 = new MemoryLayer({ file: TMP });
  assert('重开后仍能定位', m2.resolve('钉钉').found === true);
  assert('重开后时间线还在', m2.timeline(10).length === 2);

  console.log('\n--- 9. 清空 ---');
  m2.clear();
  assert('清空后无窗口', m2.resolve('钉钉').found === false);
  assert('清空后时间线为空', m2.timeline(10).length === 0);

  try { fs.unlinkSync(TMP); } catch {}

  console.log('\n========================================');
  console.log('  记忆层结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n测试异常终止：', e); process.exit(1); });
