/**
 * CDP 端点发现
 *
 * 浏览器开着调试端口时，会在 127.0.0.1:<port> 上提供一个 HTTP 端点：
 *   GET /json/version  -> { Browser, Protocol-Version, webSocketDebuggerUrl }
 *   GET /json/list     -> [{ id, type, title, url, webSocketDebuggerUrl }]
 *
 * 这一层只做只读探测，不启动、不修改任何浏览器。
 */

const http = require('http');

const DEFAULT_PORTS = [
  9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229,
  9230, 9231, 9232, 9233, 9234, 9235,
];

function getJson(port, path, timeout = 400) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** 探测单个端口是不是 CDP 端点。是则返回 { port, browser, version, wsUrl }，否则 null。 */
async function probe(port) {
  const v = await getJson(port, '/json/version');
  if (!v || !v.webSocketDebuggerUrl) return null;
  return {
    port,
    browser: v.Browser || '',
    version: v['Protocol-Version'] || '',
    userAgent: v['User-Agent'] || '',
    wsUrl: v.webSocketDebuggerUrl,
  };
}

/** 并发扫描端口段，返回所有活着的 CDP 端点。 */
async function discover(ports = DEFAULT_PORTS) {
  const results = await Promise.all(ports.map((p) => probe(p)));
  return results.filter(Boolean);
}

/** 列出某个端点上的可调试目标（页面 / iframe / service worker 等）。 */
async function listTargets(port) {
  const list = await getJson(port, '/json/list', 800);
  if (!Array.isArray(list)) return [];
  return list.map((t) => ({
    id: t.id,
    type: t.type || '',
    title: t.title || '',
    url: t.url || '',
    wsUrl: t.webSocketDebuggerUrl || '',
  }));
}

/** 只看页面级目标 —— 这才是"能操作的一个标签页"。 */
async function listPages(port) {
  return (await listTargets(port)).filter((t) => t.type === 'page');
}

module.exports = { discover, probe, listTargets, listPages, getJson, DEFAULT_PORTS };
