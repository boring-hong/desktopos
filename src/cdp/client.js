/**
 * 极简 CDP（Chrome DevTools Protocol）客户端
 *
 * Node 22 起 WebSocket 已是全局对象，所以这里零依赖。
 * 只实现本项目真正需要的部分：发命令收响应、收事件、多 session 复用同一条连接。
 */

let seq = 0;

class Cdp {
  /** 连接一个 ws:// 端点（浏览器级或页面级都可以） */
  static async connect(wsUrl, { timeout = 10000 } = {}) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP 连接超时: ' + wsUrl)), timeout);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = (e) => {
        clearTimeout(t);
        reject(new Error('CDP 连接失败: ' + (e && e.message ? e.message : wsUrl)));
      };
      ws.onmessage = (m) => cdp._onMessage(m.data);
      ws.onclose = () => cdp._onClose();
    });

    return cdp;
  }

  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || 'CDP 错误');
        e.code = msg.error.code;
        e.data = msg.error.data;
        p.reject(e);
      } else {
        p.resolve(msg.result || {});
      }
      return;
    }

    if (msg.method) {
      const list = this.listeners.get(msg.method);
      if (list) list.forEach((fn) => fn(msg.params || {}, msg.sessionId));
    }
  }

  _onClose() {
    this.closed = true;
    const err = new Error('CDP 连接已关闭');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  /** 事件订阅。handler(params, sessionId) */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
    return () => {
      const l = this.listeners.get(method) || [];
      const i = l.indexOf(handler);
      if (i >= 0) l.splice(i, 1);
    };
  }

  /**
   * 发一条 CDP 命令。
   * @returns Promise<result> 失败时 reject，Error 上带 code / data
   */
  send(method, params = {}, { sessionId, timeout = 15000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭，无法发送 ' + method));
    const id = ++seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 命令超时: ' + method + ' (' + timeout + 'ms)'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* 已关闭 */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP 连接已关闭')); }
    this.pending.clear();
  }
}

module.exports = Cdp;
