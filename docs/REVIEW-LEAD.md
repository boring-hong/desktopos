# 独立评审 → 修复记录

评审对象：`desktopos-0.2.0.zip`（与 `E:\Boring hong\Documents\代码\desktopos` 同版本）
修复后版本：`0.2.1`

评审方式：**不信文档，只信复现。** 跑了完整 `npm test`，逐条读源码，
写探针脚本复现每一个可疑点，然后逐项修复并补回归测试。

**结论：架构判断清醒，工程质量高；原版有 3 处硬伤（1 安全 / 1 可靠性 / 1 核心卖点没接线），
现已全部修复并纳入 `npm test`。**

| | 修复前 | 修复后 |
|---|---|---|
| 测试数 | 292 | **307**（新增 15 项韧性/安全回归） |
| P0 安全 | 无鉴权本地命令执行 | token + 拒 Origin |
| P0 可靠性 | 一条卡死命令废掉整个会话 | 自动重启并重放 cwd/env |
| P1 并发 | 并发冷启动泄漏进程 | 并发共用同一次 spawn |
| P1 自愈 | `retryable` 算了没人用 | 真正接线，判不可重试即停 |

---

## 一、原版做对了什么（保持不动）

| 判断 | 为什么是对的 |
|---|---|
| 放弃 stdin 管道 + marker，改 HTTP + base64 | **根因找对了**。`powershell.exe` 用 `[Console]::InputEncoding` 解码管道 stdin，中文机器上是 CP936 → Node 写的 UTF-8 中文必成乱码，中文路径 100% 失效。换传输层是从根上解决，不是绕 |
| `.ps1` 强制纯 ASCII + `ascii-guard` 测试 | 老手才会留的测试。PS 5.1 无 BOM 时按 ANSI 读脚本，混进一个中文注释会**悄悄破坏紧随其后的代码行** |
| 双通道感知 + 交叉验证 | `IsWindowVisible` 对最小化窗口也返 true（Windows 把它们停在 -32000）—— 真实的坑。实测 18 窗口一致 12 / 不一致 6，逻辑自洽 |
| 诊断器不接 LLM | 判断正确。诊断必须毫秒级、可测试、可回归 |
| UIA 对 Electron 是瞎的 → 走 CDP | 边界认识准确：WorkBuddy 0 个控件、explorer 28 个 |
| AX 树去重 | `getFullAXTree` 对同一按钮产出 button / StaticText / InlineTextBox 三个同名节点，不去重就判歧义 |
| 测试不是 mock | 真起 PowerShell、真起无头 Edge、真注入鼠标事件、真断言 DOM |

---

## 二、已修复的问题

### P0-1　安全：三个 worker 的本地 HTTP 端点没有任何鉴权 ✅ 已修

「只绑 127.0.0.1」不等于私有。恶意网页用 `fetch` 发 POST，`Content-Type: text/plain`
属于 **CORS 安全列表值** → 简单请求 → **不触发预检** → 请求真的发出去；
响应读不到，但**副作用已经发生**。端口随机也只有约 16k 个候选，页面盲扫几秒就够。

**复现（修复前）**：`Origin: https://evil.example.com` + `text/plain` → 200，
命令执行，返回 `PWNED-BY-WEBSITE`。三个 worker 都是同一个模式，
而 `actor.ps1` 能移鼠标、注入按键。

**修法**：

- 新增 `src/http-worker/index.js`：Node 为每个 worker 生成 32 字节随机 token，经 argv 传给 PowerShell；
- 三个 `.ps1` 各加 `Test-Authorized`：无正确 `X-DOS-Token` 或带 `Origin` 头，一律 403；
- 关键在**自定义请求头**不属于安全列表值 → 跨站必须预检 → 浏览器直接拦掉。

**验证**：`test/resilience.test.js` 第 1 组，4 项全过；`test/_probe-auth.js` 手工复现同样 4/4。

---

### P0-2　可靠性：一条卡死的命令会永久废掉会话，逃生门跟着一起死 ✅ 已修

PS 5.1 的 runspace 单线程，卡住的命令让 `GetContext()` 永远回不去；
而旧 `stop()` 是 `await` 一个**没有超时**的 `/shutdown`，对端已卡死 →
`stop()` 永不返回 → `_alive` 永远不清零 → `start()` 变成假重启 →
`shell_reset` 这个唯一逃生手段也一起挂死。

**复现（修复前）**：`Start-Sleep 30` 超时后，后续命令全部超时；`stop()` 6s 仍 pending。

**修法（分三层，任何一层都不能把上一层永远挂住）**：

| 层 | 措施 |
|---|---|
| 命令 | 超时即抛出，并**自动硬重启** worker：kill → 重 spawn → 重放 `_lastCwd` 与 `_envVars` |
| 请求 | `_request` 自带超时（`cmdTimeout + 5s`），与命令超时相互独立 |
| 停止 | 先 1.5s 短超时尝试优雅退出，**然后无条件 kill 并 `await` 真实 `close`** |

**验证**：`test/resilience.test.js` 第 2、3 组，6 项全过 ——
超时后命令可执行、cwd 被还原、环境变量被还原、卡死时 `stop()` 仍有限返回。

**诚实说明**：进程内没被 `shell_env_set` 记录过的变量、以及函数定义/模块导入会丢。
这是自动重启的代价，已写进 README。

---

### P1-1　并发冷启动 → 进程 + 端口泄漏 ✅ 已修

`ensureWorker()` 里 `start()` 是异步的，这期间 `worker.alive` 仍是 false，
并发调用各自 new 一个并 spawn 一个 PowerShell，前者引用被覆盖成泄漏进程。

**复现（修复前）**：5 个并发 → 5 个 `powershell.exe` / 5 个端口，只 1 个被引用，4 个泄漏。

**修法**：三处 `ensureXxx` 全部改成**缓存启动 Promise**（不是缓存实例）；
`HttpWorker.start()` 内部也做了同样的 `_starting` 保护，双层兜底。

**验证**：`resilience.test.js` 第 4 组 —— 5 个并发只 spawn 一次；
跑完整套件后 `worker.ps1` 残留进程 = 0。

---

### P1-2　诊断器的 `retryable` 算了但没人用 ✅ 已修

README 把这条列为「这里最关键的判断」，但 `retryable` 在整个 `src/` 里
**只被生产、只被渲染成文字**，`verifier/index.js` 一次都没读它。
于是它**告诉** Agent「重试无意义」，自己**却照样无脑重试 3 遍** ——
恰好是它批评的行为，而且对有副作用的命令多跑两遍不是浪费时间的问题。

**复现（修复前）**：access-denied / cmd-not-found 都是 `retryable=false`，实际执行 3 次。

**修法**：`verifier` 循环里加判断 —— 诊断判定不可重试**且**这次没能自动修补 → 立即 `break`。
返回值加 `gaveUpEarly` 标记。

**验证**：`_probe-retryable.js` 现在两个场景都只执行 **1 次**。

---

### P1-3　诊断器把 `Administrator` 当错误签名 → 大面积误判 ✅ 已修

`access-denied` 的匹配式里有 `/Administrator/i`。它是**默认账号的用户目录名**，
是个极常见的**路径片段**，不是错误签名。

| 输入（真实报错） | 修复前 | 修复后 |
|---|---|---|
| `Could not find a part of the path 'C:\Users\Administrator\...\x.txt'` | access-denied（不可重试，无 fix） | **missing-parent**（可重试，有 fix） |
| `The term 'foo' is not recognized ... (cwd C:\Users\Administrator)` | access-denied | **cmd-not-found** |
| `Operation timed out ... C:\Users\Administrator\big.bin` | access-denied（不可重试） | **timeout**（可重试） |
| `未能找到路径"C:\Users\Administrator\a\b"的一部分` | access-denied | **missing-parent** |

原版测试没抓到，是因为用例路径都不含 `Administrator` —— 是盲区，不是已覆盖。

**修法**：删掉 `/Administrator/i`，只留精确签名 + 词边界
（`requires elevation` / `must be run as administrator` / `需要提升`）；
顺带补两条漏网的常见错误：`network-path`（网络盘不可达，**可重试**）、
`tls`（PS 5.1 默认没开 TLS 1.2，重试无用）。规则从 17 类扩到 18 类。

---

### P2-1　`$LASTEXITCODE` 跨请求残留 ✅ 已修

`$LASTEXITCODE` 在 runspace 里是持久的，而纯 PowerShell 命令**从不写它**。
一次原生命令失败，之后每条纯 PS 命令都谎报同一个退出码。

**复现（修复前）**：`cmd /c exit 3` 之后，`Write-Output` 和 `Get-Date` 都报 `exitCode=3`。

**修法**：每个 `/exec` 开头 `$global:LASTEXITCODE = 0`。
**验证**：`_probe-exitcode.js` 现在纯 PS 命令报 0，负退出码仍如实上报。

---

### P2-2　`shell_exec_verified` 不传 `expect` 也报「验证通过」 ✅ 已修

工具名承诺了验证，实际啥也没验，还告诉调用方「通过」—— Agent 会拿这个当事实。

**修法**：`verify()` 返回 `verified: false`，MCP 层改为输出
「未验证（未提供 expect，只执行未断言；已尝试 N 次）」，`isError` 与真实结果一致。

---

### P2-3　8×8 aHash 区分度不够，可能指错窗口 ✅ 已修

aHash 只记「这格比平均值亮还是暗」，梯度方向与颜色全丢。

**复现（修复前，真实索引 33 窗口 / 528 对）**：
`Data (D:) - 文件资源管理器` 与一个毫不相关的招聘网页 **64 位指纹完全相同（d=0）**；
距离 ≤10（当时的默认阈值）占 4.9%。

**修法**（三层）：

1. `perception.ps1` 换成 **dHash**（9×8 下采样 + 水平梯度，仍 64 位）；
2. `findByHash` 默认阈值 10 → **6**；
3. 支持 `findByHash(hash, { expect: { title, process } })` 交叉校验 ——
   只有标题/进程也对得上才算同一目标，返回里带 `corroborated` 标记。

**验证**：重新抓帧比对 105 对窗口，d=0 只剩 **2 对**（都是同类的扁平小窗），
98 对距离 >12 —— 分离度足够。

---

### P2-4　`verify` 全屏比对，无法归因到这次动作 ✅ 已修

全屏比对回答的是「屏幕上有没有东西变」，不是「我这个动作有没有让目标变」。
跳秒的时钟、闪烁的光标都会被算进结论；实测一次 `move` 就得到非零 `diffRatio`。

**修法**：`DiffRatio` 加 region 重载；`click` / `type` / `key` / `scroll` / `element`
全部支持 `verifyRegion: {x,y,w,h}`（通常直接传目标窗口 rect）；
返回里带 `scope: "region" | "screen"`，一眼看出这次结论的力度。

---

## 三、评审期间新发现并修掉的坑

### 新增-1　AMSI 会把整份 `perception.ps1` 判成恶意脚本 ✅ 已修

往 `Get-EncodedBitmap` 里加 JPEG 质量参数（`ImageCodecInfo::GetImageEncoders()`
配 `EncoderParameters`）之后，**整份脚本**被 Windows Defender 拒绝执行：

```
This script contains malicious content and has been blocked by your antivirus software.
```

分段测过：单独跑那一小段没事；和「截屏 + base64 + HttpListener」放在一起才触发
（组合启发式）。换成朴素的 `ImageFormat::Jpeg` 重载后正常。

**这条写进了 README 的踩坑记录** —— 以后谁想加「截屏后编码」的代码，先测 AMSI。

### 新增-2　CDP launch 复用固定 profile → 被残留实例卡死 ✅ 已修

Chromium 系对同一个 `--user-data-dir` 只允许一个实例。已有一个在跑时，
新进程会把参数转交给老实例然后自己退出 —— `--remote-debugging-port` 根本不会开，
`launch()` 只能干等到超时。上一次被中断的自动化正好会留下这样一个实例。

**修法**：默认每次启动用**一次性 profile 目录**（`~/.desktopos/cdp-<pid>-<ts>-<rand>`），
`desktop_cdp_close` 时删除；需要保留登录态可显式传 `userDataDir`。
`launch()` 失败信息也直接点明「多半是同一 user-data-dir 已有实例」。

### 新增-3　请求体无上限 ✅ 已修

`StreamReader.ReadToEnd()` 是无界的。现在 `/exec` 超 4 MB 直接 413。

---

## 四、工程细节（一并处理）

| 项 | 处理 |
|---|---|
| 版本号不一致 | `serverInfo` 改为从 `package.json` 读；包版本升到 `0.2.1` |
| 选项名不匹配导致静默失效 | `ensureWorker` 传的 `timeout: 60000` 而 `ShellWorker` 读的是 `cmdTimeout` —— 已改正（原来是完全没生效，实际仍是 30s） |
| 截断不对称 | 抽出统一 `clip()`，`shell_exec` / `shell_exec_verified` / `perceive` 都走它 |
| 截图体积 | 新增 `maxWidth` / `format:'jpeg'`，2560 宽 PNG ≈2.6 MB base64 可降到十分之一 |
| `_freePort` TOCTOU | `HttpWorker.start()` 内置最多 3 次重试（换端口重 spawn） |
| `stop()` 固定 300ms | 改为 `await` 真实 `close` 事件，最多 3s |
| 依赖范围过宽 | `^1.9.0` 实际解析到 1.32.2（拖进 express/hono/cors 共 92 个包）→ 锁 `~1.32.2`，同步更新 lock，`npm ci --dry-run` 通过 |
| 三个 worker 代码抄三遍 | 收敛成 `src/http-worker/index.js` 基类，同一个 bug 只修一处 |

---

## 五、当前状态

- `npm test`：**307 项全绿**（6 + 13 + 15 + 20 + 11 + 123 + 38 + 81）
- 跑完整套件后：残留 worker 进程 **0**、残留 CDP profile **0**、残留调试浏览器 **0**
- 所有 `.ps1` 仍为纯 ASCII（`ascii-guard` 6/6）

## 六、复现脚本

评审期的探针都在 `test/_probe-*.js`，不参与 `npm test`，可单独跑核对：

```bash
node test/_probe-auth.js        # 鉴权：跨站 / 无 token / 错 token / 正确 token
node test/_probe-wedge.js       # 卡死命令 + stop() 恢复
node test/_probe-race2.js       # 并发冷启动泄漏（比 PID）
node test/_probe-retryable.js   # retryable 是否真的接线
node test/_probe-diagnose.js    # Administrator 误判
node test/_probe-diagnose2.js   # 新增规则与回归
node test/_probe-exitcode.js    # $LASTEXITCODE 残留
node test/_probe-hash.js        # 缓存里的哈希碰撞
node test/_probe-hash2.js       # 现场抓帧的 dHash 区分度
node test/_probe-amsi.js        # AMSI 分段 bisect
node test/_probe-amsi2.js       # AMSI 组合触发点定位
```

> `_probe-wedge.js` / `_probe-race2.js` 会短暂留下卡住的 `powershell.exe`，
> 脚本末尾已 kill；若被中断，用下面这行清场：
>
> ```powershell
> Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
>   Where-Object { $_.CommandLine -like '*worker.ps1*' -and $_.CommandLine -notlike '*CimInstance*' } |
>   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> ```
