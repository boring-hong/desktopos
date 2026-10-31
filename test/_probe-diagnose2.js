const { diagnose } = require('../src/diagnoser/index.js');
const more = [
  ['管理员路径 + 缺父目录（曾误判）', "Could not find a part of the path 'C:\\Users\\Administrator\\Documents\\a\\b\\x.txt'."],
  ['真正的权限不足', 'Access is denied.'],
  ['需要提升', 'This operation requires elevation.'],
  ['网络路径不可达', 'The network path was not found.'],
  ['TLS 失败', 'The request was aborted: Could not create SSL/TLS secure channel.'],
  ['普通路径不存在', "Could not find a part of the path 'D:\\work\\a\\b\\x.txt'."],
];
for (const [label, err] of more) {
  const d = diagnose({ error: err, command: 'x' });
  console.log(`  ${label.padEnd(28)} -> ${d.category.padEnd(15)} retryable=${d.retryable}${d.fix ? ' [有 fix]' : ''}`);
}
