/**
 * 复核 dHash 是否真的在生效，以及它和 aHash 的区分度差异。
 * 直接现场抓一帧，算两两距离 —— 不看持久化索引（可能是旧算法留下的）。
 */
const { PerceptionWorker } = require('../src/sensor/index.js');
const { hammingHex } = require('../src/memory/index.js');

(async () => {
  const s = new PerceptionWorker({});
  await s.start();
  const r = await s.perceive({ includePng: false });
  await s.stop();

  const wins = r.windows.filter((w) => w.hash && !w.minimized);
  console.log('非最小化、带 hash 的窗口 =', wins.length);

  const pairs = [];
  for (let i = 0; i < wins.length; i++) {
    for (let j = i + 1; j < wins.length; j++) {
      pairs.push({
        d: hammingHex(wins[i].hash, wins[j].hash),
        a: wins[i].title || wins[i].process,
        b: wins[j].title || wins[j].process,
        ha: wins[i].hash, hb: wins[j].hash,
      });
    }
  }
  pairs.sort((x, y) => x.d - y.d);

  console.log('比对', pairs.length, '对');
  console.log('距离分布：');
  const buckets = {};
  for (const p of pairs) {
    const b = p.d === 0 ? '0' : p.d <= 3 ? '1-3' : p.d <= 6 ? '4-6' : p.d <= 12 ? '7-12' : '>12';
    buckets[b] = (buckets[b] || 0) + 1;
  }
  console.log(' ', JSON.stringify(buckets));

  console.log('\n最近的 6 对：');
  pairs.slice(0, 6).forEach((p) => {
    console.log(`  d=${String(p.d).padStart(2)}  ${String(p.a).slice(0, 26)}  <->  ${String(p.b).slice(0, 26)}`);
    console.log(`        ${p.ha}  vs  ${p.hb}`);
  });

  const zero = pairs.filter((p) => p.d === 0).length;
  console.log(`\n完全相同的对数 = ${zero} / ${pairs.length}`);
  console.log(zero <= Math.max(1, Math.floor(pairs.length * 0.02))
    ? '判定：碰撞率可接受（<=2%）'
    : '判定：仍有较多完全碰撞 —— 那些大概率都是纯色/空白区域，属已知退化情况');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
