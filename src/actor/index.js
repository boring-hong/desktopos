/**
 * Actor Worker — UI 执行层（真实输入注入）
 *
 * 能力：focus / move / click / scroll / type / key
 * 中文输入走剪贴板 + Ctrl+V（SendKeys 不支持 Unicode）
 * 任一动作都可带 verify：前后各截一次屏，返回像素变化率 —— 把「操作→验证」
 * 做成内置能力，而不是让调用方自己拼。
 *
 * verify 支持 region：只比对目标窗口那一块矩形。全屏比对的信号里混着时钟、
 * 光标闪烁、视频等等与本次动作无关的变化，改成区域比对才能把变化归因到动作本身。
 *
 * 安全提示：这些动作会真实移动鼠标、操作前台窗口。
 * 自动化测试只覆盖只读操作与剪贴板往返，真实点击/输入由调用方显式触发。
 */

const path = require('path');
const { HttpWorker } = require('../http-worker/index.js');

const B64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
const UNB64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

class ActorWorker extends HttpWorker {
  constructor(options = {}) {
    super({
      scriptPath: path.join(__dirname, 'actor.ps1'),
      extraArgs: ['-STA'], // clipboard + Win32 input need STA
      cmdTimeout: options.cmdTimeout || 20000,
      startTimeout: options.startTimeout || 30000,
      ...options
    });
  }

  _act(payload, timeout) {
    return this._request('POST', '/act', payload, timeout || this.options.cmdTimeout);
  }

  _norm(r) {
    if (!r.ok) throw new Error(UNB64(r.error) || 'actor error');
    return { action: r.action, note: UNB64(r.note), verify: r.verify || null };
  }

  async getCursor() {
    if (!this._alive) await this.start();
    const r = await this._request('POST', '/cursor', {});
    if (!r.ok) throw new Error(UNB64(r.error) || 'actor error');
    return { x: r.x, y: r.y };
  }

  async focus(handle, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act(
      { action: 'focus', handle: Number(handle), verify: !!opts.verify, settleMs: opts.settleMs },
      opts.timeout));
  }

  async move(x, y, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act({
      action: 'move', x, y,
      verify: !!opts.verify,
      settleMs: opts.settleMs
    }, opts.timeout));
  }

  async click(x, y, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act({
      action: 'click', x, y,
      button: opts.button || 'left',
      count: opts.count || 1,
      verify: !!opts.verify,
      verifyRegion: opts.verifyRegion || null,
      settleMs: opts.settleMs
    }, opts.timeout));
  }

  async scroll(x, y, delta = -120, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act({
      action: 'scroll', x, y, delta,
      verify: !!opts.verify,
      verifyRegion: opts.verifyRegion || null,
      settleMs: opts.settleMs
    }, opts.timeout));
  }

  /** 输入文本（走剪贴板 + Ctrl+V，支持中文） */
  async type(text, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act({
      action: 'type', text: B64(text),
      verify: !!opts.verify,
      verifyRegion: opts.verifyRegion || null,
      settleMs: opts.settleMs
    }, opts.timeout));
  }

  /** 组合键，如 "ctrl+c" / "alt+tab" / "enter" */
  async key(combo, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act({
      action: 'key', keys: B64(combo),
      verify: !!opts.verify,
      verifyRegion: opts.verifyRegion || null,
      settleMs: opts.settleMs
    }, opts.timeout));
  }

  /**
   * 元素级执行：按可见文本定位控件并触发它
   * 优先 InvokePattern，不支持时退回点击其中心
   */
  async element(handle, name, opts = {}) {
    if (!this._alive) await this.start();
    return this._norm(await this._act({
      action: 'element', handle: Number(handle), name: B64(name),
      verify: !!opts.verify,
      verifyRegion: opts.verifyRegion || null,
      settleMs: opts.settleMs
    }, opts.timeout));
  }
}

module.exports = { ActorWorker };
