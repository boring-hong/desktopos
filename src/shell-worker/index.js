/**
 * Shell Worker — 持久化 PowerShell 会话
 *
 * 传输层见 ../http-worker：本地 HTTP + base64 + 每进程 token。
 *
 * 为什么不是 stdin 管道 + marker（原始实现，已废弃）：
 *   1. powershell.exe 用 [Console]::InputEncoding (CP936) 解码管道 stdin，
 *      Node 写入的 UTF-8 中文必然变乱码 —— 中文路径/命令直接失效。
 *   2. stdout / stderr 交错，marker 会被命令输出淹没或被残留 buffer 误判。
 *   3. 终止性错误会让 PowerShell 直接 exit(1)，后续 marker 永远等不到。
 *
 * 本层额外负责一件事：**卡死后的自动恢复**。
 * PS 5.1 的 runspace 是单线程的，一条卡住的命令（等输入的交互程序、忘了 -y 的
 * npm install）会让 GetContext() 永远回不去，之后所有请求全部超时。
 * 所以命令超时后会直接重启 worker，并把已知的 cwd 与环境变量重放回去 ——
 * 会话自己站起来，而不是要求调用方重启整个 MCP 客户端。
 */

const path = require('path');
const { HttpWorker } = require('../http-worker/index.js');

const B64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
const UNB64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

class ShellWorker extends HttpWorker {
  constructor(options = {}) {
    super({
      scriptPath: path.join(__dirname, 'worker.ps1'),
      spawnCwd: options.initialCwd || process.cwd(),
      cmdTimeout: options.cmdTimeout || 30000,
      startTimeout: options.startTimeout || 20000,
      ...options
    });

    this._lastCwd = null;      // 最后一次成功返回的工作目录
    this._envVars = new Map(); // 通过 setEnv 写过的变量，重启后重放
    this._resetting = false;
  }

  /** 保留旧字段名，便于调用方按 initialCwd 读 */
  get initialCwd() { return this.options.spawnCwd || process.cwd(); }

  /**
   * 硬重启：杀掉卡住的进程、重新拉起、把 cwd 与环境变量放回去。
   * 这是「命令卡死 → 会话永久失效」的解法。
   */
  async _hardReset() {
    if (this._resetting) return;
    this._resetting = true;
    try {
      const ps = this._ps;
      this._alive = false;
      await this._killAndWait(ps, 2000);
      this._ps = null;
      await this.start();

      if (this._lastCwd) {
        try { await this.execFull(setLocCmd(this._lastCwd), { timeout: 10000, autoReset: false }); } catch {}
      }
      for (const [name, value] of this._envVars) {
        try { await this.execFull(setEnvCmd(name, value), { timeout: 10000, autoReset: false }); } catch {}
      }
    } finally {
      this._resetting = false;
    }
  }

  /** 结构化执行：返回 { output, error, cwd, exitCode } */
  async execFull(command, options = {}) {
    if (!this._alive) await this.start();
    const timeout = options.timeout || this.options.cmdTimeout;
    const autoReset = options.autoReset !== false && !this._resetting;

    let res;
    try {
      res = await this._request('POST', '/exec', { command: B64(command) }, timeout);
    } catch (e) {
      const timedOut = /timed out/i.test(e.message);
      if (timedOut && autoReset) {
        await this._hardReset().catch(() => {});
        throw new Error(
          `Command timed out after ${timeout}ms. The worker was wedged, so the session ` +
          `was restarted and its cwd/env replayed. Re-issue the command only if it is ` +
          `safe to run again.`
        );
      }
      throw e;
    }

    if (!res.ok) throw new Error(UNB64(res.error) || 'worker returned an error');

    const cwd = UNB64(res.cwd);
    if (cwd) this._lastCwd = cwd;

    return {
      output: UNB64(res.output),
      error: UNB64(res.error),
      cwd,
      exitCode: res.exitCode || 0
    };
  }

  /** 兼容旧契约：返回字符串（stdout + 错误信息） */
  async exec(command, options = {}) {
    const r = await this.execFull(command, options);
    let text = r.output;
    if (r.error) text += (text ? '\n' : '') + r.error;
    return text;
  }

  async getCwd() {
    const r = await this.execFull('(Get-Location).Path', { autoReset: false });
    return r.output.trim();
  }

  /**
   * 切目录。路径以 base64 传输，到 PS 里再解码 ——
   * 因此不存在引号转义、反斜杠转义或编码损坏问题，中文路径可用。
   */
  async cd(dir) {
    const r = await this.execFull(setLocCmd(dir), { autoReset: false });
    if (r.error) throw new Error(r.error);
    this._lastCwd = r.cwd || dir;
    return this.getCwd();
  }

  async setEnv(name, value) {
    this._envVars.set(String(name), String(value));
    const r = await this.execFull(setEnvCmd(name, value), { autoReset: false });
    if (r.error) throw new Error(r.error);
  }

  async getEnv(name) {
    const r = await this.execFull(getEnvCmd(name), { autoReset: false });
    return r.output.trim();
  }
}

function setLocCmd(dir) {
  return `$p = [System.Text.Encoding]::UTF8.GetString(` +
         `[System.Convert]::FromBase64String('${B64(dir)}')); ` +
         `Set-Location -LiteralPath $p`;
}

function setEnvCmd(name, value) {
  return `$n = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${B64(name)}')); ` +
         `$v = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${B64(value)}')); ` +
         `[Environment]::SetEnvironmentVariable($n, $v, 'Process')`;
}

function getEnvCmd(name) {
  return `$n = [System.Text.Encoding]::UTF8.GetString(` +
         `[System.Convert]::FromBase64String('${B64(name)}')); ` +
         `[Environment]::GetEnvironmentVariable($n, 'Process')`;
}

module.exports = { ShellWorker };
