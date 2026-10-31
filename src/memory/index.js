/**
 * Memory Layer — 桌面记忆层
 *
 * 解决 AI 操作电脑最痛的一点：不记得之前做过什么、看过什么。
 * 有了它，"点击刚才那个按钮" 这类指代才成立。
 *
 * 三块内容：
 *   1. 操作日志（时间线）  —— 每次 perceive / act / shell 都记一条
 *   2. 特征索引            —— 窗口的 8x8 感知哈希（截图 -> 向量），可按相似度再认出来
 *   3. 上下文管理器        —— 聚焦窗口历史 / 导航栈
 *
 * 持久化在 ~/.desktopos/memory.json，跨进程、跨重启保留。
 *
 * 当前粒度：窗口级。元素级（真正的"那个按钮"）需要接 UI Automation，
 * 见 README 的后续规划 —— 这里先把闭环和索引打通。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DIR = path.join(os.homedir(), '.desktopos');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'memory.json');

const MAX_TIMELINE = 500;
const MAX_WINDOWS = 300;
const MAX_ELEMENTS = 600;
const MAX_INTERACTIONS = 50;

// 指代性词语：命中则按"最近"优先
const TEMPORAL = /(刚才|刚刚|上一个|上一个|上次|最近|之前|前一个|last|previous|just\s*now|recent)/i;

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16);
    const y = parseInt(b[i], 16);
    let z = x ^ y;
    while (z) { d += z & 1; z >>= 1; }
  }
  return d;
}

class MemoryLayer {
  constructor(options = {}) {
    this.file = options.file || DEFAULT_FILE;
    this.data = { timeline: [], windows: [], elements: [], interactions: [], focusStack: [], meta: {} };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = {
          timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
          windows: Array.isArray(parsed.windows) ? parsed.windows : [],
          elements: Array.isArray(parsed.elements) ? parsed.elements : [],
          interactions: Array.isArray(parsed.interactions) ? parsed.interactions : [],
          focusStack: Array.isArray(parsed.focusStack) ? parsed.focusStack : [],
          meta: parsed.meta || {}
        };
      }
    } catch {
      // 损坏就重来，不让它拖垮调用方
      this.data = { timeline: [], windows: [], focusStack: [], meta: {} };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 记一条操作 */
  record(type, summary, data = {}) {
    const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ts: Date.now(), type, summary, data };
    this.data.timeline.unshift(entry);
    if (this.data.timeline.length > MAX_TIMELINE) this.data.timeline.length = MAX_TIMELINE;
    this._save();
    return entry;
  }

  /**
   * 把一次 perceive 的结果纳入特征索引与上下文
   * @param {Array} windows perceive() 返回的窗口数组
   */
  indexWindows(windows = []) {
    const now = Date.now();
    for (const w of windows) {
      if (!w || !w.title && !w.process) continue;
      const snap = {
        ts: now,
        handle: w.handle,
        title: w.title || '',
        process: w.process || '',
        pid: w.pid,
        rect: w.rect,
        hash: w.hash || null,
        focused: !!w.focused,
        minimized: !!w.minimized
      };
      // 同一 handle 只保留最新一条
      const i = this.data.windows.findIndex((x) => x.handle === snap.handle);
      if (i >= 0) this.data.windows.splice(i, 1);
      this.data.windows.unshift(snap);

      if (w.focused) {
        this.data.focusStack.unshift({ ts: now, handle: w.handle, title: w.title, process: w.process });
        if (this.data.focusStack.length > 30) this.data.focusStack.length = 30;
      }
    }
    if (this.data.windows.length > MAX_WINDOWS) this.data.windows.length = MAX_WINDOWS;
    this.data.meta.lastIndexAt = now;
    this._save();
    return this.data.windows.length;
  }

  /**
   * 把一次 UI 元素枚举结果纳入索引（元素级记忆）
   * @param {object} windowInfo 所属窗口 {handle,title,process}
   * @param {Array} elements elements() 返回的控件数组
   */
  indexElements(windowInfo = {}, elements = []) {
    if (!Array.isArray(elements) || !elements.length) return 0;
    const now = Date.now();
    for (const e of elements) {
      if (!e || !e.name) continue;
      this.data.elements.unshift({
        ts: now,
        name: e.name,
        type: e.type || '',
        autoId: e.autoId || '',
        className: e.className || '',
        rect: e.rect,
        canInvoke: !!e.canInvoke,
        enabled: !!e.enabled,
        windowHandle: windowInfo.handle,
        windowTitle: windowInfo.title || '',
        process: windowInfo.process || ''
      });
    }
    if (this.data.elements.length > MAX_ELEMENTS) this.data.elements.length = MAX_ELEMENTS;
    this._save();
    return elements.length;
  }

  /** 记录一次真实交互过的元素 —— "刚才那个按钮" 的依据 */
  recordInteraction(element, action = 'click') {
    if (!element) return null;
    const entry = {
      ts: Date.now(),
      name: element.name || '',
      type: element.type || '',
      rect: element.rect || null,
      windowHandle: element.windowHandle,
      process: element.process || '',
      action
    };
    this.data.interactions.unshift(entry);
    if (this.data.interactions.length > MAX_INTERACTIONS) this.data.interactions.length = MAX_INTERACTIONS;
    this._save();
    return entry;
  }

  /** 最近交互过的元素 */
  lastInteraction() {
    return this.data.interactions[0] || null;
  }

  timeline(limit = 20) {
    return this.data.timeline.slice(0, limit).map((e) => ({
      id: e.id,
      time: new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }),
      type: e.type,
      summary: e.summary
    }));
  }

  /** 当前/最近聚焦的窗口 */
  currentFocus() {
    return this.data.focusStack[0] || null;
  }

  _elementResult(e, reason, hits = []) {
    const r = e.rect || { x: 0, y: 0, w: 0, h: 0 };
    return {
      found: true,
      level: 'element',
      name: e.name,
      type: e.type || '',
      windowHandle: e.windowHandle,
      process: e.process || '',
      rect: r,
      x: Math.round(r.x + r.w / 2),
      y: Math.round(r.y + r.h / 2),
      canInvoke: !!e.canInvoke,
      reason,
      candidates: hits.slice(0, 5).map((h) => ({ name: h.name, type: h.type, ts: h.ts }))
    };
  }

  /**
   * 解析一句指代，定位到可点击的目标
   * 会区分意图：说"窗口"就走窗口级，说"按钮"就走元素级，
   * 两者都没说时先试元素（更精确）再退回窗口。
   */
  resolve(query = '') {
    const q = String(query).trim();
    if (!q) return { found: false, reason: '查询为空' };

    const temporal = TEMPORAL.test(q);
    const wantWindow = /窗口|应用|程序|页面|软件|软件窗口/.test(q);
    const wantElement = /按钮|控件|菜单|输入框|复选框|单选|链接|标签页|选项|工具栏/.test(q);

    const key = q
      .replace(TEMPORAL, '')
      .replace(/(那个|这个|的|按钮|控件|窗口|应用|程序|页面|软件|菜单|输入框)/g, '')
      .trim();
    const k = key.toLowerCase();

    // --- 元素级 ---
    if (!wantWindow) {
      // 纯指代 + 元素意图 -> 最近交互过的那个
      if (temporal && !k && this.data.interactions.length) {
        return this._elementResult(this.data.interactions[0], '按"最近交互过"定位', this.data.interactions.slice(0, 3));
      }
      if (k) {
        const hits = this.data.elements.filter(
          (e) => e.name.toLowerCase().includes(k) || (e.autoId || '').toLowerCase().includes(k)
        );
        if (hits.length) {
          // 可 Invoke 的（按钮类）优先，其次最近
          hits.sort((a, b) => (b.canInvoke ? 1 : 0) - (a.canInvoke ? 1 : 0) || b.ts - a.ts);
          return this._elementResult(hits[0], `按控件名 "${key}" 定位`, hits);
        }
        if (wantElement) {
          return {
            found: false,
            reason: `没有名称包含 "${key}" 的控件`,
            hint: '先对该窗口调用 desktop_elements 建立元素索引'
          };
        }
      }
    }

    // --- 窗口级（原有逻辑）---
    let pool = this.data.windows.filter((w) => !w.minimized);

    let candidates;
    if (key) {
      const k = key.toLowerCase();
      candidates = pool.filter(
        (w) => w.title.toLowerCase().includes(k) || w.process.toLowerCase().includes(k)
      );
      if (!candidates.length) {
        // 区分「真没有」和「有但最小化了」——后者对调用方是可行动的信息，
        // 说成"不存在"会把 Agent 带偏。
        const k2 = k;
        const hidden = this.data.windows.filter(
          (w) => w.title.toLowerCase().includes(k2) || w.process.toLowerCase().includes(k2)
        );
        if (hidden.length) {
          return {
            found: false,
            reason: `"${key}" 在记忆里存在，但当前处于最小化状态，无法直接点击`,
            hint: `先用 desktop_focus_window 还原它，句柄 ${hidden[0].handle}`,
            handle: hidden[0].handle
          };
        }
        return {
          found: false,
          reason: `没有标题或进程包含 "${key}" 的窗口`,
          hint: '先调用 desktop_perceive 建立索引'
        };
      }
    } else if (temporal) {
      // 纯指代：取最近聚焦过的
      const fh = this.data.focusStack[0];
      candidates = fh ? pool.filter((w) => w.handle === fh.handle) : pool.slice(0, 1);
      if (!candidates.length) candidates = pool.slice(0, 1);
    } else {
      candidates = pool.slice(0, 1);
    }

    if (!candidates.length) {
      return { found: false, reason: '记忆里还没有窗口，先调用 desktop_perceive' };
    }

    // 有关键词时优先最近聚焦；否则按索引时间（越新越前）
    candidates.sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || b.ts - a.ts);
    const best = candidates[0];
    const cx = Math.round(best.rect.x + best.rect.w / 2);
    const cy = Math.round(best.rect.y + best.rect.h / 2);

    return {
      found: true,
      level: 'window',
      handle: best.handle,
      title: best.title,
      process: best.process,
      rect: best.rect,
      x: cx,
      y: cy,
      hash: best.hash,
      reason: temporal ? '按"最近"定位' : `按关键词 "${key}" 定位`,
      candidates: candidates.slice(0, 5).map((c) => ({ title: c.title, process: c.process, ts: c.ts }))
    };
  }

  /**
   * 按感知哈希找最像的窗口（用于"还是刚才那个画面吗"这类判断）。
   *
   * 哈希只是个**弱辅助信号**，不能单独当做身份。之前的 8x8 aHash 在真实桌面上
   * 会把完全无关的两个窗口算出同一个值（d=0，实测文件资源管理器和某个网页撞），
   * 而下一步往往就是照着它给的坐标去点 —— 指错了就是误操作。
   * 现在：
   *    1. 换成 dHash（perception.ps1），方向信息不再被丢掉；
   *    2. 默认阈值收紧到 6；
   *    3. 支持传 expect { title, process } 做交叉校验 —— 强烈建议传，
   *       只有标题/进程也对得上才算同一个目标。
   *
   * @param {string} hash
   * @param {number|{maxDistance?:number, expect?:{title?:string, process?:string}}} opts
   */
  findByHash(hash, opts = {}) {
    if (!hash) return null;
    const maxDistance = typeof opts === 'number'
      ? opts
      : (opts.maxDistance == null ? 6 : opts.maxDistance);
    const expect = (typeof opts === 'object' && opts.expect) || null;
    const wantTitle = expect && expect.title ? String(expect.title).toLowerCase() : null;
    const wantProc = expect && expect.process ? String(expect.process).toLowerCase() : null;

    let best = null, bestD = 999;
    for (const w of this.data.windows) {
      if (!w.hash) continue;
      // 有交叉校验条件时，标题/进程对不上的直接排除 —— 只看哈希太容易撞
      if (wantTitle && !String(w.title || '').toLowerCase().includes(wantTitle)) continue;
      if (wantProc && String(w.process || '').toLowerCase() !== wantProc) continue;
      const d = hammingHex(hash, w.hash);
      if (d < bestD) { bestD = d; best = w; }
    }
    return best && bestD <= maxDistance
      ? { window: best, distance: bestD, corroborated: !!(wantTitle || wantProc) }
      : null;
  }

  stats() {
    return {
      timeline: this.data.timeline.length,
      windows: this.data.windows.length,
      elements: this.data.elements.length,
      interactions: this.data.interactions.length,
      focusStack: this.data.focusStack.length,
      lastIndexAt: this.data.meta.lastIndexAt
        ? new Date(this.data.meta.lastIndexAt).toLocaleString('zh-CN', { hour12: false })
        : null,
      file: this.file
    };
  }

  clear() {
    this.data = { timeline: [], windows: [], elements: [], interactions: [], focusStack: [], meta: {} };
    this._save();
  }
}

module.exports = { MemoryLayer, hammingHex };
