/**
 * 启动一个"可被 CDP 调试"的浏览器实例
 *
 * 关键点：必须带 --remote-debugging-port，否则 UIA 看不见内部、CDP 也连不上。
 * 用独立的 --user-data-dir，避免和用户正在用的浏览器抢 profile。
 * 端口只监听 127.0.0.1（CDP 默认行为），不外泄。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe } = require('./discover');

const CANDIDATES = [
  { name: 'edge',    path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'edge',    path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'chrome',  path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'chrome',  path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
];

if (process.env.LOCALAPPDATA) {
  CANDIDATES.push({
    name: 'chrome',
    path: path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  });
}

/** 找出本机可用的 Chromium 内核浏览器。 */
function findBrowser(explicitPath) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) throw new Error('指定的浏览器不存在: ' + explicitPath);
    return { name: path.basename(explicitPath).replace(/\.exe$/i, ''), path: explicitPath };
  }
  for (const c of CANDIDATES) {
    if (fs.existsSync(c.path)) return { ...c };
  }
  return null;
}

function defaultProfileDir() {
  return path.join(os.homedir(), '.desktopos', 'cdp-profile');
}

/**
 * 每次启动用独立的 profile 目录。
 *
 * 为什么不是固定复用 `~/.desktopos/cdp-profile`：Chromium 系浏览器对同一个
 * user-data-dir 只允许一个实例。已经有一个在用的时候，新进程会把参数转交给
 * 老实例然后自己退出 —— 那个 `--remote-debugging-port` 根本不会开，于是
 * launch() 只能干等到超时。上一次被中断的自动化正好会留下这样一个实例，
 * 下一次就必然失败（实测踩过）。
 * 每次一个新目录，这类锁竞争从根上不存在；用完由 close() 删掉。
 */
function uniqueProfileDir() {
  const base = path.join(os.homedir(), '.desktopos');
  return path.join(base, `cdp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

function rmProfileDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function randomPort() {
  return 9222 + Math.floor(Math.random() * 128);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 启动浏览器并等它的 CDP 端点就绪。
 * @returns { browser, proc, port, profileDir, endpoint, args }
 */
async function launch({
  port = randomPort(),
  url = 'about:blank',
  headless = false,
  userDataDir,
  browserPath,
  extraArgs = [],
  waitMs = 20000,
} = {}) {
  const browser = findBrowser(browserPath);
  if (!browser) {
    throw new Error('未找到 Edge / Chrome。可用 browserPath 参数显式指定。');
  }

  // 未显式指定就用一个一次性目录，避免和一个还在运行的旧实例抢 profile
  const profileDir = userDataDir || uniqueProfileDir();
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--disable-background-networking',
    ...extraArgs,
  ];
  if (headless) args.push('--headless=new');
  if (url) args.push(url);

  const proc = spawn(browser.path, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: headless,
  });
  proc.unref();

  // 端点不是立刻可用，轮询等待
  const deadline = Date.now() + waitMs;
  let endpoint = null;
  while (Date.now() < deadline) {
    endpoint = await probe(port);
    if (endpoint) break;
    await sleep(200);
  }
  if (!endpoint) {
    try { proc.kill(); } catch { /* 已退出 */ }
    if (!userDataDir) rmProfileDir(profileDir);
    throw new Error(
      `浏览器已启动但 ${waitMs}ms 内未提供 CDP 端点（port ${port}）。` +
      `通常是同一 user-data-dir 已有实例在跑（新进程会把参数交给老实例后退出）。` +
      `本次用的是 ${profileDir}`
    );
  }

  return { browser, proc, port, profileDir, endpoint, args };
}

module.exports = { launch, findBrowser, defaultProfileDir, uniqueProfileDir, rmProfileDir, CANDIDATES };
