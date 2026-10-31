/**
 * CDP 高层封装
 *
 * 为什么需要这一层：UIA 看不见 Chromium 渲染树内部（Electron 实测枚举 0 个控件）。
 * CDP 直接问浏览器"你页面上有什么"，拿到的是真实 DOM + 无障碍树。
 *
 * 能力对齐 UIA，好让上层工具语义一致：
 *   elements()  ~ desktop_elements
 *   click()     ~ desktop_click_element
 *   type()      ~ desktop_type（但走 Input.insertText，中文天然无损）
 */

const Cdp = require('./client');
const { discover, probe, listPages } = require('./discover');

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox',
  'tab', 'combobox', 'listbox', 'option', 'searchbox', 'slider', 'spinbutton',
  'switch', 'treeitem', 'img', 'heading',
]);

// AX 树会给一个按钮同时产出 button / StaticText / InlineTextBox 三个同名节点。
// 它们不是三个控件，是同一个控件的三种投影 —— 必须去重，否则"点搜索"会被判成歧义。
const TEXT_ROLES = new Set(['StaticText', 'InlineTextBox', 'LineBreak']);

class Browser {
  constructor(cdp, port, endpoint) {
    this.cdp = cdp;
    this.port = port;
    this.endpoint = endpoint;
  }

  /** 连到浏览器的 browser 级端点。不给 port 就自动扫描。 */
  static async attach({ port } = {}) {
    let ep = null;
    if (port) {
      ep = await probe(port);
      if (!ep) throw new Error(`端口 ${port} 上没有 CDP 端点。浏览器需要带 --remote-debugging-port 启动。`);
    } else {
      const found = await discover();
      if (!found.length) {
        throw new Error('没有发现任何 CDP 端点。本机浏览器都没开调试端口 —— 请先启动一个带 --remote-debugging-port 的实例。');
      }
      ep = found[0];
    }
    const cdp = await Cdp.connect(ep.wsUrl);
    return new Browser(cdp, ep.port, ep);
  }

  async targets({ type = 'page' } = {}) {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    const list = (targetInfos || [])
      .filter((t) => !type || t.type === type)
      .map((t) => ({ id: t.targetId, type: t.type, title: t.title || '', url: t.url || '' }));
    return list;
  }

  /**
   * 打开一个页面会话。可按 targetId / title / url 子串 / 顺序下标定位。
   */
  async open({ targetId, title, url, index = 0 } = {}) {
    const all = await this.targets({ type: 'page' });
    if (!all.length) throw new Error('该浏览器里没有可调试的页面');

    let target = null;
    if (targetId) {
      target = all.find((t) => t.id === targetId) || null;
      if (!target) throw new Error('找不到 targetId=' + targetId + '（可能页面已关闭）');
    } else if (title) {
      const q = String(title).toLowerCase();
      target = all.find((t) => t.title.toLowerCase().includes(q)) || null;
      if (!target) throw new Error(`没有标题包含 "${title}" 的页面。当前页面：\n` + all.map((t) => '  - ' + t.title).join('\n'));
    } else if (url) {
      const q = String(url).toLowerCase();
      target = all.find((t) => t.url.toLowerCase().includes(q)) || null;
      if (!target) throw new Error(`没有 URL 包含 "${url}" 的页面。当前页面：\n` + all.map((t) => '  - ' + t.url).join('\n'));
    } else {
      target = all[Math.min(index, all.length - 1)];
    }

    const { sessionId } = await this.cdp.send('Target.attachToTarget', {
      targetId: target.id,
      flatten: true,
    });
    const s = new Session(this.cdp, sessionId, target);
    await s.enable();
    return s;
  }

  close() {
    this.cdp.close();
  }
}

class Session {
  constructor(cdp, sessionId, info) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.info = info;
  }

  _send(method, params, opts) {
    return this.cdp.send(method, params, { ...(opts || {}), sessionId: this.sessionId });
  }

  async enable() {
    for (const d of ['Page', 'Runtime', 'DOM', 'Accessibility']) {
      try { await this._send(d + '.enable'); } catch { /* 某些域在个别版本不可用，忽略 */ }
    }
  }

  /** 在页面里执行 JS。默认 returnByValue，返回 JSON 化结果。 */
  async eval(expression, { awaitPromise = false, returnByValue = true, timeout } = {}) {
    const r = await this._send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }, { timeout });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      throw new Error('页面内 JS 报错: ' + ((ex.exception && ex.exception.description) || ex.text));
    }
    if (returnByValue && r.result) {
      if (r.result.type === 'undefined') return undefined;
      return r.result.value;
    }
    return r.result;
  }

  /** 原始无障碍树 */
  async axRaw() {
    const { nodes } = await this._send('Accessibility.getFullAXTree', {}, { timeout: 20000 });
    return nodes || [];
  }

  /**
   * 归一化控件列表。默认只留"有意思"的：有名字的，或交互式角色。
   * limit 默认 120 —— 完整 AX 树动辄上千节点，全塞进上下文会淹死模型。
   */
  async elements({ limit = 120, interestingOnly = true, role, dedupe = true } = {}) {
    const raw = await this.axRaw();

    const byId = new Map();
    raw.forEach((n) => byId.set(n.nodeId, n));

    // 从根节点 BFS 求深度（getFullAXTree 不直接给深度）
    const depth = new Map();
    const root = raw.find((n) => n.role && n.role.value === 'RootWebArea') || raw[0];
    if (root) {
      const queue = [[root.nodeId, 0]];
      while (queue.length) {
        const [id, d] = queue.shift();
        if (depth.has(id)) continue;
        depth.set(id, d);
        for (const c of (byId.get(id) && byId.get(id).childIds) || []) queue.push([c, d + 1]);
      }
    }

    let out = raw.map((n) => ({
      id: n.nodeId,
      role: (n.role && n.role.value) || '',
      name: (n.name && n.name.value) || '',
      value: (((n.properties || []).find((p) => p.name === 'value') || {}).value || {}).value || '',
      backendNodeId: n.backendDOMNodeId || null,
      ignored: !!n.ignored,
      depth: depth.get(n.nodeId) ?? -1,
    }));

    if (interestingOnly) {
      out = out.filter((e) => !e.ignored && (e.name || INTERACTIVE_ROLES.has(e.role)));
    }
    if (dedupe) {
      const named = new Set(out.filter((e) => INTERACTIVE_ROLES.has(e.role)).map((e) => e.name));
      out = out.filter((e) => !(TEXT_ROLES.has(e.role) && named.has(e.name)));
    }
    if (role) {
      const q = String(role).toLowerCase();
      out = out.filter((e) => e.role.toLowerCase() === q);
    }
    if (limit && out.length > limit) out = out.slice(0, limit);
    return out;
  }

  /** 按名称/角色找控件。找不到时把候选列出来，方便下一轮调用。 */
  async find(query, { role } = {}) {
    const list = await this.elements({ interestingOnly: true, role });
    if (!query) return list[0] || null;
    const q = String(query).toLowerCase();
    const hit = list.filter((e) => e.name.toLowerCase().includes(q));
    if (hit.length === 1) return hit[0];

    if (hit.length > 1) {
      // 同名投影优先取"能操作"的那个：交互式角色 + 层级更浅的赢。
      const score = (e) => (INTERACTIVE_ROLES.has(e.role) ? 0 : 100) + (e.depth < 0 ? 50 : e.depth);
      const best = Math.min(...hit.map(score));
      const tied = hit.filter((e) => score(e) === best);
      if (tied.length === 1) return tied[0];

      const err = new Error(`"${query}" 匹配到 ${tied.length} 个同级控件，请用更精确的名称或限定 role：\n` +
        tied.slice(0, 10).map((e) => `  - [${e.role}] ${e.name}`).join('\n'));
      err.ambiguous = tied;
      throw err;
    }
    const err = new Error(`页面上找不到名称包含 "${query}" 的控件` +
      (role ? `（角色限定 ${role}）` : '') + `。候选（前 15 个）：\n` +
      list.slice(0, 15).map((e) => `  - [${e.role}] ${e.name}`).join('\n'));
    err.candidates = list.slice(0, 15);
    throw err;
  }

  /** 取控件矩形中心（用 DOM.getBoxModel，坐标系是页面视口） */
  async boxOf(node) {
    if (!node || !node.backendNodeId) {
      throw new Error('该控件没有 backendNodeId，无法定位矩形（可能是纯文本节点，请点它的父容器）');
    }
    const { model } = await this._send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    const q = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    return { x, y, width: model.width, height: model.height };
  }

  /** 点一个控件（先按名字找，再算中心，最后注入真实鼠标事件） */
  async click(query, { role, settleMs = 250 } = {}) {
    const node = await this.find(query, { role });
    const box = await this.boxOf(node);
    const x = Math.round(box.x), y = Math.round(box.y);

    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this._send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });

    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    return { name: node.name, role: node.role, x, y, box };
  }

  /** 输入文本。Input.insertText 直接写入，中文/emoji 都不经过键盘布局，天然无损。 */
  async type(text, { target, clear = false } = {}) {
    if (target) {
      const node = await this.find(target);
      if (node.backendNodeId) {
        await this._send('DOM.focus', { backendNodeId: node.backendNodeId });
      }
      if (clear) {
        await this.eval(`(() => {
          const el = document.activeElement;
          if (el && (el.value !== undefined)) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); }
        })()`);
      }
    }
    await this._send('Input.insertText', { text });
    return { text, target: target || '(当前焦点)' };
  }

  async screenshot({ format = 'png', quality } = {}) {
    const params = { format, fromSurface: true, captureBeyondViewport: false };
    if (format === 'jpeg' && quality) params.quality = quality;
    const { data } = await this._send('Page.captureScreenshot', params, { timeout: 20000 });
    return { base64: data, mime: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
  }

  /** 等页面 readyState 到 complete。导航后不硬等固定毫秒 —— 那样慢页面会假成功。 */
  async waitReady(timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const st = await this.eval('document.readyState').catch(() => 'complete');
      if (st === 'complete' || st === 'interactive') return st;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'timeout';
  }

  async navigate(url) {
    const r = await this._send('Page.navigate', { url }, { timeout: 20000 });
    const state = await this.waitReady().catch(() => 'timeout');
    return { url, loaderId: r.loaderId, readyState: state };
  }

  async reload() {
    await this._send('Page.reload', { ignoreCache: false });
    await new Promise((res) => setTimeout(res, 600));
    return true;
  }

  /** 页面标题 / URL，最轻量的一次"我现在在哪" */
  async where() {
    const [title, url] = await Promise.all([
      this.eval('document.title').catch(() => ''),
      this.eval('location.href').catch(() => ''),
    ]);
    return { title, url };
  }

  async close() {
    try { await this._send('Target.detachFromTarget', { sessionId: this.sessionId }); } catch { /* 可能已随页面关闭 */ }
  }
}

/** 列出"现在能连什么" —— 只读，无副作用，给 MCP 的 desktop_cdp_targets 用。 */
async function survey() {
  const endpoints = await discover();
  const out = [];
  for (const ep of endpoints) {
    const pages = await listPages(ep.port);
    out.push({ port: ep.port, browser: ep.browser, pages });
  }
  return out;
}

module.exports = { Browser, Session, survey };
