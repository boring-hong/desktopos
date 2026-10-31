# 评审导览

给第一次看这个项目的人。**按这个顺序看，15 分钟能判断出它靠不靠谱。**

---

## 1. 它是什么

一个跑在 Windows 上的 MCP Server，让 AI Agent 真正操作 Windows：
持久化 PowerShell 会话、双通道桌面感知、元素级控件操作、CDP 浏览器通道、失败自诊断。

一句话区别于同类工具：**不靠截图 + OCR 猜界面**。
它直接问系统要结构（Win32 / UI Automation / CDP 无障碍树），
视觉只用来交叉验证结构说的对不对。

---

## 2. 5 分钟验证

```bash
cd <项目目录>
npm install       # 包里已带 node_modules，可跳过
npm test          # 307 项，全绿才算可用
npm start         # 以 MCP Server 运行（stdio，不会自己打印东西）
```

测试会**真的**干这些事（不是 mock）：

- 起 PowerShell 进程、`cd` 到含中文的路径
- 枚举真实窗口、截屏、做交叉验证
- 起一个无头 Edge，导航、注入鼠标事件、断言页面 DOM 真的变了
- 故意让命令因父目录缺失失败，看它能不能自己补建后成功
- 故意发一条会卡死的命令，看会话能不能自己站起来
- 故意发跨站 POST，看鉴权能不能挡住

机器上没 Edge/Chrome 时，CDP 那段会自动 SKIP，不算失败。

---

## 3. 目录导航

| 看什么 | 文件 | 一句话 |
|---|---|---|
| 能力清单 | `README.md` | 33 个工具、架构、所有设计决策的理由 |
| **传输层 + 鉴权 + 分层超时** | `src/http-worker/index.js` | 三个 worker 共用的底座：token、超时、无条件 kill |
| **最核心的设计** | `src/shell-worker/worker.ps1` | 为什么用 HTTP + base64 而不是 stdin 管道；token 校验 |
| 卡死恢复 | `src/shell-worker/index.js` | 超时后自动重启并重放 cwd/env |
| 感知 | `src/sensor/perception.ps1` | 结构通道 + 视觉通道 + 交叉验证 + dHash |
| 执行 | `src/actor/actor.ps1` | 真实输入注入，中文走剪贴板，区域化 verify |
| 浏览器通道 | `src/cdp/index.js` | AX 树去重那一段是重点（有注释说明） |
| 自愈 | `src/diagnoser/index.js` | 18 类失败规则 + 自动修补的两条硬约束 |
| 自愈闭环 | `src/verifier/index.js` | `retryable` 真正接线：判不可重试即停 |
| 协议层 | `src/mcp-server/index.js` | 工具定义 + 分发 |

测试目录 `test/` 与源码一一对应，`_dbg-*.js` 是手动调试工具、`_probe-*.js` 是评审期
复现脚本，都不参与 `npm test`。

> 完整的独立评审与修复记录见 [`REVIEW-LEAD.md`](REVIEW-LEAD.md)。

---

## 4. 四个值得审视的设计决策

**① 传输层用 HTTP + base64，不是 stdin 管道 + marker。**
最初实现是往 PowerShell 的 stdin 写命令、靠 marker 判断结束，踩了四个坑（README 有详述）。
根因是 `[Console]::InputEncoding` 在中文机器上是 CP936/GB2312 ——
Node 写的 UTF-8 中文被解成乱码，**中文路径 100% 失效**。
改成 base64 后彻底绕开控制台编码，连 `.ps1` 被按 ANSI 读取的坑也一并解决。

**② 感知必须是双通道。**
`IsWindowVisible` 对最小化窗口也返回 true（Windows 把它们停放到 -32000 这类坐标）。
只列窗口会严重误判 —— 实测 17 个窗口里有 12 个是"看起来可见其实看不见"。
所以结构通道说可见的，视觉通道必须证明它真的在屏幕内、真有内容。

**③ CDP 而不是 Playwright。**
CDP 直连已经拿到 Playwright 的底层能力（DOM、AX 树、输入注入），
代价是零依赖（Node 22 起 WebSocket 是全局的）。
Playwright 的额外价值是选择器 + 自动等待，代价是几十 MB 依赖 + 浏览器下载。
等真出现这个需求再引不迟。

**④ 诊断器不接 LLM。**
纯字符串规则，毫秒级、可测试、可回归。
代价是只能覆盖已知类别 —— 未命中时它老实说"未能归类"并回传原文。

**⑤ 本地回环端口也必须鉴权。**
"只绑 127.0.0.1"不等于私有：网页可以用 CORS 安全列表里的 `Content-Type: text/plain`
发跨站 POST，不触发预检，请求真的会送出去 —— 响应读不到，但命令已经执行了。
所以每个 worker 带一个随机 token，且带 `Origin` 头的请求一律拒。
细节在 README「为什么本地端口也必须鉴权」。

---

## 5. 已知边界（诚实清单）

| 边界 | 说明 |
|---|---|
| Electron / Chromium 对 UIA 是瞎的 | 实测 WorkBuddy 枚举 0 个控件，explorer 28 个。这类必须走 CDP |
| CDP 需要浏览器带调试端口启动 | 浏览器的限制，无法凭空虚附到已运行的实例 |
| 记忆层是窗口级 + 控件级，不是语义级 | 能认出"刚才那个按钮"，不理解"把第三列求和" |
| 诊断器只覆盖 18 类 | 未命中时归为 unknown |
| 自动修补目前只有一类 | 父目录缺失；其余需显式开 `autoFix` |
| 卡死后自动重启会丢状态 | cwd 和 `shell_env_set` 写过的变量会重放；函数定义、模块导入、其它进程内状态不保 |
| 没有沙箱/回滚 | 点击、输入、删除都是真的，没有 undo |
| 仅 Windows + PowerShell 5.1 | 未测 PowerShell 7 |

---

## 6. 安全提示（请务必先看）

- **点击和输入是真实的**，会抢走鼠标和键盘焦点。
  所以自动化测试只覆盖只读/无副作用动作，真实 click / type 需手动触发。
- **本地 HTTP 端点有随机 token 鉴权**（见 README 对应章节）。
  带 `Origin` 头的请求一律 403；token 每次启动重新生成，走 argv 传给 PowerShell。
- **CDP 调试端口只监听 127.0.0.1**（CDP 默认行为）。
  启动的浏览器用**一次性** `--user-data-dir`，不碰用户正在用的 profile；
  用完调 `desktop_cdp_close`，否则无头浏览器会留后台（profile 目录会一起清掉）。
- **没有权限提升**。遇到需要管理员的操作，诊断器会提示，不会代你提权。

---

## 7. 如果要挑刺，建议看这几处

1. `src/http-worker/index.js` 的 token 用 argv 传递 —— 本机进程可读，
   是否可接受取决于威胁模型（能读 argv 的攻击者本来就能直接执行代码）
2. `src/cdp/index.js` 的 AX 树去重启发式 —— 会不会误删真实控件
3. `src/diagnoser/index.js` 的规则顺序 —— 是否有互相吞掉的情况
   （`Administrator` 那条就属于此类，已修）
4. `src/memory/index.js` 的 dHash 阈值 6 —— 纯色/空白区域仍是退化情况
5. 所有 `.ps1` 是否真的纯 ASCII（有 `test/ascii-guard.test.js` 强制，但值得人工确认）
6. 改 `.ps1` 时注意 AMSI：截屏 + base64 + HttpListener 放一起容易触发组合启发式
   （加 JPEG 编码参数时踩过，整份脚本被拒执行）
