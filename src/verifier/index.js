/**
 * 操作验证层（自愈的闭环）
 *
 * 现状：AI 执行 mkdir → 报错 → 人改 → 重跑。
 * 这里把「操作 → 验证 → 诊断 → 修补 → 重试」做成通用能力：
 * 每次执行后不轻信命令的返回值，而是用文件系统 API 独立验证预期结果。
 *
 * 关键：验证走 Node 的 fs（原生 UTF-8 路径），不经过 shell，
 * 因此不受 PowerShell 编码/引号问题影响，中文路径同样可靠。
 *
 * 两条被评审指出来过的修正：
 *   1. `retryable` 必须**真的接线**。以前诊断器算出了"重试无意义"，也把这个
 *      结论写给 Agent 看了，但重试循环自己根本不读它，照样打三遍 —— 恰好是
 *      README 批评的"无脑重试"。现在诊断判不可重试且没有可自动修补的方案时，
 *      循环立即停止。
 *   2. 没传 `expect` 时不能对外说"验证通过"。那时什么都没验，只是把命令跑了一遍。
 */

const fs = require('fs');
const path = require('path');
const { diagnose } = require('../diagnoser/index.js');

/**
 * 支持的断言。每种返回 { ok, detail }
 */
const CHECKS = {
  pathExists(p) {
    const ok = fs.existsSync(p);
    return { ok, detail: ok ? `路径已存在: ${p}` : `路径不存在: ${p}` };
  },
  pathNotExists(p) {
    const ok = !fs.existsSync(p);
    return { ok, detail: ok ? `路径已确认不存在: ${p}` : `路径仍存在: ${p}` };
  },
  isDir(p) {
    let ok = false;
    try { ok = fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch {}
    return { ok, detail: ok ? `是目录: ${p}` : `不是目录: ${p}` };
  },
  isFile(p) {
    let ok = false;
    try { ok = fs.existsSync(p) && fs.statSync(p).isFile(); } catch {}
    return { ok, detail: ok ? `是文件: ${p}` : `不是文件: ${p}` };
  },
  fileContains(args) {
    const [p, needle] = args;
    let ok = false;
    try { ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(needle); } catch (e) {
      return { ok: false, detail: `读取失败: ${e.message}` };
    }
    return { ok, detail: ok ? `文件包含目标内容: ${p}` : `文件不包含目标内容: ${p}` };
  },
  cwdIs(p) {
    return { ok: true, detail: `cwd 断言由调用方处理: ${p}`, defer: true };
  }
};

/**
 * 执行一组断言。
 * @param {object} expect 形如 { pathExists: 'x', isDir: 'y', fileContains: ['z','needle'] }
 * @param {object} ctx 额外上下文，如 { cwd }
 */
function verify(expect, ctx = {}) {
  if (!expect || typeof expect !== 'object' || Object.keys(expect).length === 0) {
    return { ok: true, verified: false, detail: '未指定断言，本次未做验证' };
  }

  const details = [];
  let allOk = true;

  for (const [key, value] of Object.entries(expect)) {
    if (key === 'cwd') {
      const want = path.resolve(String(value)).toLowerCase();
      const got = String(ctx.cwd || '').toLowerCase();
      const ok = got === want;
      details.push(ok ? `cwd 正确: ${got}` : `cwd 不符，期望 ${want}，实际 ${got}`);
      if (!ok) allOk = false;
      continue;
    }

    const check = CHECKS[key];
    if (!check) {
      details.push(`未知断言类型: ${key}`);
      allOk = false;
      continue;
    }

    let r;
    try {
      r = check(value);
    } catch (e) {
      r = { ok: false, detail: `断言 ${key} 执行异常: ${e.message}` };
    }
    if (r.defer) continue;
    details.push(r.detail);
    if (!r.ok) allOk = false;
  }

  return { ok: allOk, verified: true, detail: details.join(' | ') };
}

// 这些类别的自动修补是"纯加法"，不会破坏任何东西 —— 所以默认就做。
// 其余类别（如 -Force 覆盖）必须调用方显式开 autoFix。
const SAFE_FIXES = new Set(['missing-parent']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** expect 是否真的包含至少一条断言 */
function hasExpect(expect) {
  return !!expect && typeof expect === 'object' && Object.keys(expect).length > 0;
}

/**
 * 执行 + 验证 + 诊断 + 自动修补 + 带退避的重试。
 *
 * 和"只重试"的区别：失败后会先 diagnose 搞清原因，
 * 能自动修的（如父目录不存在）先修再重试；
 * 诊断判定「原样重试没有意义」且没有可自动修补方案时，**立刻停手**。
 *
 * @returns {Promise<{ok, verified, attempts, output, detail, diagnosis, fixes}>}
 */
async function execWithVerify(worker, command, expect, options = {}) {
  const retries = options.retries == null ? 2 : options.retries;
  const backoffMs = options.backoffMs == null ? 400 : options.backoffMs;
  const timeout = options.timeout;
  const autoFix = options.autoFix === true;
  const verified = hasExpect(expect);

  let output = '';
  let cmdErr = '';   // 命令自己的异常（不是验证结论）
  let lastDetail = '';
  let lastDiag = null;
  const fixes = [];
  let pendingFix = false; // 最后一次尝试之后是否刚应用过修补
  let gaveUpEarly = false; // 诊断判定不可重试而提前停手
  let attempts = 0;        // 真实执行次数

  const runOnce = async () => {
    attempts++;
    cmdErr = '';
    try {
      output = await worker.exec(command, timeout ? { timeout } : {});
    } catch (e) {
      output = '';
      cmdErr = '命令执行异常: ' + e.message;
    }
    let cwd = '';
    // 只有真需要 cwd 断言时才多跑一趟 —— 每次尝试都查会白白多一个往返
    if (expect && Object.prototype.hasOwnProperty.call(expect, 'cwd')) {
      try { cwd = await worker.getCwd(); } catch {}
    }
    const v = verify(expect, { cwd });
    lastDetail = cmdErr ? cmdErr + ' | ' + v.detail : v.detail;
    return v.ok;
  };

  for (let i = 0; i <= retries; i++) {
    if (await runOnce()) {
      return { ok: true, verified, attempts, output, detail: lastDetail, fixes, diagnosis: lastDiag };
    }

    lastDiag = diagnose({ error: cmdErr, output, command, expect });
    const fix = lastDiag.fix;
    const allowed = fix && (autoFix || SAFE_FIXES.has(lastDiag.category));

    pendingFix = false;
    if (allowed && !fixes.includes(fix)) {
      fixes.push(fix);
      try { await worker.exec(fix, timeout ? { timeout } : {}); } catch {}
      pendingFix = true; // 修补改变了状态，值得再试一次
    }

    // 核心修正：诊断说「原样重试没有意义」，且这次也没能自动修 —— 别打了。
    // 对权限不足 / 命令不存在 / 参数写错这类失败，重试只是浪费时间和副作用。
    if (!pendingFix && lastDiag.retryable === false) {
      gaveUpEarly = true;
      break;
    }

    if (i < retries) await sleep(backoffMs * Math.pow(2, i)); // 指数退避
  }

  // 修补发生在最后一次尝试之后 —— 再给一次机会，否则白修
  if (pendingFix && await runOnce()) {
    return {
      ok: true, verified, attempts,
      output, detail: lastDetail, fixes, diagnosis: lastDiag,
    };
  }
  if (pendingFix || gaveUpEarly) {
    lastDiag = diagnose({ error: cmdErr, output, command, expect });
  }

  return {
    ok: false,
    verified,
    attempts,
    output,
    error: '验证未通过',
    detail: lastDetail,
    diagnosis: lastDiag,
    fixes,
    gaveUpEarly,
  };
}

module.exports = { verify, execWithVerify, CHECKS, hasExpect };
