/**
 * DesktopOS MCP Server
 * 
 * 通过 MCP 协议暴露 Shell Worker 给 AI Agent 使用。
 * 注册到 DSH 后，直接能通过工具调用执行 Shell 命令（持久化会话）。
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { ShellWorker } = require('../shell-worker/index.js');
const { execWithVerify } = require('../verifier/index.js');
const { PerceptionWorker } = require('../sensor/index.js');
const { ActorWorker } = require('../actor/index.js');
const { MemoryLayer } = require('../memory/index.js');
const { Browser } = require('../cdp/index.js');
const { launch: launchBrowser, rmProfileDir } = require('../cdp/launch.js');
const { survey: surveyCdp } = require('../cdp/index.js');
const { diagnose, formatDiagnosis } = require('../diagnoser/index.js');

// 统一渲染执行层动作结果（含可选的截图比对结论），并写入记忆层
function actText(r) {
  let t = r.note || r.action || '(已执行)';
  if (r.verify) {
    const scope = r.verify.scope === 'region' ? '区域' : '全屏';
    t += `\n验证: ${r.verify.changed ? '界面有变化' : '界面无变化'}` +
         ` (diffRatio=${r.verify.diffRatio}, 比对范围=${scope})`;
  }
  try {
    ensureMemory().record('act', r.note || r.action, { verify: r.verify || null });
  } catch {}
  return t;
}

// 全局 Shell Worker 实例（单例，持久化）
let worker = null;
let workerStarting = null;
let workerReady = false;

/**
 * 单例启动。
 *
 * 关键：缓存的是**启动 Promise**，不是实例。
 * `start()` 是异步的，这段时间里 `worker.alive` 还是 false —— 只判断 alive
 * 会让并发调用各自 new 一个并 spawn 一个 PowerShell，多出来的引用被覆盖，
 * 成为再也管不到的泄漏进程（实测 5 个并发 → 5 个 powershell.exe）。
 * 并发是常态：MCP 客户端和 Agent 经常并行发工具调用。
 */
async function ensureWorker() {
  if (worker && worker.alive) return worker;
  if (workerStarting) return workerStarting;

  workerStarting = (async () => {
    worker = new ShellWorker({
      initialCwd: process.cwd(),
      cmdTimeout: 60000,
    });
    worker.on('error', (err) => {
      console.error('[ShellWorker] error:', err);
      workerReady = false;
    });
    worker.on('close', (code) => {
      console.error('[ShellWorker] closed:', code);
      workerReady = false;
    });
    await worker.start();
    workerReady = true;
    console.error('[ShellWorker] ready');
    return worker;
  })();

  try { return await workerStarting; } finally { workerStarting = null; }
}

// 感知 Worker 单例（双通道感知层）
let sensor = null;
let sensorStarting = null;
async function ensureSensor() {
  if (sensor && sensor.alive) return sensor;
  if (sensorStarting) return sensorStarting;

  sensorStarting = (async () => {
    sensor = new PerceptionWorker();
    sensor.on('error', (err) => console.error('[PerceptionWorker] error:', err));
    await sensor.start();
    console.error('[PerceptionWorker] ready');
    return sensor;
  })();

  try { return await sensorStarting; } finally { sensorStarting = null; }
}

// 执行层 Worker 单例（真实输入注入）
let actor = null;
let actorStarting = null;
async function ensureActor() {
  if (actor && actor.alive) return actor;
  if (actorStarting) return actorStarting;

  actorStarting = (async () => {
    actor = new ActorWorker();
    actor.on('error', (err) => console.error('[ActorWorker] error:', err));
    await actor.start();
    console.error('[ActorWorker] ready');
    return actor;
  })();

  try { return await actorStarting; } finally { actorStarting = null; }
}

// 记忆层（进程内单例，持久化到磁盘）
let memory = null;
function ensureMemory() {
  if (!memory) memory = new MemoryLayer();
  return memory;
}

// CDP 会话池（浏览器级连接 + 若干页面会话 + 本次启动的浏览器进程）
const cdp = {
  browser: null,      // Browser 实例
  port: null,
  sessions: new Map(),// id -> Session
  current: null,      // 当前会话 id
  seq: 0,
  proc: null,         // 由 desktop_browser_launch 启动的进程
  profileDir: null,   // 本次启动用的一次性 profile 目录（关闭时删掉）
};

function cdpSession(id) {
  const key = id || cdp.current;
  if (!key) throw new Error('还没有打开的 CDP 会话，请先调用 desktop_cdp_open');
  const s = cdp.sessions.get(key);
  if (!s) throw new Error(`CDP 会话 ${key} 不存在（可能页面已关闭）。当前会话：${[...cdp.sessions.keys()].join(', ') || '无'}`);
  return s;
}

async function cdpAttach(port) {
  if (cdp.browser && cdp.port === port) return cdp.browser;
  if (cdp.browser) { try { cdp.browser.close(); } catch {} cdp.browser = null; }
  cdp.sessions.forEach((s) => { try { s.close(); } catch {} });
  cdp.sessions.clear();
  cdp.current = null;
  cdp.browser = await Browser.attach({ port });
  cdp.port = port;
  return cdp.browser;
}

// 工具定义
const TOOLS = [
  {
    name: 'shell_exec',
    description: `在持久化 PowerShell 会话中执行命令。
核心创新：这是一个长期存活的 Shell 进程，不是每次开新进程。
效果：cd 之后目录保持、set 的环境变量保持、Python venv / node -e 等状态保持。
适用于：需要连续操作的场景（先 cd 再 git status、先激活 venv 再 pip install）。`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'shell_exec_verified',
    description: `执行命令，并用文件系统 API 独立验证结果；验证不过自动带指数退避重试（自愈雏形）。
不轻信命令自身的返回值：例如 mkdir 之后，真的去确认目录存在。
expect 支持：pathExists / pathNotExists / isDir / isFile / fileContains:[路径,内容] / cwd`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        expect: {
          type: 'object',
          description: '验证断言，如 {"isDir":"D:\\\\tmp\\\\x"} 或 {"fileContains":["D:\\\\a.txt","hello"]}'
        },
        retries: { type: 'number', description: '失败重试次数，默认 2' },
        timeout: { type: 'number', description: '单次超时毫秒，默认 30000' }
      },
      required: ['command', 'expect'],
    },
  },
  {
    name: 'shell_cd',
    description: '修改持久化会话的工作目录（cd），后续 shell_exec 都在新目录执行。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标目录路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'shell_cwd',
    description: '获取持久化会话的当前工作目录。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'shell_env_get',
    description: '获取持久化会话中的环境变量值。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境变量名' },
      },
      required: ['name'],
    },
  },
  {
    name: 'shell_env_set',
    description: '在持久化会话中设置环境变量。后续所有 shell_exec 都能读到。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境变量名' },
        value: { type: 'string', description: '变量值' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'shell_reset',
    description: '重置持久化会话（重新启动 PowerShell）。用于会话状态异常时恢复。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'desktop_list_windows',
    description: `结构通道：枚举当前所有可见窗口。
返回句柄、标题、进程名、PID、屏幕矩形、是否聚焦、是否最小化。
用它可以知道"屏幕上有什么"，以及目标窗口的位置。`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'desktop_perceive',
    description: `双通道感知 + 交叉验证（核心能力）。
结构通道枚举窗口，视觉通道对每个窗口区域采样，判断它是否真的可见、真的有内容。
返回每个窗口的一致性结论，并列出不一致原因（minimized / offscreen / blank）。
结果会自动写入记忆层，之后可用 memory_recall 按指代定位。`,
    inputSchema: {
      type: 'object',
      properties: {
        includePng: { type: 'boolean', description: '是否附带缩略图数据，默认 false' },
        maxWidth: { type: 'number', description: '图片最大宽度（像素）。不传则按原分辨率，2560 宽约 2.6MB base64' },
        format: { type: 'string', description: 'png 或 jpeg，默认 png。jpeg 体积小一个数量级' },
      },
    },
  },
  {
    name: 'desktop_screenshot',
    description: `视觉通道：截取主屏幕。返回 PNG/JPEG（base64）与尺寸。
用于看布局、颜色、图标等结构通道拿不到的信息。
需要控制消息体积时传 maxWidth（如 1280）+ format:"jpeg"。`,
    inputSchema: {
      type: 'object',
      properties: {
        includePng: { type: 'boolean', description: '是否返回图片数据，默认 true；只想拿尺寸可设 false' },
        maxWidth: { type: 'number', description: '图片最大宽度（像素）' },
        format: { type: 'string', description: 'png 或 jpeg，默认 png' },
      },
    },
  },
  {
    name: 'desktop_cursor',
    description: '读取当前鼠标光标坐标（只读，安全）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'desktop_move',
    description: '移动鼠标到指定坐标（不点击）。副作用小，可用于定位或配合 verify 观察界面反应。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        verify: { type: 'boolean', description: '是否截图比对前后变化' }
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'desktop_click',
    description: `在指定坐标点击鼠标。会真实操作你的桌面 —— 调用前请确认目标位置。
坐标可从 desktop_perceive 得到的窗口矩形推算（例如取其中心）。`,
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', description: 'left / right / middle，默认 left' },
        count: { type: 'number', description: '点击次数，2 为双击，默认 1' },
        verify: { type: 'boolean', description: '截图比对前后变化，判断是否点出了反应' },
        verifyRegion: {
          type: 'object',
          description: '只比对这块矩形（传目标窗口的 rect）。不传则比对全屏 —— 全屏会把时钟、光标闪烁等无关变化也算进来',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'desktop_type',
    description: `在当前焦点处输入文本，支持中文。
实现走剪贴板 + Ctrl+V（SendKeys 不支持 Unicode，会把中文打成乱码）。
注意：会改动你的剪贴板内容，并输入到当前焦点窗口。`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本（可为中文）' },
        verify: { type: 'boolean' },
        verifyRegion: {
          type: 'object',
          description: '只比对这块矩形（传目标窗口的 rect），不传则全屏',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        }
      },
      required: ['text'],
    },
  },
  {
    name: 'desktop_key',
    description: '发送组合键，如 ctrl+c / ctrl+v / alt+tab / enter / tab / f5。会作用于当前焦点窗口。',
    inputSchema: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: '例：ctrl+c、alt+tab、enter' },
        verify: { type: 'boolean' },
        verifyRegion: {
          type: 'object',
          description: '只比对这块矩形（传目标窗口的 rect），不传则全屏',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        }
      },
      required: ['combo'],
    },
  },
  {
    name: 'desktop_scroll',
    description: '在指定坐标滚动滚轮。delta 为负向下、正向上，通常 120 为一格。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        delta: { type: 'number', description: '默认 -120（向下一格）' },
        verify: { type: 'boolean' },
        verifyRegion: {
          type: 'object',
          description: '只比对这块矩形（传目标窗口的 rect），不传则全屏',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        }
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'desktop_focus_window',
    description: '把指定句柄的窗口切到前台（最小化时会先还原）。句柄来自 desktop_list_windows / desktop_perceive。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'number', description: '窗口句柄' },
        verify: { type: 'boolean' }
      },
      required: ['handle'],
    },
  },
  {
    name: 'desktop_elements',
    description: `元素级结构通道：枚举一个窗口内的 UI 控件（UI Automation）。
返回控件名称、类型(Button/Edit/...)、AutomationId、坐标矩形、是否可 Invoke。
适合定位"确定按钮"这类具体控件，比只按坐标猜可靠得多。
注意：Electron / Chromium 类应用默认不暴露控件树，会返回很少或 0 个
（这类需要用 CDP，即路线图 Week 5-6）。原生 Windows 应用正常。`,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'number', description: '窗口句柄，来自 desktop_list_windows / desktop_perceive' },
        maxElements: { type: 'number', description: '最多返回多少个，默认 300' }
      },
      required: ['handle'],
    },
  },
  {
    name: 'desktop_click_element',
    description: `元素级执行：按可见文本定位控件并触发它。
优先用 UI Automation 的 InvokePattern（对按钮最可靠），不支持时退回点击其中心。
会真实操作界面，调用前请确认控件名称。`,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'number', description: '窗口句柄' },
        name: { type: 'string', description: '控件文本，支持模糊匹配，如 "确定"' },
        verify: { type: 'boolean', description: '截图比对前后变化' },
        verifyRegion: {
          type: 'object',
          description: '只比对这块矩形（一般传该窗口的 rect），不传则全屏',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        }
      },
      required: ['handle', 'name'],
    },
  },
  {
    name: 'desktop_browser_launch',
    description: `启动一个"可被 CDP 调试"的浏览器实例（Edge / Chrome）。
带 --remote-debugging-port 和一次性的 --user-data-dir（不传时每个实例独立目录，
关闭时自动删除），不会抢你正在用的浏览器 profile。
端口只监听 127.0.0.1。返回端口号，之后用 desktop_cdp_open 连它。
headless=true 时不弹窗口，适合自动化；headless=false 时窗口会真的跳出来。`,
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: '是否无头，默认 false（会显示窗口）' },
        url: { type: 'string', description: '初始打开的页面，默认 about:blank' },
        browserPath: { type: 'string', description: '显式指定浏览器 exe 路径，默认自动找 Edge/Chrome' },
        userDataDir: { type: 'string', description: '显式指定 profile 目录（需要保留登录态时用）。不传则用一次性目录' },
        waitMs: { type: 'number', description: '等待 CDP 端点就绪的毫秒，默认 20000' }
      },
    },
  },
  {
    name: 'desktop_cdp_targets',
    description: `只读：扫描本机所有开放的 CDP 调试端点及其页面，不做任何修改。
用来判断"现在能不能连浏览器"。
如果为空，说明没有浏览器开调试端口 —— 用 desktop_browser_launch 启动一个。`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'desktop_cdp_open',
    description: `连上一个浏览器的页面，建立 CDP 会话（后续 cdp_* 工具都作用于它）。
可按 title / url 子串或下标选页面；带 url 时会先导航过去。
这是操作 Chromium 系应用（Chrome / Edge / Electron）的入口 ——
UIA 看不见它们的内部，CDP 能。`,
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: '调试端口；省略则自动扫描' },
        title: { type: 'string', description: '按标题子串选页面' },
        url: { type: 'string', description: '按 URL 子串选页面 / 或导航到此 URL' },
        index: { type: 'number', description: '第几个页面，默认 0' },
        navigate: { type: 'boolean', description: 'url 是否作为导航目标（true）还是筛选条件（false，默认）' }
      },
    },
  },
  {
    name: 'desktop_cdp_elements',
    description: `列出当前页面内的控件（CDP 无障碍树）。
返回角色(button/link/textbox/...)、名称、层级深度。中文名称完整保留。
已自动去重：AX 树给一个按钮同时产出 button/StaticText/InlineTextBox，这里只留能操作的那个。`,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id，省略则用当前会话' },
        role: { type: 'string', description: '按角色过滤，如 button / link / textbox' },
        limit: { type: 'number', description: '最多返回多少个，默认 120' }
      },
    },
  },
  {
    name: 'desktop_cdp_click',
    description: `按名称点击页面里的控件（走 CDP 注入真实鼠标事件）。
先定位控件矩形中心再点，所以不需要你猜坐标。同名多个时会报错并列出候选。`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '控件文本，支持模糊匹配' },
        role: { type: 'string', description: '限定角色，如 button，用于消歧' },
        session: { type: 'string', description: '会话 id，省略则用当前会话' }
      },
      required: ['name'],
    },
  },
  {
    name: 'desktop_cdp_type',
    description: `向页面输入文本。走 CDP 的 Input.insertText，
不经过键盘布局，中文 / emoji 天然无损（比 SendKeys 和剪贴板都干净）。
可用 target 先聚焦到某个输入框。`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        target: { type: 'string', description: '先聚焦到名称含此文本的控件，如 "请输入"' },
        clear: { type: 'boolean', description: '聚焦后是否先清空' },
        session: { type: 'string', description: '会话 id，省略则用当前会话' }
      },
      required: ['text'],
    },
  },
  {
    name: 'desktop_cdp_eval',
    description: `在当前页面执行 JavaScript 并返回结果（JSON 化）。
这是 CDP 相对 UIA 的杀手锏：拿不到的信息可以直接问页面要。`,
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JS 表达式或 IIFE，如 document.title' },
        awaitPromise: { type: 'boolean', description: '表达式返回 Promise 时是否等待' },
        session: { type: 'string', description: '会话 id，省略则用当前会话' }
      },
      required: ['expression'],
    },
  },
  {
    name: 'desktop_cdp_screenshot',
    description: `截取当前页面（不是整屏）。返回 PNG。
页面级截图比全屏截图更适合判断"浏览器里现在是什么状态"。`,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id，省略则用当前会话' }
      },
    },
  },
  {
    name: 'desktop_cdp_close',
    description: `关闭 CDP 会话，并杀掉由 desktop_browser_launch 启动的浏览器进程。
用完记得调用，否则无头浏览器会留在后台。`,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '只关指定会话；省略则关全部' },
        killBrowser: { type: 'boolean', description: '是否连浏览器进程一起杀，默认 true' }
      },
    },
  },
  {
    name: 'desktop_diagnose',
    description: `把一条报错文本翻译成"为什么 + 怎么办"。
任何工具返回错误时都会自动附带诊断；这个工具用于手动诊断任意一段报错。
规则匹配、毫秒级返回，不调 LLM。`,
    inputSchema: {
      type: 'object',
      properties: {
        error: { type: 'string', description: '报错原文' },
        command: { type: 'string', description: '导致它的命令（可选，用于判断能否自动修补）' },
        output: { type: 'string', description: '命令输出（可选）' }
      },
      required: ['error'],
    },
  },
  {
    name: 'memory_recall',
    description: `记忆层：把一句指代解析成可点击的坐标。
支持 "刚才那个窗口"、"钉钉"、"WorkBuddy" 这类说法，返回窗口中心坐标，
可直接拿去 desktop_click。
支持窗口级与元素级两种命中（"刚才那个按钮" 会定位到控件）。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '例如：刚才那个窗口 / 钉钉 / WorkBuddy' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_timeline',
    description: '记忆层：查看最近的操作时间线（感知/点击/输入/命令）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 20' } },
    },
  },
  {
    name: 'memory_stats',
    description: '记忆层：查看索引规模与最后更新时间。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_clear',
    description: '记忆层：清空时间线与窗口索引。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ============================================================
// 工具过滤（可选）
//
// 为什么需要这个东西：
//   主流 MCP 客户端（DSH / Claude Desktop / Cursor）只支持按**服务器**启停，
//   不支持按**工具**启停。于是当机器上同时装了多个能力重叠的服务器时
//   （比如另一个桌面自动化 + 一个浏览器自动化），模型每次调用都得猜该用哪套，
//   猜错的概率随工具数上升 —— 这是工具装多了之后真实出现的退化。
//
//   在客户端修不了，就只能在服务器侧修：给它一个 allowlist，
//   让部署方只暴露**不重叠**的那部分。
//
// 用法（两种都行，exclude 优先级更高）：
//   DESKTOPOS_TOOLS=shell,diagnose                按分组
//   DESKTOPOS_TOOLS=shell_exec,desktop_perceive   按工具名
//   DESKTOPOS_TOOLS_EXCLUDE=cdp,memory            排除分组或工具名
//
//   也可以走命令行： --only=shell,diagnose  /  --exclude=cdp
//
//   不设置就暴露全部（默认行为，也是 OSS 用户的默认体验）。
// ============================================================

const TOOL_GROUPS = {
  // 持久化 shell 会话 —— 这套东西最不可替代的部分
  shell: [
    'shell_exec', 'shell_exec_verified', 'shell_cd', 'shell_cwd',
    'shell_env_get', 'shell_env_set', 'shell_reset',
  ],
  // 桌面感知与输入
  desktop: [
    'desktop_list_windows', 'desktop_perceive', 'desktop_screenshot',
    'desktop_cursor', 'desktop_move', 'desktop_click', 'desktop_type',
    'desktop_key', 'desktop_scroll', 'desktop_focus_window',
  ],
  // 元素级（UIA）
  elements: ['desktop_elements', 'desktop_click_element'],
  // 浏览器调试协议 —— 如果已有 Playwright 这类更全的方案，这组可以关掉
  cdp: [
    'desktop_browser_launch', 'desktop_cdp_targets', 'desktop_cdp_open',
    'desktop_cdp_elements', 'desktop_cdp_click', 'desktop_cdp_type',
    'desktop_cdp_eval', 'desktop_cdp_screenshot', 'desktop_cdp_close',
  ],
  // 桌面状态记忆
  memory: ['memory_recall', 'memory_timeline', 'memory_stats', 'memory_clear'],
  // 错误诊断 —— 纯知识，几乎没有替代品
  diagnose: ['desktop_diagnose'],
};

const GROUP_OF = (() => {
  const map = new Map();
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    for (const n of names) map.set(n, group);
  }
  return map;
})();

/** 把 "shell,diagnose,shell_cd" 展开成具体工具名集合（支持分组名与工具名混写） */
function expandSelectors(spec) {
  const out = new Set();
  for (const raw of String(spec).split(',')) {
    const sel = raw.trim();
    if (!sel) continue;
    if (TOOL_GROUPS[sel]) {
      for (const n of TOOL_GROUPS[sel]) out.add(n);
    } else {
      out.add(sel); // 认不出就当工具名，后面按实际存在的工具过滤
    }
  }
  return out;
}

function readFilterSpec() {
  const argv = process.argv.slice(2);
  const fromArgv = (flag) => {
    const hit = argv.find((a) => a.startsWith(flag + '='));
    return hit ? hit.slice(flag.length + 1) : null;
  };
  return {
    only: fromArgv('--only') || process.env.DESKTOPOS_TOOLS || null,
    exclude: fromArgv('--exclude') || process.env.DESKTOPOS_TOOLS_EXCLUDE || null,
  };
}

/**
 * 按 allowlist / denylist 过滤工具表。
 * 返回 { tools, allNames, removed }
 */
function filterTools(tools) {
  const { only, exclude } = readFilterSpec();
  const allNames = tools.map((t) => t.name);
  const known = new Set(allNames);

  let keep = new Set(allNames);

  if (only) {
    const sel = expandSelectors(only);
    keep = new Set([...sel].filter((n) => known.has(n)));
    const unknown = [...sel].filter((n) => !known.has(n));
    if (unknown.length) {
      console.error('[DesktopOS MCP] --only 里这些名字/分组不存在，已忽略: ' + unknown.join(', '));
    }
  }

  if (exclude) {
    for (const n of expandSelectors(exclude)) keep.delete(n);
  }

  const kept = tools.filter((t) => keep.has(t.name));
  const removed = allNames.filter((n) => !keep.has(n));
  return { tools: kept, allNames, removed };
}

const FILTERED = filterTools(TOOLS);
const ACTIVE_TOOLS = FILTERED.tools;
const ACTIVE_NAMES = new Set(ACTIVE_TOOLS.map((t) => t.name));

if (FILTERED.removed.length) {
  console.error(
    `[DesktopOS MCP] 工具已在启动时裁剪：暴露 ${ACTIVE_TOOLS.length}/${TOOLS.length}，` +
    `未启用 ${FILTERED.removed.length} 个（${FILTERED.removed.slice(0, 8).join(', ')}` +
    `${FILTERED.removed.length > 8 ? ', ...' : ''}）。` +
    `恢复全部请去掉 DESKTOPOS_TOOLS / --only。`
  );
}

// 版本号从 package.json 读，避免握手时对外报一个和包版本不一致的号
const PKG_VERSION = (() => {
  try { return require('../../package.json').version; } catch { return '0.0.0'; }
})();

// 创建 MCP Server
const server = new Server(
  {
    name: 'desktopos',
    version: PKG_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出工具（已按 allowlist 裁剪）
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ACTIVE_TOOLS,
}));

// 调用工具
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // MCP 消息有大小限制，所有返回文本统一走这里截断 ——
  // 之前只有 shell_exec 截断，shell_exec_verified / 长诊断会把消息顶爆。
  const MAX_TEXT = 50000;
  const clip = (text) => {
    const s = String(text == null ? '' : text);
    return s.length > MAX_TEXT
      ? s.substring(0, MAX_TEXT) + `\n\n... [输出截断，共 ${s.length} 字符]`
      : s;
  };

  try {
    // 执行期也要挡：只裁 tools/list 是不够的。
    // 客户端的工具表可能是缓存/陈旧的，模型也可能记得旧名字 ——
    // 那时调用会绕过裁剪照常执行，配置看起来生效了其实没有。
    if (!ACTIVE_NAMES.has(name)) {
      const exists = TOOLS.some((t) => t.name === name);
      throw new Error(
        exists
          ? `工具 ${name} 已在启动时被裁剪（DESKTOPOS_TOOLS / --only）。` +
            `当前可用: ${[...ACTIVE_NAMES].join(', ')}`
          : `Unknown tool: ${name}`
      );
    }

    switch (name) {
      case 'shell_exec': {
        const w = await ensureWorker();
        const result = await w.exec(args.command, { timeout: args.timeout || 30000 });
        return {
          content: [{
            type: 'text',
            text: clip(result) || '(命令执行成功，无输出)',
          }],
        };
      }

      case 'shell_exec_verified': {
        const w = await ensureWorker();
        const r = await execWithVerify(w, args.command, args.expect, {
          retries: args.retries,
          timeout: args.timeout
        });
        const body = (r.detail || '') + '\n--- 命令输出 ---\n' + (r.output || '(无输出)');
        const diag = r.diagnosis
          ? '\n\n' + formatDiagnosis(r.diagnosis)
          : '';
        const healed = (r.fixes || []).length
          ? `\n\n自动修补 ${r.fixes.length} 处：\n` + r.fixes.map((f) => '  - ' + f).join('\n')
          : '';
        // 没有断言时不能对外宣称"验证通过" —— 那时什么都没验
        const headline = r.verified === false
          ? `未验证（未提供 expect，只执行未断言；已尝试 ${r.attempts} 次）`
          : (r.ok
              ? `验证通过（第 ${r.attempts} 次尝试）`
              : `验证失败（已尝试 ${r.attempts} 次）`);
        return {
          content: [{
            type: 'text',
            text: clip(`${headline}\n${body}${healed}${diag}`)
          }],
          isError: r.ok === false
        };
      }

      case 'shell_cd': {
        const w = await ensureWorker();
        const newCwd = await w.cd(args.path);
        return {
          content: [{
            type: 'text',
            text: `当前目录: ${newCwd}`,
          }],
        };
      }

      case 'shell_cwd': {
        const w = await ensureWorker();
        const cwd = await w.getCwd();
        return {
          content: [{
            type: 'text',
            text: cwd,
          }],
        };
      }

      case 'shell_env_get': {
        const w = await ensureWorker();
        const val = await w.getEnv(args.name);
        return {
          content: [{
            type: 'text',
            text: val || '(未设置)',
          }],
        };
      }

      case 'shell_env_set': {
        const w = await ensureWorker();
        await w.setEnv(args.name, args.value);
        return {
          content: [{
            type: 'text',
            text: `已设置 $env:${args.name} = ${args.value}`,
          }],
        };
      }

      case 'shell_reset': {
        // stop() 现在保证有限时间返回（先短超时尝试优雅退出，再无条件 kill），
        // 所以即便 worker 正卡在一条命令里，这里也不会挂住。
        workerStarting = null;
        if (worker) {
          await worker.stop().catch(() => {});
          worker = null;
          workerReady = false;
        }
        await ensureWorker();
        return {
          content: [{
            type: 'text',
            text: 'Shell Worker 已重置并重新启动',
          }],
        };
      }

      case 'desktop_list_windows': {
        const s = await ensureSensor();
        const r = await s.listWindows();
        const lines = r.windows.map((w) => {
          const tag = w.focused ? ' <FOCUS>' : (w.minimized ? ' [minimized]' : '');
          return `handle=${w.handle} ${w.process}(${w.pid}) ` +
                 `rect=(${w.rect.x},${w.rect.y} ${w.rect.w}x${w.rect.h})${tag}  ${w.title}`;
        });
        return {
          content: [{
            type: 'text',
            text: `屏幕 ${r.screen.w}x${r.screen.h}，可见窗口 ${r.windows.length} 个：\n` + lines.join('\n')
          }],
        };
      }

      case 'desktop_screenshot': {
        const s = await ensureSensor();
        const fmt = (args.format || 'png').toLowerCase();
        const r = await s.screenshot({
          includePng: args.includePng !== false,
          maxWidth: args.maxWidth || 0,
          format: fmt,
        });
        if (!r.pngBase64) {
          return { content: [{ type: 'text', text: `屏幕尺寸 ${r.width}x${r.height}` }] };
        }
        const kb = Math.round(Buffer.byteLength(r.pngBase64, 'base64') / 1024);
        return {
          content: [
            { type: 'text', text: `截图 ${r.width}x${r.height} (${fmt}, ${kb} KB)` },
            { type: 'image', data: r.pngBase64, mimeType: fmt === 'jpeg' || fmt === 'jpg' ? 'image/jpeg' : 'image/png' }
          ],
        };
      }

      case 'desktop_perceive': {
        const s = await ensureSensor();
        const fmt = (args.format || 'png').toLowerCase();
        const r = await s.perceive({
          includePng: !!args.includePng,
          maxWidth: args.maxWidth || 0,
          format: fmt,
        });

        // 感知结果自动进记忆层：特征索引 + 聚焦栈
        const mem = ensureMemory();
        mem.indexWindows(r.windows);
        mem.record('perceive', `感知 ${r.windows.length} 个窗口，一致 ${(r.crossValidation || {}).consistent} 个`);

        const cv = r.crossValidation || {};
        const lines = r.windows.map((w) => {
          const state = w.consistent
            ? 'OK  '
            : (w.minimized ? 'MIN ' : (w.inBounds ? 'BLK ' : 'OFF '));
          return `${state} stdDev=${String(w.stdDev).padStart(6)} ${w.process} | ${w.title}`;
        });
        const mism = (cv.mismatches || []).map((m) => `- ${m.reason}: ${m.title || m.handle}`).join('\n');
        const text =
          `屏幕 ${r.screen.w}x${r.screen.h}\n` +
          `交叉验证：共 ${cv.total} 个窗口，一致 ${cv.consistent} 个，不一致 ${(cv.mismatches || []).length} 个\n` +
          (mism ? `\n不一致明细：\n${mism}\n` : '') +
          `\n窗口明细（OK=双通道一致 / MIN=最小化 / OFF=屏幕外 / BLK=区域空白）：\n` + lines.join('\n');

        const content = [{ type: 'text', text: clip(text) }];
        if (r.pngBase64) {
          content.push({
            type: 'image', data: r.pngBase64,
            mimeType: fmt === 'jpeg' || fmt === 'jpg' ? 'image/jpeg' : 'image/png'
          });
        }
        return { content };
      }

      case 'desktop_cursor': {
        const a = await ensureActor();
        const c = await a.getCursor();
        return { content: [{ type: 'text', text: `光标位置: (${c.x}, ${c.y})` }] };
      }

      case 'desktop_move': {
        const a = await ensureActor();
        const r = await a.move(args.x, args.y, { verify: args.verify });
        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_click': {
        const a = await ensureActor();
        const r = await a.click(args.x, args.y, {
          button: args.button, count: args.count, verify: args.verify,
          verifyRegion: args.verifyRegion,
        });
        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_type': {
        const a = await ensureActor();
        const r = await a.type(args.text, { verify: args.verify, verifyRegion: args.verifyRegion });
        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_key': {
        const a = await ensureActor();
        const r = await a.key(args.combo, { verify: args.verify, verifyRegion: args.verifyRegion });
        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_scroll': {
        const a = await ensureActor();
        const r = await a.scroll(args.x, args.y, args.delta, {
          verify: args.verify, verifyRegion: args.verifyRegion,
        });
        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_focus_window': {
        const a = await ensureActor();
        const r = await a.focus(args.handle, { verify: args.verify });
        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_elements': {
        const s = await ensureSensor();
        const r = await s.elements(args.handle, { maxElements: args.maxElements });

        // 元素进记忆层，供之后 "那个确定按钮" 这类指代定位
        const mem = ensureMemory();
        const win = mem.data.windows.find((w) => w.handle === args.handle) || {};
        mem.indexElements({ handle: args.handle, title: win.title, process: win.process }, r.elements);
        mem.record('elements', `枚举 ${r.count} 个控件 (handle=${args.handle})`);

        if (!r.count) {
          return {
            content: [{
              type: 'text',
              text: '未枚举到控件。可能原因：该应用不暴露 UI Automation 控件树' +
                    '（Electron/Chromium 常见），或窗口内确实没有带名称的控件。'
            }]
          };
        }
        const lines = r.elements.map((e) =>
          `${(e.type || '?').padEnd(10)}${e.canInvoke ? '[I]' : '   '}` +
          `${e.offscreen ? '(off) ' : ''}(${e.rect.x},${e.rect.y} ${e.rect.w}x${e.rect.h})  ${e.name}`
        );
        return {
          content: [{
            type: 'text',
            text: `控件 ${r.count} 个（[I]=可Invoke）：\n` + lines.join('\n')
          }]
        };
      }

      case 'desktop_click_element': {
        const a = await ensureActor();
        const r = await a.element(args.handle, args.name, {
          verify: args.verify, verifyRegion: args.verifyRegion,
        });

        // 记录这次交互，"刚才那个按钮" 就靠它
        const mem = ensureMemory();
        const el = mem.data.elements.find(
          (e) => e.name && e.name.includes(args.name) && e.windowHandle === args.handle
        );
        mem.recordInteraction(el || { name: args.name, windowHandle: args.handle }, 'click');

        return { content: [{ type: 'text', text: actText(r) }] };
      }

      case 'desktop_browser_launch': {
        if (cdp.proc) {
          try { cdp.proc.kill(); } catch {}
          cdp.proc = null;
        }
        // 上一次启动的临时 profile 一并清掉，别把 ~/.desktopos 越堆越大
        if (cdp.profileDir) {
          try { rmProfileDir(cdp.profileDir); } catch {}
          cdp.profileDir = null;
        }
        const r = await launchBrowser({
          headless: !!args.headless,
          url: args.url || 'about:blank',
          browserPath: args.browserPath,
          userDataDir: args.userDataDir,
          waitMs: args.waitMs || 20000,
        });
        cdp.proc = r.proc;
        cdp.profileDir = args.userDataDir ? null : r.profileDir;
        return {
          content: [{
            type: 'text',
            text: `已启动 ${r.browser.name}（端口 ${r.port}，${args.headless ? '无头' : '有窗口'}）\n` +
                  `浏览器: ${r.browser.path}\n` +
                  `profile: ${r.profileDir}\n` +
                  `下一步：desktop_cdp_open { port: ${r.port}${args.url ? '' : ', url: "<目标网址>"' } }`
          }]
        };
      }

      case 'desktop_cdp_targets': {
        const list = await surveyCdp();
        if (!list.length) {
          return {
            content: [{
              type: 'text',
              text: '没有发现任何 CDP 端点（本机浏览器都没开调试端口）。\n' +
                    '下一步：desktop_browser_launch { headless: false, url: "https://..." }'
            }]
          };
        }
        const lines = [];
        for (const e of list) {
          lines.push(`port ${e.port}  ${e.browser}`);
          e.pages.forEach((p) => lines.push(`   - ${p.title || '(无标题)'} | ${p.url}`));
        }
        const live = cdp.current ? `\n当前会话: ${cdp.current}` : '';
        return { content: [{ type: 'text', text: lines.join('\n') + live }] };
      }

      case 'desktop_cdp_open': {
        const browser = await cdpAttach(args.port || null);
        // navigate=true 时 url 是导航目标；否则 url/title 是筛选条件
        const filter = args.navigate ? {} : { title: args.title, url: args.url };
        const s = await browser.open({ ...filter, index: args.index || 0 });
        if (args.navigate && args.url) {
          await s.navigate(args.url);
          await new Promise((r) => setTimeout(r, 300));
        }
        const id = 's' + (++cdp.seq);
        cdp.sessions.set(id, s);
        cdp.current = id;
        const where = await s.where();
        ensureMemory().record('cdp', `打开页面 ${where.title || '(无标题)'} port=${cdp.port}`);
        return {
          content: [{
            type: 'text',
            text: `会话 ${id} 已就绪（port ${cdp.port}）\n` +
                  `标题: ${where.title || '(无标题)'}\n` +
                  `URL : ${where.url}\n` +
                  `下一步：desktop_cdp_elements { session: "${id}" }`
          }]
        };
      }

      case 'desktop_cdp_elements': {
        const s = cdpSession(args.session);
        const els = await s.elements({
          role: args.role,
          limit: args.limit || 120,
        });
        const lines = els.map((e) =>
          `[${e.role}] ${e.name}${e.value ? ' = ' + e.value : ''}   (depth ${e.depth})`
        );
        return {
          content: [{
            type: 'text',
            text: `控件 ${els.length} 个：\n` + lines.join('\n')
          }]
        };
      }

      case 'desktop_cdp_click': {
        const s = cdpSession(args.session);
        const r = await s.click(args.name, { role: args.role });
        ensureMemory().record('cdp', `点击 [${r.role}] ${r.name} @ (${r.x},${r.y})`);
        return {
          content: [{
            type: 'text',
            text: `已点击 [${r.role}] ${r.name} @ (${r.x}, ${r.y})`
          }]
        };
      }

      case 'desktop_cdp_type': {
        const s = cdpSession(args.session);
        const r = await s.type(args.text, { target: args.target, clear: !!args.clear });
        ensureMemory().record('cdp', `输入 "${args.text}" -> ${r.target}`);
        return { content: [{ type: 'text', text: `已输入 "${args.text}" -> ${r.target}` }] };
      }

      case 'desktop_cdp_eval': {
        const s = cdpSession(args.session);
        const v = await s.eval(args.expression, { awaitPromise: !!args.awaitPromise });
        const text = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
        return { content: [{ type: 'text', text: text === undefined ? '(undefined)' : String(text) }] };
      }

      case 'desktop_cdp_screenshot': {
        const s = cdpSession(args.session);
        const shot = await s.screenshot();
        return {
          content: [{ type: 'image', data: shot.base64, mimeType: shot.mime }]
        };
      }

      case 'desktop_cdp_close': {
        let closed = 0;
        if (args.session) {
          const s = cdp.sessions.get(args.session);
          if (s) { try { await s.close(); } catch {} cdp.sessions.delete(args.session); closed++; }
          if (cdp.current === args.session) cdp.current = null;
        } else {
          for (const [id, s] of cdp.sessions) { try { await s.close(); } catch {} closed++; cdp.sessions.delete(id); }
          cdp.current = null;
        }
        let killed = false;
        if (args.killBrowser !== false && cdp.proc) {
          try { cdp.proc.kill(); killed = true; } catch {}
          cdp.proc = null;
        }
        if (args.killBrowser !== false && cdp.browser) {
          try { cdp.browser.close(); } catch {}
          cdp.browser = null;
          cdp.port = null;
        }
        // 一次性 profile 目录用完即删（否则每次启动都留一份在 ~/.desktopos 下）
        if (args.killBrowser !== false && cdp.profileDir) {
          await new Promise((r) => setTimeout(r, 300)); // 给进程一点退出时间，否则文件占用删不掉
          try { rmProfileDir(cdp.profileDir); } catch {}
          cdp.profileDir = null;
        }
        return {
          content: [{ type: 'text', text: `已关闭 ${closed} 个会话${killed ? '，浏览器进程已终止' : ''}` }]
        };
      }

      case 'desktop_diagnose': {
        const d = diagnose({
          error: args.error,
          output: args.output,
          command: args.command,
        });
        return { content: [{ type: 'text', text: formatDiagnosis(d) }] };
      }

      case 'memory_recall': {
        const m = ensureMemory();
        const r = m.resolve(args.query);
        if (!r.found) {
          return { content: [{ type: 'text', text: `未定位到目标：${r.reason}${r.hint ? '\n' + r.hint : ''}` }], isError: true };
        }
        if (r.level === 'element') {
          return {
            content: [{
              type: 'text',
              text: `定位到控件：「${r.name}」[${r.type || '?'}]\n` +
                    `坐标: (${r.x}, ${r.y})   所属窗口句柄: ${r.windowHandle}\n` +
                    `依据: ${r.reason}\n` +
                    `下一步：desktop_click_element { handle: ${r.windowHandle}, name: "${r.name}" }\n` +
                    `（或用 desktop_click { x: ${r.x}, y: ${r.y} } 直接点坐标）`
            }]
          };
        }
        return {
          content: [{
            type: 'text',
            text: `定位到窗口：${r.title || '(无标题)'} [${r.process}]\n` +
                  `坐标: (${r.x}, ${r.y})   句柄: ${r.handle}\n` +
                  `矩形: (${r.rect.x},${r.rect.y}) ${r.rect.w}x${r.rect.h}\n` +
                  `依据: ${r.reason}\n` +
                  `接下来可调用 desktop_click { x: ${r.x}, y: ${r.y}, verify: true }`
          }]
        };
      }

      case 'memory_timeline': {
        const m = ensureMemory();
        const tl = m.timeline(args.limit || 20);
        if (!tl.length) return { content: [{ type: 'text', text: '时间线为空' }] };
        return {
          content: [{ type: 'text', text: tl.map((e) => `${e.time}  [${e.type}]  ${e.summary}`).join('\n') }]
        };
      }

      case 'memory_stats': {
        const m = ensureMemory();
        const s = m.stats();
        return {
          content: [{
            type: 'text',
            text: `操作日志 ${s.timeline} 条\n窗口索引 ${s.windows} 个\n` +
                  `聚焦栈 ${s.focusStack} 条\n最后索引: ${s.lastIndexAt || '从未'}\n存储: ${s.file}`
          }]
        };
      }

      case 'memory_clear': {
        const m = ensureMemory();
        m.clear();
        return { content: [{ type: 'text', text: '记忆已清空' }] };
      }

      default:
        // 正常走不到这里：上面已有 ACTIVE_NAMES 守卫
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // 任何工具报错都顺手诊断一次 —— "为什么失败 + 下一步"比光一条报错有用得多
    const d = diagnose({ error: err.message, command: name });
    let text = `错误: ${err.message}`;
    if (d.category !== 'unknown') text += '\n\n' + formatDiagnosis(d);
    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }
});

// 启动
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[DesktopOS MCP] 已启动 (stdio transport)');
}

main().catch((err) => {
  console.error('[DesktopOS MCP] fatal:', err);
  process.exit(1);
});
