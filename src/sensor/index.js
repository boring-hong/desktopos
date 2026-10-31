/**
 * Perception Worker — 双通道感知（结构通道 + 视觉通道 + 交叉验证）
 *
 * 结构通道：Win32 P/Invoke 枚举窗口（句柄 / 标题 / 进程 / 矩形 / 是否聚焦）
 * 视觉通道：全屏截屏，按窗口矩形采样像素算标准差
 * 交叉验证：结构说"可见"的窗口，视觉上必须真的在屏幕内、且真有内容渲染
 *
 * 传输层见 ../http-worker：本地 HTTP + base64 + 每进程 token，
 * 因此中文窗口标题不会像 stdin 管道那样被 CP936 打坏。
 */

const path = require('path');
const { HttpWorker } = require('../http-worker/index.js');

const UNB64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

class PerceptionWorker extends HttpWorker {
  constructor(options = {}) {
    super({
      scriptPath: path.join(__dirname, 'perception.ps1'),
      extraArgs: ['-STA'], // 屏幕捕获 / Win32 调用需要 STA 单元模式
      cmdTimeout: options.cmdTimeout || 30000,
      startTimeout: options.startTimeout || 30000, // 首次要编译 C#，给足时间
      ...options
    });
  }

  _call(urlPath, body, timeout) {
    return this._request('POST', urlPath, body, timeout || this.options.cmdTimeout);
  }

  /** 结构通道：枚举窗口 */
  async listWindows(opts = {}) {
    if (!this._alive) await this.start();
    const r = await this._call('/windows', {}, opts.timeout);
    if (!r.ok) throw new Error(UNB64(r.error) || 'perception error');
    return {
      screen: r.screen,
      windows: (r.windows || []).map((w) => ({
        handle: w.handle,
        title: UNB64(w.title),
        pid: w.pid,
        process: UNB64(w.process),
        rect: { x: w.x, y: w.y, w: w.w, h: w.h },
        visible: !!w.visible,
        focused: !!w.focused,
        minimized: !!w.minimized
      }))
    };
  }

  /** 视觉通道：截屏 */
  async screenshot(opts = {}) {
    if (!this._alive) await this.start();
    const r = await this._call('/screenshot', {
      includePng: opts.includePng !== false,
      maxWidth: opts.maxWidth || 0,
      format: opts.format || 'png'
    }, opts.timeout);
    if (!r.ok) throw new Error(UNB64(r.error) || 'perception error');
    return { width: r.width, height: r.height, pngBase64: r.png || '' };
  }

  /** 双通道 + 交叉验证 */
  async perceive(opts = {}) {
    if (!this._alive) await this.start();
    const r = await this._call('/perceive', {
      includePng: !!opts.includePng,
      maxWidth: opts.maxWidth || 0,
      format: opts.format || 'png'
    }, opts.timeout);
    if (!r.ok) throw new Error(UNB64(r.error) || 'perception error');
    return {
      screen: r.screen,
      windows: (r.windows || []).map((w) => ({
        handle: w.handle,
        title: UNB64(w.title),
        pid: w.pid,
        process: UNB64(w.process),
        rect: { x: w.x, y: w.y, w: w.w, h: w.h },
        visible: !!w.visible,
        focused: !!w.focused,
        minimized: !!w.minimized,
        hash: w.hash || null,
        stdDev: w.stdDev,
        hasContent: !!w.hasContent,
        inBounds: !!w.inBounds,
        consistent: !!w.consistent
      })),
      crossValidation: r.crossValidation,
      pngBase64: r.png || ''
    };
  }

  /**
   * 元素级结构通道：枚举窗口内的 UI 控件（UI Automation）
   * @param {number} handle 窗口句柄
   */
  async elements(handle, opts = {}) {
    if (!this._alive) await this.start();
    const r = await this._call('/elements', {
      handle: Number(handle),
      maxElements: opts.maxElements || 300
    }, opts.timeout);
    if (!r.ok) throw new Error(UNB64(r.error) || 'perception error');
    return {
      handle: r.handle,
      count: r.count,
      elements: (r.elements || []).map((e) => ({
        name: UNB64(e.name),
        type: UNB64(e.type),
        autoId: UNB64(e.autoId),
        className: UNB64(e.class),
        rect: { x: e.x, y: e.y, w: e.w, h: e.h },
        enabled: !!e.enabled,
        offscreen: !!e.offscreen,
        canInvoke: !!e.canInvoke
      }))
    };
  }
}

module.exports = { PerceptionWorker };
