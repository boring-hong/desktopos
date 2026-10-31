/**
 * 编码守卫测试
 *
 * 为什么必须守：PowerShell 5.1 在没有 BOM 时按 ANSI/CP936 读取 .ps1。
 * 一旦脚本里混入中文（哪怕只是注释），就会被解成乱码，
 * 轻则语法错误，重则悄悄破坏紧随其后的代码行 —— 例如中文注释后面那行
 * `$min = if (...) {...}` 曾因此整体失效，产出的 JSON 变成 "minimized":,
 *
 * 所以：所有 .ps1 必须纯 ASCII，非 ASCII 数据一律走 base64 传输。
 * 这条测试就是这条规则的执行者。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PS1_FILES = [
  'src/shell-worker/worker.ps1',
  'src/sensor/perception.ps1',
  'src/actor/actor.ps1'
];

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        -> ' + extra : '')); }
}

console.log('\n--- .ps1 纯 ASCII 守卫 ---');

for (const rel of PS1_FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    assert(rel + ' 存在', false, '文件不存在');
    continue;
  }
  const buf = fs.readFileSync(abs);
  const bad = [];
  buf.toString('binary').split(/\r?\n/).forEach((line, i) => {
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(line)) bad.push({ line: i + 1, text: line.trim().slice(0, 60) });
  });
  assert(rel + ' 纯 ASCII', bad.length === 0,
         bad.map((b) => `L${b.line}: ${b.text}`).join('\n        '));

  // 无 BOM（有 BOM 反而说明曾被当 UTF-8 处理过，这里一并提示）
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  assert(rel + ' 无 BOM 且为纯 ASCII 字节', !hasBom && buf.every((b) => b < 0x80));
}

console.log('\n========================================');
console.log('  编码守卫结果：通过 ' + pass + ' / 失败 ' + fail);
console.log('========================================\n');
process.exit(fail ? 1 : 0);
