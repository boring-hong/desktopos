# DesktopOS — AI-to-Windows Bridge

一个跑在 Windows 上的 MCP Server，给 AI Agent 提供**持久化 PowerShell 会话**。

核心区别于「每次开一个新 PowerShell 进程」：`cd` 之后目录保持、环境变量保持、venv 状态保持。
AI 可以像人一样连续操作，而不是每条命令都从零开始。

---

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| Week 1-2 | Shell Worker（持久化会话） | ✅ 完成 |
| Week 3-4 | 双通道感知（窗口树 + 截屏 + 交叉验证） | ✅ 完成 |
| Week 5-6 | 内嵌 Playwright / CDP | ✅ CDP 已通（Playwright 未做，见下） |
| Week 7-8 | 操作验证（自愈） | ✅ 完成：执行→验证→诊断→修补→重试 |
| Week 9 | 记忆层 | ✅ 完成（窗口级 + 元素级） |
| Week 10 | MCP 封装 + 开源 | 🚧 MCP 已通并接入 DSH，开源待做 |
| — | 元素级控件树（UIA） | ✅ 完成（Electron 类应用除外，见下） |

---

## 快速开始

**要求**：Windows + Node ≥ 22（CDP 用 Node 内置的全局 WebSocket，无需额外依赖）。

```bash
cd <项目目录>

npm install       # 压缩包里已带 node_modules，可跳过
npm test          # 307 项，全绿才算可用
npm start         # 以 MCP Server 运行（stdio）
```

`npm test` 会真的起 PowerShell、真的开浏览器、真的动鼠标（只读动作），不是 mock。

### 注册到 MCP 客户端

把这段合并进客户端配置（模板见 `examples/mcp-config.json`）：

```json
"desktopos": {
  "type": "stdio",
  "command": "node",
  "args": ["<项目路径>/src/mcp-server/index.js"],
  "cwd": "<项目路径>"
}
```

- DSH（新版）：`C:\Users\<你>\.dsh\dsh-mcp-manager.json`
- DSH（旧版 / qwenworkcn）：`C:\Users\<你>\.qwenworkcn\mcp.json`
- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`
- Cursor：`%USERPROFILE%\.cursor\mcp.json`

哪个文件已存在就改哪个。路径用正斜杠可以避开 JSON 的反斜杠转义。重启客户端后生效。

> **第一次上手**：读 [`docs/QUICKSTART.md`](docs/QUICKSTART.md) —— 五分钟一页纸，
> 含可复制的客户端配置、一分钟自检清单、典型用法和已知限制。
>
> **想判断它靠不靠谱**：读 [`docs/REVIEW.md`](docs/REVIEW.md) —— 评审导览，
> 含 5 分钟验证路径、目录导航、已知边界和安全提示。

---

## 暴露的工具

| 工具 | 作用 |
|---|---|
| `shell_exec` | 在持久化会话中执行命令 |
| `shell_cd` | 切工作目录（**支持中文路径**） |
| `shell_cwd` | 查当前目录 |
| `shell_env_set` / `shell_env_get` | 环境变量读写，跨调用保持 |
| `shell_exec_verified` | 执行 + 独立验证结果 + 失败退避重试（自愈） |
| `shell_reset` | 会话异常时重启 PowerShell |
| `desktop_list_windows` | 结构通道：枚举窗口（标题/进程/矩形/聚焦/最小化） |
| `desktop_screenshot` | 视觉通道：截屏，返回 PNG/JPEG（`maxWidth` / `format` 控体积） |
| `desktop_perceive` | 双通道 + 交叉验证（核心能力） |
| `desktop_cursor` | 读鼠标坐标（只读） |
| `desktop_move` | 移动鼠标（不点击） |
| `desktop_click` | 点击 / 双击 / 右键（可带 `verify` + `verifyRegion`） |
| `desktop_type` | 输入文本，**支持中文** |
| `desktop_key` | 组合键，如 `ctrl+c` / `alt+tab` |
| `desktop_scroll` | 滚轮滚动 |
| `desktop_focus_window` | 把指定窗口切到前台 |
| `desktop_elements` | 元素级：枚举窗口内控件树（名称/类型/矩形/可点击） |
| `desktop_click_element` | 元素级：按名称点控件（InvokePattern，失败回落点中心） |
| `memory_recall` | 把指代解析成坐标（"刚才那个窗口" / "钉钉"，也支持控件级） |
| `memory_timeline` | 最近操作时间线 |
| `memory_stats` / `memory_clear` | 索引状态 / 清空 |
| `desktop_browser_launch` | 启动一个**带调试端口**的 Edge/Chrome（独立 profile，不抢你正在用的浏览器） |
| `desktop_cdp_targets` | 只读扫描：本机有哪些可连的 CDP 端点与页面 |
| `desktop_cdp_open` | 连上页面建立会话（可按标题/URL 选，或导航到指定 URL） |
| `desktop_cdp_elements` | 列页面内控件（角色/名称/层级，已去重） |
| `desktop_cdp_click` | 按名称点控件（算矩形中心 + 注入真实鼠标事件） |
| `desktop_cdp_type` | 输入文本，`Input.insertText` 中文天然无损 |
| `desktop_cdp_eval` | 在页面里执行 JS 并拿回结果 |
| `desktop_cdp_screenshot` | 页面级截图 |
| `desktop_cdp_close` | 关会话 + 杀掉自己启动的浏览器 |
| `desktop_diagnose` | 把一条报错翻译成「为什么 + 怎么办 + 能否自动修」 |

典型用法：

```
shell_cd   → <某个含中文的目录>
shell_exec → git status          ← 直接在上面那个目录执行
```

自愈用法（不轻信命令返回值，执行后真去验证）：

```
shell_exec_verified
  command: New-Item -ItemType Directory -Path 'D:\新目录' -Force | Out-Null
  expect : { "isDir": "D:\\新目录" }
  retries: 2
```

`expect` 支持：`pathExists` / `pathNotExists` / `isDir` / `isFile` / `fileContains:[路径,内容]` / `cwd`。
验证走 Node 的 fs（原生 UTF-8 路径），不经过 shell，中文路径同样可靠。

---

## 按需裁剪工具面（多服务器共存时用）

**问题不在工具多，在于重叠没人裁决。**

主流 MCP 客户端（DSH / Claude Desktop / Cursor）只支持按**服务器**启停，
没有工具级开关。于是机器上同时装了另一个桌面自动化、一个浏览器自动化之后，
这个服务器暴露的 33 个工具里有相当一部分是在问同一个问题：
「点这个控件」有两条路，「截个图」有三条路。模型每次调用都得猜，
而猜错的概率随重叠面积上升 —— 这是装多了之后真实会出现的退化。

客户端修不了，就在服务器侧修：**启动时把重叠的那部分裁掉，决策点直接消失**。

```bash
# 按分组
DESKTOPOS_TOOLS=shell,diagnose node src/mcp-server/index.js

# 按工具名，可混写
DESKTOPOS_TOOLS=shell_exec,shell_cd,desktop_perceive node src/mcp-server/index.js

# 或者排除法（exclude 优先）
DESKTOPOS_TOOLS=shell,desktop DESKTOPOS_TOOLS_EXCLUDE=desktop_screenshot

# 命令行等价写法
node src/mcp-server/index.js --only=shell,diagnose
```

分组：

| 分组 | 工具 | 什么时候需要裁 |
|---|---|---|
| `shell` | shell_exec / _verified / _cd / _cwd / _env_get / _env_set / _reset | 几乎总是要留 —— 这套最不可替代 |
| `desktop` | list_windows / perceive / screenshot / cursor / move / click / type / key / scroll / focus_window | 已有别的桌面自动化时可裁 |
| `elements` | elements / click_element | 需要元素级点击时留 |
| `cdp` | browser_launch / cdp_*（9 个） | **已有 Playwright 就整组裁掉** |
| `memory` | memory_* | 不需要桌面状态记忆时裁 |
| `diagnose` | desktop_diagnose | 纯知识，建议留 |

三条行为保证（`test/toolfilter.test.js` 覆盖）：

1. **不设过滤 = 暴露全部**，OSS 用户的默认体验不受影响；
2. 裁剪后 `tools/list` 只剩选中的；
3. **执行期同样拦截** —— 只裁 `tools/list` 是不够的：客户端的工具表可能是缓存的，
   模型也可能记得旧名字，那时调用会绕过裁剪照常执行，配置看着生效其实没有。

### 配套：重叠审计

裁剪是手工判断，所以给了一个把「重叠」量化成数字的脚本：

```bash
npm run audit:overlap
```

它会连上配置里每个 MCP 服务器、拉一遍 `tools/list`，然后按名字与描述的相似度
输出跨服务器的近重复对。用法是**当成候选清单看，不是判决**：

- 名字撞但语义不同的很常见（`windows-mcp/Click` 点的是操作系统窗口，
  `playwright/browser_click` 点的是页面 DOM 元素 —— 这两条本来就不该合并）；
- 中英文描述混在一起时，描述相似度会失灵，只能靠名字相似 + 人工判断；
- 它只看 MCP 服务器，看不到客户端的原生工具（如内置的 shell / 文件读写），
  所以真实重叠量会比报告数字更大。

**每装一个新服务器就跑一次**，别让重叠悄悄累积 —— 这是这个脚本存在的唯一理由。

---

## 自愈：诊断器

之前的自愈只有半截 —— 执行 → 验证 → 重试。但「重试」对大多数失败毫无意义：
命令写错了，再跑十次还是错。缺的是中间那步：**搞清为什么失败**。

现在失败会先过一遍诊断器，产出五样东西：

```
category    失败类别（access-denied / cmd-not-found / missing-parent / ...）
reason      人话解释
hint        可行动的提示
suggestion  具体下一步（命令或工具调用）
retryable   原样重试到底有没有意义
fix         能自动修的话，给出修补命令
```

**`retryable` 是这里最关键的判断。** 大多数 AI 桌面工具失败就无脑重试，
而「权限不足」「命令不存在」「参数写错」这类失败重试一万次也是浪费时间 ——
诊断器会直接说「重试无意义」，并指向真正该做的事。

### 自动修补有边界，不是什么都敢修

只有**纯加法**的修补才默认执行（目前一类：父目录缺失时补建）。
其余必须显式开 `autoFix`。并且有两条硬约束：

1. **父目录真的不存在才补建** —— 否则就是「目标本身不存在」，补建毫无意义。
2. **命令本身是创建类才补建** —— 对 `Get-ChildItem` 这种读取命令去建目录，
   等于凭空造出一个假路径。那不是自愈，是胡来。

真实例子（测试里跑通的）：

```
New-Item -ItemType File -Path '...\a\b\x.txt'      ← 父目录 a\b 不存在
  ↓ 诊断: missing-parent（原样重试有意义）
  ↓ 自动修补: New-Item -ItemType Directory -Path '...\a\b' -Force
  ↓ 重跑，验证通过，文件真的存在
```

### 规则刻意不接 LLM

纯字符串匹配，毫秒级返回，可测试可回归。代价是只能覆盖已知类别 ——
所以未命中时会老实说「未能归类」，并把报错原文回传，方便扩充规则表。

已覆盖：编码损坏 / 文件占用 / 权限不足 / 命令不存在 / 参数错误 / 类型转换 /
语法错误 / 超时 / 目标已存在 / 路径不存在 / 父目录缺失 / 控件找不到 / 控件歧义 /
窗口最小化 / 句柄失效 / UIA 不可用 / CDP 不可用。

**任何工具报错都会自动附带诊断**，不只是 shell —— 兜在 MCP 的 catch 里。

---

## 架构

```
Node (MCP Server)
   ├─ HTTP 127.0.0.1:<随机端口> ──▶ PowerShell 5.1 (worker.ps1)
   │     header: X-DOS-Token: <每进程随机>     同一 runspace 长期存活 ──▶ Win32 / UIA
   │     body:   { command: base64(UTF-8) }
   └─ WebSocket (CDP) ──▶ Edge / Chrome / Electron 的调试端口 ──▶ DOM + 无障碍树
```

### 为什么本地端口也必须鉴权

「只绑 127.0.0.1」**不等于**私有。攻击路径很具体：

1. 恶意网页用 `fetch('http://127.0.0.1:<port>/exec', { method:'POST', body: '<json>' })`；
2. `Content-Type` 默认 `text/plain`，而它属于 **CORS 安全列表值** —— 于是这是一个「简单请求」，
   **不触发预检**，浏览器直接把请求发出去；
3. 响应读不到（CORS 会拦），但**副作用已经发生**；端口虽然随机，也只有约 16k 个候选，页面盲扫几秒就够。

结论：不加鉴权的话，用户访问任意网页就等于把 PowerShell、鼠标和键盘交出去。

现在的做法：

- Node 为**每个 worker** 生成 32 字节随机 token，经 argv 传给 PowerShell；
- 每个请求必须带 `X-DOS-Token`，不匹配一律 403；
- 带 `Origin` 头的请求一律 403（我们自己的 Node 客户端从不发 Origin）。

关键点在于**自定义请求头**：它不属于安全列表值，跨站请求因此必须走预检，浏览器会直接拦掉。
回归测试在 `test/resilience.test.js`，覆盖「跨站 Origin + text/plain」「无 token」「错误 token」「正确 token」四种情况。

> token 走 argv，本机其他进程读得到它 —— 但那种攻击者本来就能直接执行代码，不在威胁模型内。

### 为什么不是 stdin 管道 + marker

最初的实现是 `powershell.exe -Command -`，往 stdin 写命令、靠一个 marker 字符串判断命令结束。
这条路有四个绕不开的坑（都已用实测确认）：

1. **编码**：`powershell.exe` 用 `[Console]::InputEncoding` 解码管道 stdin，中文机器上是 **CP936/GB2312**。
   Node 写的 UTF-8 中文被解成乱码 → 中文路径 100% 失效。
   实测：`InputEncoding : gb2312 (codepage 936)`。
2. **流交错**：stdout 与 stderr 混在一起，marker 会被命令输出淹没或被残留 buffer 误判。
3. **进程退出**：终止性错误会让 PowerShell 直接 `exit(1)`，后续 marker 永远等不到。
4. **错误丢失**：`Invoke-Expression` 不把内部非终止性错误可靠并入调用方错误流。

对应解法：

- 换 **HTTP 传输层**：命令 base64 走 body，响应显式写 UTF-8 字节，全程不碰控制台编码。
- 用 **scriptblock 点源执行 + 重定向**（`. $sb 2>&1`）：既捕获非终止性错误，又保证变量/目录留在同一 runspace。

`worker.ps1` 刻意保持**纯 ASCII**，所有非 ASCII 数据一律 base64 传输，
连 PowerShell 默认按 ANSI 读 `.ps1` 这个坑也一并绕开。

> **踩坑记录：改这些 `.ps1` 时小心 AMSI。**
> 往 `perception.ps1` 里加 JPEG 质量参数（`ImageCodecInfo::GetImageEncoders()`
> 配 `EncoderParameters`）之后，整份脚本被 Windows Defender 判成
> 「contains malicious content」直接拒绝执行 —— 单独跑那一小段没事，
> 和「截屏 + base64 + HttpListener」放在一起就触发了组合启发式。
> 换成朴素的 `ImageFormat::Jpeg` 重载即可。加任何"截屏后编码"的代码前先测一遍。

---

## 卡死之后会自己站起来

PowerShell 5.1 的 runspace 是单线程的：一条卡住的命令（等输入的交互程序、
忘了 `-y` 的 `npm install`、一直不返回的网络请求）会让 `GetContext()`
永远回不去，之后所有请求全部超时。

而且早期的 `stop()` 是 `await` 一个**没有超时**的 `/shutdown` —— 对端已经卡死，
于是逃生门自己也挂住，`shell_reset` 一样不返回，只能重启 MCP 客户端。

现在的分层：

| 层 | 机制 |
|---|---|
| 命令 | 超时即抛出；**自动硬重启** worker，并把记住的 cwd 与环境变量重放回去 |
| 请求 | `_request` 自带超时（命令超时 +5s），任何一层都不能把上一层永远挂住 |
| 停止 | 先短超时（1.5s）尝试优雅退出，**然后无条件 kill 并等待真实退出** |
| 启动 | 缓存的是**启动 Promise**，并发调用共用同一次 spawn（`_spawnOnce` 最多重试 3 次） |

所以卡一次命令的代价是「重启 + 重放状态」，不是「这一整个会话废了」。
代价要说清楚：进程内没被 `shell_env_set` 记录过的变量、以及非 cwd 的其它 runspace
状态（函数定义、模块导入）确实会丢。`test/resilience.test.js` 验的就是 cwd 和
通过 `shell_env_set` 写过的变量能活下来。

---

## 双通道感知

所有 AI 桌面工具都在做「截图 → OCR → 猜」，这是错误架构。这里两条通道同时开：

| 通道 | 实现 | 产出 |
|---|---|---|
| 结构 | Win32 P/Invoke：`EnumWindows` / `GetWindowRect` / `GetWindowText` / `GetForegroundWindow` | 句柄、标题、进程、PID、矩形、聚焦、最小化 |
| 视觉 | `System.Drawing` 全屏截屏，按窗口矩形采样像素算标准差 | 该区域是否真有内容渲染 |

**交叉验证**：结构通道说「可见」的窗口，视觉通道必须证明它 (1) 在屏幕内 (2) 真有内容。否则标为不一致，原因分三类：

```
minimized  最小化（Windows 把它们停放到 -32000/-21333 这类坐标）
offscreen  在屏幕外
blank      区域无内容（如 1x1 的隐藏窗口）
```

实测本机 17 个窗口：一致 5 个，不一致 12 个（minimized 8 / offscreen 2 / blank 2）。
关键是 `IsWindowVisible` 对最小化窗口也返回 true —— **只看窗口列表会误判，必须双通道核对**。

---

## 执行层（UI 执行器）

真实输入注入：`focus` / `move` / `click` / `scroll` / `type` / `key`。

**中文输入**是个坑：`SendKeys` 不支持 Unicode，中文会被打成乱码。
所以输入走**剪贴板（SetText，完整 Unicode）+ Ctrl+V**，中文完好无损——
和整个项目一致的思路：非 ASCII 一律不裸奔过 shell/控制台编码。

**内置验证**：任何动作都可以带 `verify`，前后各截一次屏，采样比对后返回 `diffRatio`。
「操作 → 验证」因此是基础设施，不用每个调用方自己拼。

验证可以**限定区域**：`verifyRegion: { x, y, w, h }`（通常直接传目标窗口的 rect）。
不传就比对全屏 —— 而全屏比对回答的是「屏幕上有没有东西变」，
不是「我这个动作有没有让目标变」；一个跳秒的时钟或闪烁的光标都会被算进去。
返回里带 `scope: "region" | "screen"`，一眼能看出这次结论的力度。

典型闭环：

```
desktop_perceive                       → 拿到目标窗口 handle 与 rect
desktop_click {x,y,verify,verifyRegion → 点它，只在那个窗口范围内比对
              :<rect>}
desktop_screenshot                     → 肉眼确认
```

> ⚠️ 点击和输入会真实抢走你的鼠标与键盘焦点。
> 自动化测试**只覆盖只读与无副作用动作**（cursor / move），
> 真实 click / type / key 请用 `test/_dbg-actor.js` 手动触发，或经 MCP 显式调用。

```bash
node test/_dbg-actor.js cursor
node test/_dbg-actor.js click 500 300        # 会真点，工具内置 5 秒缓冲
node test/_dbg-actor.js type "中文输入测试"
```

---

## 记忆层

解决 AI 操作电脑最痛的一点：**不记得之前做过什么、看过什么**。
有了它，「点击刚才那个按钮」这类指代才成立。

三块内容：

| 组成 | 实现 |
|---|---|
| 操作日志 | 每次 perceive / act 自动记一条，带时间戳 |
| 特征索引 | 窗口的 **8×8 dHash 差分哈希**（真正的「截图 → 向量」），可按汉明距离再认出来 |
| 上下文管理器 | 聚焦窗口历史 / 导航栈 |

持久化在 `~/.desktopos/memory.json`，跨进程、跨重启保留。

实测效果：

```
"刚才那个窗口"  -> 微信 [WeChat]        坐标(853,509)   按"最近"定位
"explorer"      -> Program Manager      坐标(854,534)   按关键词定位
"Excel"         -> 存在但已最小化，请先用 desktop_focus_window 还原（句柄 68036）
```

最后一条是关键设计：**区分「真没有」和「有但最小化了」**。
说成「不存在」会把 Agent 带偏，所以给了可行动的提示 + 句柄。

感知哈希是 8×8 灰度**差分**哈希（dHash），不需要任何 ML 模型 ——
窗口移动、缩放后仍能再认。

> 为什么不是 aHash：aHash 只记「这一格比平均值亮还是暗」，梯度方向与颜色全丢。
> 实测在本机 33 个窗口里，aHash 把「文件资源管理器」和一个毫不相关的网页算成
> **完全相同**的 64 位指纹（距离 0）；而 `findByHash` 的用途正是把「刚才那个窗口」
> 解析成坐标，指错了下一步就是真点击。换成 dHash 之后重新抓帧比对 105 对窗口，
> 只有 2 对距离为 0（都是同类的扁平小窗），98 对距离 >12，分离度足够。
>
> 即便如此，哈希也只是**弱辅助信号**：`findByHash(hash, { expect: { title, process } })`
> 建议带上标题/进程做交叉校验，只有对上才算同一个目标；默认阈值也从 10 收紧到 6。
> 纯色 / 空白区域哈希相同仍属正常退化现象。

索引已经不止窗口级：`desktop_elements` / `desktop_perceive` 会自动把控件也写进索引，
「刚才那个按钮」这类指代因此可以命中元素而不是窗口。

---

## 元素级感知（UIA）

从「点窗口中心」进化到「点那个按钮」，靠 `System.Windows.Automation`（UIA）枚举控件树：

```
desktop_list_windows      → handle=854182（现在会带句柄输出）
desktop_elements          → { handle: 854182 }
desktop_click_element     → { handle: 854182, name: "小组件" }
```

`desktop_elements` 返回每个控件的 **名称 / 控件类型 / 矩形 / 是否支持 Invoke**。
`desktop_click_element` 优先走 `InvokePattern.Invoke()`（不需要坐标，最小化也能触发），
不支持时才回落到「算矩形中心 → 真实点击」。

实测控件名中文往返无损：

```
Button       小组件 22°C 大部晴朗
Group        22°C 大部晴朗
```

### 已知边界：Electron / Chromium 是瞎的

| 应用 | 枚举到的控件数 |
|---|---|
| explorer | 28 |
| msedge | 25 |
| WorkBuddy（Electron） | **0** |

UIA 看不见 Chromium 渲染树内部 —— 这类应用整个窗口只暴露一两个 pane，
再往下就是一片黑。返回 0 时工具会**给出解释而不是崩溃**：
「该应用不暴露 UI Automation 控件树（Electron/Chromium 常见）」。

这正是 **Week 5-6 要接 Playwright / CDP** 的直接原因：
对 Chromium 系应用，UIA 这条路走不通，必须走浏览器调试协议。

---

## CDP 通道（看见 Chromium 内部）

UIA 看不进去的地方，用 Chrome DevTools Protocol 直接问浏览器。零新增依赖 —— Node 22 起 `WebSocket` 已是全局对象。

```
desktop_browser_launch { headless: false, url: "https://..." }   -> 返回端口
desktop_cdp_open       { port, url, navigate: true }             -> 会话 s1
desktop_cdp_elements   { session: "s1" }                         -> [button] 搜索 / [textbox] 请输入
desktop_cdp_type       { text: "中文关键词", target: "请输入" }
desktop_cdp_click      { name: "搜索" }
desktop_cdp_eval       { expression: "document.title" }
desktop_cdp_close      {}
```

语义刻意和元素级 UIA 对齐（`elements` / `click` / `type`），上层不用分两套心智模型。

### 三个关键设计

**1. 必须先开调试端口。** 浏览器默认不暴露 CDP。所以给了一个 launcher：
带 `--remote-debugging-port` + **独立 `--user-data-dir`**，不会和你正在用的浏览器抢 profile。
端口只监听 127.0.0.1（CDP 默认行为）。

**2. `Input.insertText` 而不是键盘事件。**
中文走 UIA 那套要剪贴板 + Ctrl+V；CDP 有 `Input.insertText`，直接写入、不经过键盘布局，
中文和 emoji 都无损 —— 比前两条路都干净。

**3. AX 树必须去重。**
`getFullAXTree` 会给一个按钮同时产出 `button` / `StaticText` / `InlineTextBox` 三个同名节点。
那是同一个控件的三种投影，不是三个控件 —— 不去重的话「点搜索」会被判成歧义而失败。
`elements()` 默认丢掉与交互式节点同名的文本投影；`find()` 再按「交互式角色优先 + 层级更浅优先」排序。
（不修这个，实测枚举出来是 13 个控件、点击直接报错；修完是 5 个、点击正常。）

> ⚠️ `headless: false` 时浏览器窗口会真的弹出来并抢焦点，自动化场景用 `headless: true`。
> 用完记得 `desktop_cdp_close`，否则无头浏览器会留在后台。

### 为什么没上 Playwright

Playwright 的价值是等待/定位/自动重试，代价是几十 MB 依赖 + 浏览器下载。
CDP 直连已经拿到了 Playwright 的底层能力（DOM、AX 树、输入注入），
而「等待」可以用 `waitReady()` + `desktop_cdp_eval` 自己表达。
等真出现「选择器 + 自动等待」的强需求再引不迟。

### 已知边界

- 需要浏览器带调试端口启动，无法凭空虚附到已在运行的实例上（这是浏览器侧限制）。
- 页面级坐标系，不是屏幕坐标 —— 所以 CDP 的点击和 `desktop_click` 的屏幕坐标不是一个东西。

---

## 测试覆盖

`npm test` = 6 编码守卫 + 13 Shell Worker + 15 韧性/安全 + **13 工具过滤** + 20 感知
+ 11 执行 + 123 诊断 + 38 记忆 + 81 MCP 端到端，共 **320 项**。

其中 CDP 那 16 项是**真端到端**：真的起一个无头 Edge、真的导航、真的注入鼠标事件、
断言页面 DOM 真的变了。本机没装 Edge/Chrome 时自动 SKIP，不算失败。

**韧性/安全（`resilience.test.js`，新增）**覆盖三类曾经真实出过的问题：

- **鉴权**：跨站 Origin + text/plain、无 token、错误 token 一律 403；正确 token 才执行
- **卡死恢复**：命令超时后会话自动恢复；cwd 与 `shell_env_set` 写过的变量被重放回来；
  卡死状态下 `stop()` 仍在有限时间内返回
- **并发冷启动**：5 个并发 `start()` 只 spawn 一个进程
- **请求体上限**：5 MB body 返回 413，而不是被 `ReadToEnd()` 全读进内存

**编码守卫（ascii-guard）**：强制所有 `.ps1` 纯 ASCII。
PowerShell 5.1 无 BOM 时按 ANSI/CP936 读 `.ps1`，混进中文注释会被解成乱码、
并悄悄破坏紧随其后的代码行（曾导致一行 `$min = if (...) {...}` 整体失效，
输出的 JSON 变成 `"minimized":,`）。这条测试就是这条规则的执行者。

重点回归点：

- `cd` 到含中文的路径（`...\代码\desktopos`）—— 旧方案在此必挂
- 中文窗口标题经感知层往返无损（无 U+FFFD）
- 目录/环境变量跨调用持久化
- 非终止性错误、终止性错误、原生命令 stderr 都能捕获
- 出错后会话仍存活（不挂死）
- 交叉验证自洽：一致数 + 不一致数 = 总数，且与布尔字段一致
- 元素枚举：至少一个真实窗口能枚举出控件（正向），且控件名无 U+FFFD
- 点不存在的控件必须返回 `isError`，**不能误触任何东西**
- 诊断器判定 `retryable: false` 时**真的不再重试**（不是只写在提示里）
- 路径里出现 `C:\Users\Administrator\...` 不能被误判成权限不足
- dispatcher 里能处理的工具必须都在 `tools/list` 登记过（否则 Agent 根本看不到它）

### 调试工具（非测试）

- `test/_dbg-exec.js` —— 逐个查看命令的 output/error/exitCode，排查错误捕获
- `test/_dbg-perception.js` —— 打印双通道明细与耗时，排查感知问题
- `test/_dbg-actor.js` —— 手动触发真实 click / type / key（自动化测试不碰）
- `test/_dbg-elements.js` —— 打印指定窗口的控件树，排查 UIA 枚举
- `test/_dbg-cdp.js` —— CDP 调试：`survey` 扫描端点 / `launch` 起实例 / `smoke` 全自动冒烟

---

## 文件结构

```
src/
├── mcp-server/index.js      MCP Server（stdio transport，33 个工具）
├── http-worker/index.js     三个 worker 共享的传输层：token 鉴权 / 分层超时 / 端口重试 / 无条件 kill
├── verifier/index.js        执行→验证→诊断→修补→重试（自愈闭环，retryable 已接线）
├── diagnoser/index.js       错误诊断器：18 类失败规则，产出原因/建议/修补
├── cdp/
│   ├── index.js             CDP 高层：Browser / Session（elements/click/type/eval/screenshot）
│   ├── client.js            极简 CDP 客户端（原生 WebSocket，零依赖）
│   ├── discover.js          扫描 127.0.0.1 上的调试端点 /json/version、/json/list
│   └── launch.js            带调试端口 + 一次性 profile 启动 Edge/Chrome
├── sensor/
│   ├── index.js             Node 端：感知 worker 封装（listWindows/screenshot/perceive/elements）
│   └── perception.ps1       PowerShell 端：结构通道 + 视觉通道 + 交叉验证 + UIA + dHash
├── actor/
│   ├── index.js             Node 端：执行 worker 封装（focus/click/type/key/scroll/element）
│   └── actor.ps1            PowerShell 端：Win32 输入注入 + 区域化截图比对 + UIA Invoke
├── memory/index.js          记忆层：操作日志 / 特征索引 / 上下文栈 / 元素索引
└── shell-worker/
    ├── index.js             Node 端：会话封装 + 卡死后自动重启与状态重放
    └── worker.ps1           PowerShell 端：HttpListener + token 校验 + 执行引擎
test/
├── ascii-guard.test.js      .ps1 纯 ASCII 守卫（防编码回归）
├── shell-worker.test.js     Shell Worker 单元/集成
├── resilience.test.js       鉴权 / 卡死恢复 / 并发单例 / 请求体上限
├── perception.test.js       双通道感知 + 元素级枚举
├── actor.test.js            UI 执行层（安全子集）
├── diagnoser.test.js        诊断器：分类 + 真自愈集成（123 项）
├── memory.test.js           记忆层（用临时存储，不污染真实记忆）
├── mcp-e2e.test.js          MCP 协议端到端
├── _dbg-*.js                手动调试工具（不参与 npm test）
└── _probe-*.js              评审期复现脚本（不参与 npm test）
```
