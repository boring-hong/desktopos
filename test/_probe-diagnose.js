const { diagnose } = require('../src/diagnoser/index.js');
const cases = [
  ['路径不存在（普通）', "Could not find a part of the path 'D:\\work\\a\\b\\x.txt'."],
  ['路径不存在 + Administrator', "Could not find a part of the path 'C:\\Users\\Administrator\\Documents\\a\\b\\x.txt'."],
  ['文件占用 + 正文含 Administrator', "The process cannot access the file because it is being used by another process. (run as Administrator check skipped)"],
  ['命令不存在 + Administrator 在路径里', "The term 'foo' is not recognized as the name of a cmdlet. (cwd C:\\Users\\Administrator)"],
  ['超时 + Administrator 路径', "Operation timed out after 30000ms while reading C:\\Users\\Administrator\\big.bin"],
  ['服务名含 Access（非权限错误）', "Service 'SqlAccess' was not found."],
  ['网络路径不可达', "The network path was not found."],
  ['中文：未能找到路径', "New-Item : 未能找到路径“C:\\Users\\Administrator\\a\\b”的一部分。"],
];
for (const [label, err] of cases) {
  const d = diagnose({ error: err, command: 'x' });
  console.log(`\n[${label}]`);
  console.log(`  category  = ${d.category}   retryable=${d.retryable}`);
  console.log(`  reason    = ${d.reason}`);
  if (d.fix) console.log(`  fix       = ${d.fix}`);
}
