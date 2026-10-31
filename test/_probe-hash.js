const { MemoryLayer, hammingHex } = require('../src/memory/index.js');
const m = new MemoryLayer();
const windows = (m.data && m.data.windows) ? m.data.windows : [];
console.log('索引里的窗口数 =', windows.length);
const withHash = windows.filter(w => w.hash);
console.log('带 hash 的 =', withHash.length);
if (withHash.length < 2) { console.log('样本不足，跳过'); process.exit(0); }

// 计算所有两两汉明距离，看有多少对落在 maxDistance=10 以内
const pairs = [];
for (let i = 0; i < withHash.length; i++) {
  for (let j = i + 1; j < withHash.length; j++) {
    const d = hammingHex(withHash[i].hash, withHash[j].hash);
    pairs.push({ d, a: withHash[i].title, b: withHash[j].title });
  }
}
pairs.sort((x, y) => x.d - y.d);
const within = pairs.filter(p => p.d <= 10);
console.log(`比对 ${pairs.length} 对，其中距离<=10 的有 ${within.length} 对 (${(100*within.length/pairs.length).toFixed(1)}%)`);
console.log('最近 8 对：');
pairs.slice(0, 8).forEach(p => console.log(`  d=${String(p.d).padStart(2)}  ${String(p.a).slice(0,28)}  <->  ${String(p.b).slice(0,28)}`));
console.log('最远 3 对：');
pairs.slice(-3).forEach(p => console.log(`  d=${String(p.d).padStart(2)}  ${String(p.a).slice(0,28)}  <->  ${String(p.b).slice(0,28)}`));
