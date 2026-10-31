const { execWithVerify } = require('../src/verifier/index.js');

// 用一个假 worker 记录真实执行次数，验证「retryable=false 是否仍然会重试」
function makeWorker(responses) {
  let n = 0;
  return {
    calls: [],
    get execCount() { return n; },
    async exec(cmd, opts) {
      n++;
      this.calls.push(cmd);
      const r = responses[Math.min(n - 1, responses.length - 1)];
      return r;
    },
    async getCwd() { return process.cwd(); },
  };
}

(async () => {
  console.log('=== 场景 A：权限不足（诊断器判定 retryable=false） ===');
  const wA = makeWorker(['Access is denied. (D:\\locked\\x.txt)']);
  const rA = await execWithVerify(wA, "New-Item -ItemType File -Path 'D:\\locked\\x.txt'", { pathExists: 'D:\\locked\\x.txt' }, { retries: 2 });
  console.log('  诊断类别 =', rA.diagnosis && rA.diagnosis.category);
  console.log('  诊断 retryable =', rA.diagnosis && rA.diagnosis.retryable);
  console.log('  实际执行次数 =', wA.execCount, '（retries=2 最多 3 次）');
  console.log('  => ', rA.diagnosis && rA.diagnosis.retryable === false && wA.execCount > 1
    ? '不一致：已判定重试无意义，却仍然重试了 ' + wA.execCount + ' 次'
    : '一致');

  console.log('\n=== 场景 B：命令不存在（retryable=false） ===');
  const wB = makeWorker(["The term 'nonexistentcmd' is not recognized as the name of a cmdlet."]);
  const rB = await execWithVerify(wB, 'nonexistentcmd', { pathExists: 'D:\\nope' }, { retries: 2 });
  console.log('  诊断类别 =', rB.diagnosis && rB.diagnosis.category, '| retryable =', rB.diagnosis && rB.diagnosis.retryable);
  console.log('  实际执行次数 =', wB.execCount);

  console.log('\n=== 场景 C：不传 expect（工具名叫 verified） ===');
  const wC = makeWorker(['anything']);
  const rC = await execWithVerify(wC, 'Write-Output hi', undefined, { retries: 2 });
  console.log('  ok =', rC.ok, '| detail =', JSON.stringify(rC.detail));
  console.log('  => 没有断言却报告"验证通过"，Agent 会误以为真的验证过');
})();
