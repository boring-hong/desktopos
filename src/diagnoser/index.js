/**
 * 错误诊断器（自愈的大脑）
 *
 * 之前的自愈只有半截：执行 → 验证 → 重试。
 * 但「重试」对大多数失败毫无意义 —— 命令写错了，再跑十次还是错。
 * 缺的是中间那步：**搞清为什么失败，并给出可执行的下一步**。
 *
 * 这一层把一条报错文本归类，产出：
 *   category    失败类别
 *   reason      人话解释
 *   hint        可行动的提示（给 Agent 看）
 *   suggestion  具体下一步（命令 / 工具调用）
 *   retryable   原样重试有没有意义
 *   fix         能自动修的话，给出修补命令（调用方决定是否执行）
 *
 * 刻意做成纯规则 + 字符串匹配，不接 LLM：
 * 诊断必须在毫秒级完成，而且要可测试、可回归。
 */

const fs = require('fs');

/** 从报错文本里抠出看起来像路径的片段 */
function extractPaths(text) {
  const out = [];
  // PowerShell 中文报错用全角引号 “ ”，英文用 ' 或 " —— 三种都得认
  const quoted = [
    ...String(text).matchAll(/[\u201C"']([^\u201D\u201C"'\r\n]{2,300})[\u201D"']/g),
    ...String(text).matchAll(/['"]([^'"\r\n]{2,300})['"]/g),
  ].map((m) => m[1]);
  const bare = [...String(text).matchAll(/[A-Za-z]:\\[^\s\u201C\u201D'"|,;)\]]+/g)].map((m) => m[0]);
  for (const s of [...quoted, ...bare]) {
    if (/[:\\/]/.test(s) && !out.includes(s)) out.push(s.replace(/[\\/]+$/, ''));
  }
  return out;
}

function parentOf(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : null;
}

// 会把内容写到某个路径的命令 —— 只有它们的"父目录缺失"才值得自动补建
const CREATING_VERBS = /New-Item|mkdir|ni\s|\bmd\b|Copy-Item|Move-Item|Out-File|Set-Content|Add-Content|WriteAllText|Export-|SaveAs/i;

/**
 * 规则表。顺序即优先级 —— 越靠前越具体。
 * match: 正则；build(ctx) 返回 { reason, hint, suggestion, fix }
 */
const RULES = [
  {
    id: 'encoding',
    retryable: false,
    match: /\uFFFD|锟斤拷|Cannot index into a null array|0x[0-9A-F]{4}.*\uFFFD/i,
    build: () => ({
      reason: '输出里出现 U+FFFD 替换字符 —— 典型的控制台编码损坏（CP936/GB2312 解码了 UTF-8）。',
      hint: '不要把中文直接写进命令字符串。路径走 shell_cd（底层 base64 传输），内容用 shell_env_set 传。',
      suggestion: "shell_cd { path: '<中文路径>' }",
    }),
  },
  {
    id: 'file-locked',
    retryable: true,
    match: /being used by another process|正由另一进程使用|无法访问文件.*它正被|Sharing violation/i,
    build: (ctx) => {
      const p = ctx.paths[0] || '<文件>';
      return {
        reason: `文件被其他进程占用：${p}`,
        hint: '重试可能有效（占用是临时的）。若持续失败，先关掉打开它的程序（Excel / Word / 编辑器最常见）。',
        suggestion: `Get-Process | Where-Object { $_.Path -like '*${p.split(/[\\/]/).pop()}*' }`,
      };
    },
  },
  {
    id: 'network-path',
    retryable: true,
    // 网络盘 / UNC 路径不可达。极常见，且真的值得重试（掉线、VPN 未连、对端重启）。
    match: /The network path was not found|找不到网络路径|The network name cannot be found|找不到网络名|network path is unavailable|Multiple connections to a server/i,
    build: (ctx) => {
      const p = ctx.paths[0];
      return {
        reason: `网络路径不可达${p ? '：' + p : ''}`,
        hint: '重试是有意义的（对端可能只是暂时掉线）。持续失败时确认 VPN / 网络盘是否已连接。',
        suggestion: 'Test-Path \\\\<主机>\\<共享名>',
      };
    },
  },
  {
    id: 'tls',
    retryable: false,
    // PowerShell 5.1 默认还是 TLS 1.0/1.1，访问现代站点必挂。改配置才有用，重试无用。
    match: /Could not create SSL\/TLS secure channel|SSL\/TLS|基础连接已经关闭|The underlying connection was closed/i,
    build: () => ({
      reason: 'TLS 协商失败 —— PowerShell 5.1 默认没有启用 TLS 1.2。',
      hint: '重试没有意义，得先把当前进程的 SecurityProtocol 提上去。',
      suggestion: '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    }),
  },
  {
    id: 'access-denied',
    retryable: false,
    // 注意：这里刻意**不含** `Administrator`。
    // 它是个路径片段（默认账号的用户目录 C:\Users\Administrator\...），不是错误签名。
    // 混进来会让任何提到该路径的报错都被判成权限不足 —— 包括本该自动补建父目录的
    // missing-parent、本该重试的 timeout，全都会被压成"不可重试"。
    match: /Access is denied|拒绝访问|UnauthorizedAccessException|权限不足|requires elevation|elevated privileges|must be run as administrator|需要提升|管理员权限/i,
    build: (ctx) => {
      const p = ctx.paths[0];
      return {
        reason: `权限不足${p ? '：' + p : ''}`,
        hint: '重试没有意义。要么换个有权限的目标（用户目录下），要么需要提权 —— 本桥不代你提权。',
        suggestion: p ? `icacls "${p}"` : '改用 $env:USERPROFILE 下的路径',
      };
    },
  },
  {
    id: 'cmd-not-found',
    retryable: false,
    match: /is not recognized as|a cmdlet, function|CommandNotFoundException|不是 cmdlet|无法将“.*”项识别为/i,
    build: (ctx) => {
      const m = String(ctx.text).match(/['"]([A-Za-z0-9_\\\-.:]+)['"]\s*(?=项识别|is not recognized)/)
             || String(ctx.text).match(/The term\s+'([^']+)'/i);
      const name = (m && m[1]) || '<命令>';
      return {
        reason: `命令不存在：${name}`,
        hint: '重试没有意义。可能是拼写错误、没装、或需要 Import-Module / 加到 PATH。',
        suggestion: `Get-Command ${name} -ErrorAction SilentlyContinue; $env:PATH -split ';'`,
      };
    },
  },
  {
    id: 'ambiguous-element',
    retryable: false,
    match: /匹配到 \d+ 个|匹配到\d+个控件/,
    build: () => ({
      reason: '控件名称歧义 —— 页面上不止一个控件匹配这个名字。',
      hint: '用 role 限定角色（button / link / textbox），或换更精确的名称。',
      suggestion: 'desktop_cdp_click { name: "<更精确>", role: "button" }',
    }),
  },
  {
    id: 'element-not-found',
    retryable: true,
    match: /element not found|找不到名称包含|页面上找不到名称|控件不存在|no such element/i,
    build: () => ({
      reason: '找不到目标控件。页面可能还没加载完，或名称已经变了。',
      hint: '先列一遍实际存在的控件再点，别猜名字。可能只是需要等一下。',
      suggestion: 'desktop_cdp_elements {} 或 desktop_elements { handle: <句柄> }',
    }),
  },
  {
    id: 'window-minimized',
    retryable: false,
    match: /最小化状态|处于最小化|minimized/i,
    build: () => ({
      reason: '目标窗口存在，但当前是最小化的 —— 拿不到可点击的坐标。',
      hint: '先还原窗口再操作。直接重试不会让它自己弹出来。',
      suggestion: 'desktop_focus_window { handle: <句柄> }',
    }),
  },
  {
    id: 'cdp-unavailable',
    retryable: false,
    match: /没有发现任何 CDP 端点|没有 CDP 端点|CDP 连接失败|CDP 连接超时|端口 \d+ 上没有 CDP/i,
    build: () => ({
      reason: '没有可连的浏览器调试端点 —— 浏览器默认不暴露 CDP。',
      hint: '必须启动一个带 --remote-debugging-port 的实例。',
      suggestion: 'desktop_browser_launch { headless: false, url: "<网址>" }',
    }),
  },
  {
    id: 'uia-unavailable',
    retryable: false,
    match: /不暴露 UI Automation|未枚举到控件|枚举到 0 个控件/i,
    build: () => ({
      reason: '该应用不暴露 UI Automation 控件树（Electron / Chromium 类常见）。',
      hint: 'UIA 这条路对它走不通。如果它是浏览器，改用 CDP。',
      suggestion: 'desktop_browser_launch {} → desktop_cdp_open {}',
    }),
  },
  {
    id: 'invalid-handle',
    retryable: false,
    match: /FromHandle|无法识别的错误|句柄.*无效|Invalid window handle|handle is not valid/i,
    build: () => ({
      reason: '窗口句柄失效 —— 窗口可能已关闭，或者这个句柄压根不存在。',
      hint: '句柄是一次性的：窗口关掉再开就是新句柄。别复用旧句柄，重新列一次窗口。',
      suggestion: 'desktop_list_windows {}（找 handle=<n>）',
    }),
  },
  {
    id: 'already-exists',
    retryable: false,
    match: /already exists|已存在|An item with the specified name/i,
    build: (ctx) => {
      const p = ctx.paths[0] || '<目标>';
      return {
        reason: `目标已存在：${p}`,
        hint: '这通常不算真失败。要幂等就加 -Force；要判断是否存在就先用 Test-Path。',
        suggestion: `Test-Path '${p}'`,
        fix: /New-Item|mkdir|New-Item/.test(ctx.command || '') && !/-Force/.test(ctx.command || '')
          ? ctx.command.replace(/\s*\|.*$/, '') + ' -Force'
          : null,
      };
    },
  },
  {
    id: 'missing-parent',
    retryable: true,
    // 中文版是"未能找到路径…的一部分"，英文版是"Could not find a part of the path"
    match: /Cannot find path|找不到路径|未能找到路径|Could not find a part of the path|Could not find part|does not exist|不存在/i,
    build: (ctx) => {
      const p = ctx.paths[0];
      const parent = p ? parentOf(p) : null;
      // 只有父目录真的不存在才算这一类 —— 否则就是"目标本身不存在"，补建目录毫无意义
      if (parent && !fs.existsSync(parent)) {
        // 而且只有命令本身就是要"造东西"时才自动补建。
        // 对 Get-ChildItem 这类读命令去建目录，等于凭空造路径 —— 那不是自愈，是胡来。
        const creates = CREATING_VERBS.test(ctx.command || '');
        return {
          reason: `父目录不存在：${parent}`,
          hint: creates
            ? 'Windows 的 New-Item / 复制不会递归建父目录，这是最常见的"明明只是少一层"的失败。'
            : '这是一条读取命令 —— 路径本身就不存在，补建目录只会造出一个假路径。先确认路径对不对。',
          suggestion: `New-Item -ItemType Directory -Path '${parent}' -Force`,
          fix: creates ? `New-Item -ItemType Directory -Path '${parent}' -Force | Out-Null` : null,
        };
      }
      return {
        reason: `路径不存在${p ? '：' + p : ''}`,
        hint: '确认路径是否写对（含中文路径请用 shell_cd，别把中文裸写进命令）。',
        suggestion: p ? `Test-Path '${p}'` : "Test-Path '<路径>'",
      };
    },
  },
  {
    id: 'param-error',
    retryable: false,
    match: /A parameter cannot be found|找不到接受参数|Cannot bind|无法绑定参数|Missing an argument/i,
    build: (ctx) => {
      const m = String(ctx.text).match(/parameter\s+'?([A-Za-z0-9]+)'?/i)
             || String(ctx.text).match(/参数[“"']?([A-Za-z0-9]+)/);
      const p = m ? m[1] : '<参数>';
      return {
        reason: `参数不对：${p}`,
        hint: '重试没有意义 —— 参数名或参数值写错了。',
        suggestion: `Get-Help ${(ctx.command || '').split(/\s+/)[0] || '<命令>'} -Parameter ${p}`,
      };
    },
  },
  {
    id: 'type-convert',
    retryable: false,
    match: /Cannot convert|无法将.*转换|Cannot process argument transformation/i,
    build: () => ({
      reason: '类型转换失败 —— 传给参数的值类型不对。',
      hint: '检查是不是把数组/对象传给了只要字符串的参数。',
      suggestion: '把值显式转成字符串： [string]$x',
    }),
  },
  {
    id: 'syntax',
    retryable: false,
    match: /Unexpected token|意外的标记|Missing (closing|')|语法错误|ParserError/i,
    build: () => ({
      reason: 'PowerShell 语法错误（多半是引号没闭合，或中文引号被混进去了）。',
      hint: '检查命令里的引号配对。注意中文全角引号 “ ” 在 PowerShell 里不是合法引号。',
      suggestion: '改用单引号，且确保成对',
    }),
  },
  {
    id: 'timeout',
    retryable: true,
    match: /超时|timed out|timeout/i,
    build: (ctx) => ({
      reason: `操作超时${ctx.command ? '：' + ctx.command.slice(0, 60) : ''}`,
      hint: '可能是命令本身太慢，也可能是它在等输入（卡在确认提示上）。后者重试只会再卡一次。',
      suggestion: '给命令加 -Confirm:$false / | Out-Null，或调大 timeout',
    }),
  },
];

/**
 * 诊断一条失败。
 * @param {object} input { error, output, command, expect, layer }
 * @returns { category, reason, hint, suggestion, retryable, fix, matched }
 */
function diagnose(input = {}) {
  const error = input.error || '';
  const output = input.output || '';
  const command = input.command || '';
  // 报错信息优先，命令输出兜底
  const text = [error, output].filter(Boolean).join('\n');

  if (!text.trim()) {
    return {
      category: 'unknown',
      reason: '没有拿到任何错误信息',
      hint: '拿不到报错就无法诊断。先确认命令真的执行了（用 shell_exec 单独跑一次看输出）。',
      suggestion: 'shell_exec { command: "<原命令>" }',
      retryable: true,
      fix: null,
      matched: null,
    };
  }

  const ctx = { text, error, output, command, paths: extractPaths(text) };

  for (const rule of RULES) {
    if (rule.match.test(text)) {
      const r = rule.build(ctx) || {};
      return {
        category: rule.id,
        reason: r.reason || '',
        hint: r.hint || '',
        suggestion: r.suggestion || '',
        retryable: rule.retryable,
        fix: r.fix || null,
        matched: rule.id,
      };
    }
  }

  return {
    category: 'unknown',
    reason: '未能归类：' + text.trim().split('\n')[0].slice(0, 120),
    hint: '这条错误不在已知规则里。原样重试一次通常也不亏；若反复出现，把报错原文发出来扩充规则表。',
    suggestion: '',
    retryable: true,
    fix: null,
    matched: null,
  };
}

/** 把诊断结果渲染成给 Agent 看的一段文本 */
function formatDiagnosis(d) {
  const lines = [`诊断: ${d.category}${d.retryable ? '' : '（原样重试无意义）'}`];
  if (d.reason) lines.push(`原因: ${d.reason}`);
  if (d.hint) lines.push(`建议: ${d.hint}`);
  if (d.suggestion) lines.push(`下一步: ${d.suggestion}`);
  if (d.fix) lines.push(`可自动修补: ${d.fix}`);
  return lines.join('\n');
}

module.exports = { diagnose, formatDiagnosis, extractPaths, RULES };
