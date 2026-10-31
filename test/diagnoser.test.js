/**
 * 错误诊断器测试
 *
 * 分类部分用真实的 PowerShell / 本项目的报错原文做表驱动用例 ——
 * 规则表最大的风险是"看起来对、实际匹配不上"，所以断言必须用真字符串。
 * 最后一项是真自愈集成：故意让命令因为父目录缺失而失败，看它能不能自己补建后成功。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { diagnose, formatDiagnosis, extractPaths } = require('../src/diagnoser/index.js');
const { execWithVerify } = require('../src/verifier/index.js');
const { ShellWorker } = require('../src/shell-worker/index.js');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

const CASES = [
  ['编码损坏', "New-Item : 找不到路径“D:\uFFFD\uFFFD\uFFFD\uFFFD\a”", 'encoding', false],
  ['文件被占用', "The process cannot access the file 'C:\\data\\book.xlsx' because it is being used by another process.", 'file-locked', true],
  ['中文：文件被占用', "文件“D:\\报表.xlsx”正由另一进程使用，因此该进程无法访问此文件。", 'file-locked', true],
  ['权限不足', 'New-Item : Access is denied.', 'access-denied', false],
  ['权限不足（异常型）', 'Exception calling "Open" with "0" argument(s): "UnauthorizedAccessException"', 'access-denied', false],
  ['命令不存在', "The term 'gitx' is not recognized as a name of a cmdlet, function, script file, or operable program.", 'cmd-not-found', false],
  ['命令不存在（中文）', '无法将“nodee”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。', 'cmd-not-found', false],
  ['控件歧义', '"搜索" 匹配到 3 个同级控件，请用更精确的名称', 'ambiguous-element', false],
  ['控件找不到', 'element not found: 确定', 'element-not-found', true],
  ['控件找不到（CDP）', '页面上找不到名称包含 "搜索" 的控件', 'element-not-found', true],
  ['窗口最小化', '"Excel" 在记忆里存在，但当前处于最小化状态，无法直接点击', 'window-minimized', false],
  ['CDP 不可用', '没有发现任何 CDP 端点（本机浏览器都没开调试端口）', 'cdp-unavailable', false],
  ['UIA 不可用', '未枚举到控件。可能原因：该应用不暴露 UI Automation 控件树', 'uia-unavailable', false],
  ['目标已存在', "An item with the specified name C:\\tmp\\demo already exists.", 'already-exists', false],
  ['参数名错误', "A parameter cannot be found that matches parameter name 'Pathx'.", 'param-error', false],
  ['类型转换失败', 'Cannot convert value "abc" to type "System.Int32".', 'type-convert', false],
  ['语法错误', "Unexpected token ')' in expression or statement.", 'syntax', false],
  ['超时', '命令执行超时', 'timeout', true],
  ['未归类', 'SomeBrandNewError: quantum flux misaligned', 'unknown', true],
];

(async () => {
  console.log('--- 1. 分类（用真实报错原文）---');
  for (const [name, text, wantCat, wantRetry] of CASES) {
    const d = diagnose({ error: text });
    assert(name + ' -> ' + wantCat, d.category === wantCat,
           `实际 ${d.category} | ${d.reason}`);
    assert('  retryable=' + wantRetry, d.retryable === wantRetry, '实际 ' + d.retryable);
  }

  console.log('\n--- 2. 每条诊断都必须给出可行动的下一步 ---');
  for (const [name, text] of CASES) {
    const d = diagnose({ error: text });
    assert(name + ' 有 reason', !!d.reason);
    assert(name + ' 有 hint', !!d.hint);
    if (d.category !== 'unknown') {
      assert(name + ' 有 suggestion', !!d.suggestion, JSON.stringify(d));
    }
  }

  console.log('\n--- 3. 父目录缺失：给修补命令（限创建类命令）---');
  const mkCmd = "New-Item -ItemType File -Path 'C:\\nope-xyz-123\\deep\\a.txt' | Out-Null";
  const missingParent = diagnose({
    error: "New-Item : Could not find a part of the path 'C:\\nope-xyz-123\\deep\\a.txt'.",
    command: mkCmd,
  });
  assert('归类为 missing-parent', missingParent.category === 'missing-parent', missingParent.category);
  assert('给出 fix', !!missingParent.fix, JSON.stringify(missingParent));
  assert('fix 是建父目录',
         /New-Item -ItemType Directory/.test(missingParent.fix || ''), missingParent.fix);
  assert('fix 指向存在的可建路径',
         (missingParent.fix || '').includes('nope-xyz-123'), missingParent.fix);

  const readOnly = diagnose({
    error: "Get-ChildItem : Cannot find path 'C:\\nope-xyz-123\\deep' because it does not exist.",
    command: "Get-ChildItem 'C:\\nope-xyz-123\\deep'",
  });
  assert('读命令也归为 missing-parent', readOnly.category === 'missing-parent', readOnly.category);
  assert('读命令不给 fix（不能凭空造路径）', readOnly.fix === null, String(readOnly.fix));
  assert('hint 说明这是读取命令', /读取命令/.test(readOnly.hint || ''), readOnly.hint);

  console.log('\n--- 4. 父目录其实存在：不该误报成缺父目录 ---');
  const realTmp = os.tmpdir();
  const existParent = diagnose({
    error: `New-Item : Cannot find path '${realTmp}\\no-such-file-xyz.txt' because it does not exist.`,
  });
  assert('仍然归类 missing-parent（属于路径不存在族）', existParent.category === 'missing-parent');
  assert('但不给 fix（补建一个已存在的目录毫无意义）', existParent.fix === null, String(existParent.fix));

  console.log('\n--- 5. 路径提取 ---');
  const paths = extractPaths("Cannot find path 'D:\\代码\\desktopos\\x.txt' because it does not exist.");
  assert('提取出路径', paths.length > 0, JSON.stringify(paths));
  assert('路径含中文目录', paths.some((p) => p.includes('代码')), JSON.stringify(paths));

  console.log('\n--- 5b. 真实中文报错（全角引号 + "未能找到路径"）---');
  const cn = diagnose({
    error: '未能找到路径“D:\\代码\\新目录\\a.txt”的一部分。',
    command: "New-Item -ItemType File -Path 'D:\\代码\\新目录\\a.txt'",
  });
  assert('归类为 missing-parent', cn.category === 'missing-parent', cn.category);
  assert('从全角引号里提取出中文路径', (cn.fix || '').includes('新目录'), JSON.stringify(cn));
  assert('fix 保留中文未损坏', !/\uFFFD/.test(cn.fix || ''), cn.fix);

  console.log('\n--- 6. 空输入要说实话 ---');
  const empty = diagnose({});
  assert('空输入归类 unknown', empty.category === 'unknown');
  assert('说明拿不到报错', /没有拿到任何错误信息/.test(empty.reason), empty.reason);

  console.log('\n--- 7. 渲染成文本 ---');
  const txt = formatDiagnosis(diagnose({ error: 'Access is denied.' }));
  assert('含诊断行', /^诊断: /.test(txt), txt);
  assert('含原因', txt.includes('原因:'), txt);
  assert('含建议', txt.includes('建议:'), txt);
  assert('标注重试无意义', txt.includes('重试无意义'), txt);

  console.log('\n--- 8. 集成：真自愈（父目录缺失 -> 自动补建 -> 通过）---');
  const base = path.join(os.tmpdir(), 'desktopos-diag-' + Date.now());
  const target = path.join(base, 'a', 'b', 'x.txt');
  const w = new ShellWorker({ initialCwd: os.tmpdir(), timeout: 60000 });
  await w.start();
  try {
    const r = await execWithVerify(
      w,
      `New-Item -ItemType File -Path '${target}' | Out-Null`,
      { isFile: target },
      { retries: 1, backoffMs: 50 }
    );
    assert('自愈后验证通过', r.ok === true, JSON.stringify({ detail: r.detail, diag: r.diagnosis }));
    assert('确实应用了修补', (r.fixes || []).length === 1, JSON.stringify(r.fixes));
    assert('修补是建目录', /New-Item -ItemType Directory/.test((r.fixes || [])[0] || ''));
    assert('目标文件真的存在', fs.existsSync(target), target);
    assert('带回了诊断结果', !!(r.diagnosis && r.diagnosis.category), JSON.stringify(r.diagnosis));
  } finally {
    try { await w.stop(); } catch {}
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }

  console.log('\n--- 9. 集成：不可修的失败要带回诊断，而不是干重试 ---');
  const w2 = new ShellWorker({ initialCwd: os.tmpdir(), timeout: 60000 });
  await w2.start();
  try {
    const bad = path.join(os.tmpdir(), 'desktopos-never-' + Date.now(), 'y.txt');
    const r = await execWithVerify(
      w2,
      `Get-ChildItem 'C:\\no-such-drive-dir-xyz\\q.txt'`,
      { isFile: bad },
      { retries: 0, backoffMs: 50 }
    );
    assert('验证不通过', r.ok === false);
    assert('带回了诊断', !!(r.diagnosis && r.diagnosis.category), JSON.stringify(r.diagnosis));
    assert('诊断有原因', !!r.diagnosis.reason, JSON.stringify(r.diagnosis));
    assert('没有乱建目录', (r.fixes || []).length === 0, JSON.stringify(r.fixes));
  } finally {
    try { await w2.stop(); } catch {}
  }

  console.log('\n========================================');
  console.log('  诊断器结果：通过 ' + pass + ' / 失败 ' + fail);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})();
