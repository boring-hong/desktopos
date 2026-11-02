# DesktopOS 五分钟上手（可复制模板）

给第一次接触这个工具的同事。**照着做，五分钟内能跑出第一条命令。**

---

## 0. 前提

- Windows 10 / 11
- Node.js **≥ 22**（`node -v` 确认；22 起自带 WebSocket，不用额外装依赖）
- 一个支持 MCP 的客户端：DSH / Claude Desktop / Cursor 都行

---

## 1. 拿到代码

```bash
git clone https://github.com/boring-hong/desktopos.git
cd desktopos
npm ci
```

> `npm ci` 会按 `package-lock.json` 还原依赖；不要用 `npm install`，那会改写锁文件。

---

## 2. 自检（可选，但建议跑）

```bash
npm test
```

看到各段「结果：通过 N / 失败 0」就说明这台机器能跑。
真实桌面相关的几项（截屏、鼠标坐标、起浏览器）需要交互式会话，远程/服务账号下可能 SKIP，不算失败。

---

## 3. 注册到客户端

把下面这段合并进你的 MCP 配置文件，**把 `<项目路径>` 换成第 1 步 clone 下来的真实路径**（用正斜杠可以避开 JSON 反斜杠转义）：

```json
{
  "mcpServers": {
    "desktopos": {
      "type": "stdio",
      "command": "node",
      "args": ["<项目路径>/src/mcp-server/index.js"],
      "cwd": "<项目路径>"
    }
  }
}
```

配置文件位置按你的客户端选一个：

| 客户端 | 路径 |
|---|---|
| DSH（新版） | `C:\Users\<你>\.dsh\dsh-mcp-manager.json` |
| DSH（旧版 / qwenworkcn） | `C:\Users\<你>\.qwenworkcn\mcp.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` |

哪个文件已存在就改哪个。改完重启客户端。

> 完整可复制版本见 [`examples/mcp-config.json`](../examples/mcp-config.json)。

---

## 4. 一分钟验证

在客户端里依次发这三句，看返回：

**① 会话是持久的**（这是它和「每调一次开一个新进程」的根本区别）

```
shell_cd   path: E:\Boring hong\Documents\代码\desktopos
shell_exec command: Write-Output (Get-Location).Path
```

第二次调用不回退到默认目录，说明 `cd` 记住了。

**② 中文路径不坏**

```
shell_cd path: <任意含中文的目录>
```

返回的目录和传入的一致，没有 `???` 或乱码。

**③ 出错会告诉你为什么**

```
desktop_diagnose error: New-Item : 未能找到路径"C:\a\b"的一部分。
```

它会回「父目录不存在 + 该建哪个目录 + 能否自动修」。

---

## 5. 它到底能干什么

| 场景 | 一句话 |
|---|---|
| **连续命令行作业** | `cd` 进项目 → 激活 venv → 装依赖 → 跑测试，中途状态不丢，不用每次拼绝对路径 |
| **看屏幕并确认动作生效** | 带 `verify` 的点击会前后截屏比对，并告诉你变化发生在**全屏**还是**你指定的窗口区域** |
| **点界面上的按钮** | 按控件文字定位（UIA InvokePattern），拿不到才回落到点中心 |
| **操作 Electron / 浏览器内部** | UIA 看不见 Chromium 系应用的内部，走 CDP |
| **失败自愈** | `shell_exec_verified` 执行后**独立验证**结果，失败先诊断，能自动修的先修再重试 |

典型闭环：

```
shell_cd            → 进到工作目录
shell_exec_verified → 执行 + 验证，不轻信返回值
desktop_perceive    → 哪些窗口真的可见（不是"系统说可见"）
desktop_click       → 点它，并在那个窗口范围内比对变化
```

---

## 6. 只想用一部分能力？

机器上已经有别的桌面自动化/浏览器自动化时，把重叠的部分裁掉，不要让模型自己猜该用哪套：

```bash
# 只要持久化 shell + 诊断（最适合"我已有桌面自动化"的情况）
DESKTOPOS_TOOLS=shell,diagnose node src/mcp-server/index.js

# 已有 Playwright → 整组 CDP 可以关
DESKTOPOS_TOOLS_EXCLUDE=cdp,memory
```

分组：`shell` / `desktop` / `elements` / `cdp` / `memory` / `diagnose`。
详见 README「按需裁剪工具面」。

---

## 7. 已知限制（别踩）

| 限制 | 说明 |
|---|---|
| Electron / Chromium 对 UIA 是瞎的 | 钉钉、VS Code、Chrome 这类应用枚举不出控件，必须走 CDP |
| CDP 要求浏览器带调试端口启动 | 无法凭空附到你已经开着的浏览器实例 |
| 点击和输入是真的 | 会抢焦点、真的点到东西，没有 undo |
| 不代你提权 | 需要管理员权限的操作只提示，不自动提权 |
| 仅 Windows | 仅测过 PowerShell 5.1 |

---

## 8. 出问题先看这里

| 现象 | 处理 |
|---|---|
| 客户端里看不到工具 | 重启客户端；确认 ``cwd`` 路径存在；看客户端 MCP 日志里的 ``[DesktopOS MCP]`` 行 |
| 命令一直超时 | 会话被卡住的交互式命令占住了。它会自动重启并重放 `cwd`/环境变量；连续失败就调 `shell_reset` |
| 中文变成 `???` | 说明在用旧的 stdin 方案或自己拼了命令字符串。路径一律走 `shell_cd`，别把中文裸写进命令 |
| 截图很大拖慢对话 | 加 `maxWidth: 1280, format: "jpeg"`，体积能降一个数量级 |

---

底子在这：`docs/REVIEW.md`（评审导览，15 分钟判断靠不靠谱）· `docs/REVIEW-LEAD.md`（独立评审与修复记录）。
