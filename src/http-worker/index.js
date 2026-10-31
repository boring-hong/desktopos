/**
 * HttpWorker —— 三个 worker（shell / perception / actor）的共享传输层
 *
 * 抽出来的原因：原先三个 index.js 是同一份 HTTP 桥接代码抄了三遍，
 * 于是同一个 bug 也出现了三遍（无鉴权、stop() 会挂住、端口 TOCTOU）。
 * 修一处就该三处都好，所以收成基类。
 *
 * 关键设计：
 *   1. **每个 worker 一个随机 token**：Node 生成，经 argv 传给 PowerShell，
 *      之后每个请求都带 `X-DOS-Token`。自定义请求头会让跨站请求变成非简单请求，
 *      浏览器必须先预检 —— 于是"任意网页 POST 到 127.0.0.1 就能执行命令"这条路被堵死。
 *      （argv 能被本机其他进程读到，但那种攻击者本来就能直接执行代码，不在威胁模型内。）
 *   2. **每层都有自己的超时**：命令超时、请求超时、停止超时，三层独立。
 *      任何一层都不能把上一层永远挂住 —— 这是 stop() 之前会 hang 的根因。
 *   3. **stop() 无条件终止**：先短超时尝试优雅退出，然后无论成败都 kill 并等真实退出。
 *      逃生门不能依赖对端还活着。
 */

const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const EventEmitter = require('events');
const http = require('http');
const net = require('net');

class HttpWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      pwshPath: options.pwshPath || 'powershell.exe',
      scriptPath: options.scriptPath || null,
      extraArgs: options.extraArgs || [],
      spawnCwd: options.spawnCwd || undefined,
      cmdTimeout: options.cmdTimeout || 30000,
      startTimeout: options.startTimeout || 20000,
      requestTimeout: options.requestTimeout || null, // null = cmdTimeout + 5000
      shutdownTimeout: options.shutdownTimeout || 1500,
      startRetries: options.startRetries || 3,
      env: options.env || null,
      ...options
    };
    this._ps = null;
    this._port = null;
    this._token = null;
    this._alive = false;
    this._starting = null;
  }

  // ---------- 传输层 ----------

  _freePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
  }

  get _requestTimeout() {
    return this.options.requestTimeout || this.options.cmdTimeout + 5000;
  }

  /**
   * 发一个请求。自带超时 —— 这一条是「stop() 永远不返回」的根治。
   * @param {string} method
   * @param {string} urlPath
   * @param {object|null} bodyObj
   * @param {number} [timeoutMs]
   */
  _request(method, urlPath, bodyObj, timeoutMs) {
    const ms = timeoutMs || this._requestTimeout;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

      const timer = setTimeout(
        () => done(reject, new Error(`worker request ${urlPath} timed out after ${ms}ms`)),
        ms
      );

      const payload = bodyObj ? JSON.stringify(bodyObj) : null;
      const headers = {};
      if (this._token) headers['X-DOS-Token'] = this._token;
      if (payload) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
      }

      const req = http.request(
        { host: '127.0.0.1', port: this._port, path: urlPath, method, headers },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            try { done(resolve, JSON.parse(buf)); }
            catch (e) {
              done(reject, new Error(`Invalid JSON from worker (${urlPath}): ` + buf.slice(0, 500)));
            }
          });
          res.on('error', (e) => done(reject, e));
        }
      );
      req.on('error', (e) => done(reject, e));
      if (payload) req.write(payload, 'utf8');
      req.end();
    });
  }

  // ---------- 生命周期 ----------

  async start() {
    if (this._alive) return;
    // 并发 start 共用同一次启动，避免 spawn 出多个进程
    if (this._starting) return this._starting;

    this._starting = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < this.options.startRetries; attempt++) {
        try { await this._spawnOnce(); return; }
        catch (e) {
          lastErr = e;
          // 端口可能刚被别的进程抢走，或 C# 编译失败 —— 清掉再换端口试
          await this._killAndWait(this._ps);
          this._ps = null;
          this._port = null;
        }
      }
      throw lastErr || new Error('worker failed to start');
    })();

    try { await this._starting; } finally { this._starting = null; }
  }

  async _spawnOnce() {
    this._port = await this._freePort();
    this._token = randomBytes(32).toString('hex');

    if (!this.options.scriptPath) throw new Error('scriptPath is required');

    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      ...this.options.extraArgs,
      '-ExecutionPolicy', 'Bypass',
      '-File', this.options.scriptPath,
      '-Port', String(this._port),
      '-Token', this._token
    ];

    const ps = spawn(this.options.pwshPath, args, {
      cwd: this.options.spawnCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.options.env || { ...process.env }
    });
    this._ps = ps;

    let boot = '';
    ps.stdout.on('data', (d) => { boot += d.toString('utf8'); });
    ps.stderr.on('data', (d) => { boot += '[stderr] ' + d.toString('utf8'); });
    ps.on('error', (e) => this.emit('error', e));
    ps.on('close', (code) => {
      const was = this._alive;
      this._alive = false;
      if (was) this.emit('close', code);
    });

    const deadline = Date.now() + this.options.startTimeout;
    while (!boot.includes('READY:')) {
      if (ps.exitCode !== null) {
        throw new Error(`worker exited (${ps.exitCode}) during start. Boot output:\n` + boot);
      }
      if (Date.now() > deadline) {
        throw new Error('worker start timeout. Boot output:\n' + boot);
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    this._alive = true;
    this.emit('ready');
  }

  /** kill 并把真实退出等出来（最多 ms 毫秒） */
  async _killAndWait(ps, ms = 3000) {
    if (!ps) return;
    if (ps.exitCode === null && !ps.killed) {
      try { ps.kill(); } catch {}
    }
    if (ps.exitCode !== null) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      ps.once('close', () => { clearTimeout(t); resolve(); });
    });
  }

  /**
   * 停止。**保证在有限时间内返回**，不依赖对端是否还活着。
   * 旧实现先 await 一个没有超时的 /shutdown，命令卡住时这里会永远 hang，
   * 于是 _alive 永不清零、restart 变成假重启、shell_reset 一起挂死。
   */
  async stop() {
    const ps = this._ps;
    const wasAlive = this._alive;
    this._alive = false; // 先置位：并发调用会看到已停，不会重入
    if (!ps) { this._ps = null; return; }

    // 1) 尽力优雅退出；对端卡住也无所谓，超时就往下走
    if (wasAlive) {
      try { await this._request('POST', '/shutdown', null, this.options.shutdownTimeout); } catch {}
    }
    // 2) 无条件终止并等待真实退出
    await this._killAndWait(ps);
    this._ps = null;
  }

  get alive() { return this._alive; }
  get port() { return this._port; }
}

module.exports = { HttpWorker };
