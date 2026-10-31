#!/usr/bin/env node
/**
 * MCP 工具重叠审计
 *
 * 解决的问题：机器上装了多个 MCP 服务器之后，能力重叠会让模型在调用时反复犹豫、
 * 更容易选错。而主流客户端只支持按**服务器**启停，没有工具级开关 ——
 * 所以重叠要么在服务器内部裁掉（见 src/mcp-server 的 DESKTOPOS_TOOLS），
 * 要么就得一直靠人记着「这个该用哪个」。
 *
 * 这个脚本把「重叠」从感觉变成数字：连上每个已配置的 MCP 服务器，
 * 拉一遍 tools/list，然后按名字与描述的相似度找出跨服务器的近重复工具。
 *
 * 用法：
 *   node scripts/overlap-audit.js                 # 读 dsh-mcp-manager 配置
 *   node scripts/overlap-audit.js --config <path>
 *   node scripts/overlap-audit.js --json          # 机器可读
 *
 * 输出里每个「疑似重复」都给出建议：留哪个、裁哪个。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 配置 ----------

function defaultConfigPaths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return [
    path.join(home, 'dsh-mcp-manager.json'),
    path.join(os.homedir(), '.dsh', 'dsh-mcp-manager.json'),
    path.join(os.homedir(), '.qwenworkcn', 'mcp.json'),
  ];
}

function loadServers(configPath) {
  const candidates = configPath ? [configPath] : defaultConfigPaths();
  const hit = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('找不到 MCP 配置。用 --config <path> 指定。');

  const raw = JSON.parse(fs.readFileSync(hit, 'utf8'));
  let servers = [];

  if (Array.isArray(raw.servers)) {
    // dsh-mcp-manager 格式
    servers = raw.servers
      .filter((s) => s.enabled !== false && s.transport === 'stdio' && s.command)
      .map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args || [],
        env: { ...process.env, ...(s.env || {}) },
        cwd: s.cwd || undefined,
      }));
  } else if (raw.mcpServers) {
    // Claude Desktop / Cursor 格式
    servers = Object.entries(raw.mcpServers)
      .filter(([, v]) => v && v.command)
      .map(([name, v]) => ({
        name,
        command: v.command,
        args: v.args || [],
        env: { ...process.env, ...(v.env || {}) },
        cwd: v.cwd || undefined,
      }));
  }

  return { configPath: hit, servers };
}

// ---------- 极简 MCP 客户端（只做 initialize + tools/list） ----------

function listTools(server, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let proc;
    // Windows 上 npx/npm/yarn/pnpm 是 .cmd 包装，直接 spawn 会 ENOENT，要经 cmd /c
    const needsCmdShell = process.platform === 'win32'
      && /^(npx|npm|yarn|pnpm|uvx|uv)$/i.test(path.basename(String(server.command)).replace(/\.(cmd|bat|exe)$/i, ''));
    const cmd = needsCmdShell ? 'cmd.exe' : server.command;
    const args = needsCmdShell ? ['/c', server.command, ...server.args] : server.args;

    try {
      proc = spawn(cmd, args, {
        env: server.env, cwd: server.cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ tools: [], error: 'spawn failed: ' + e.message });
    }

    let buf = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish({ tools: [], error: 'timeout' }), timeoutMs);

    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (msg.id === 2) {
          clearTimeout(timer);
          const tools = (msg.result && msg.result.tools) || [];
          finish({ tools: tools.map((t) => ({ name: t.name, description: t.description || '' })) });
        }
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); finish({ tools: [], error: e.message }); });
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'overlap-audit', version: '1.0.0' },
      },
    }) + '\n');
  });
}

// ---------- 相似度 ----------

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with',
  'is', 'it', 'this', 'that', 'as', 'by', 'at', 'from', 'be', 'are', 'was',
  'mcp', 'tool', 'server', 'returns', 'return', 'use', 'used', 'using']);

/** 名字拆词：desktop_click_element -> [desktop, click, element] */
function nameTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
}

function descTokens(desc) {
  return String(desc)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- 主流程 ----------

(async () => {
  const argv = process.argv.slice(2);
  const cfgArg = argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : null;
  const asJson = argv.includes('--json');

  const { configPath, servers } = loadServers(cfgArg);
  if (!asJson) console.log(`配置: ${configPath}\n服务器 ${servers.length} 个，正在拉工具表…\n`);

  const all = [];
  for (const s of servers) {
    const r = await listTools(s);
    if (r.error) {
      if (!asJson) console.log(`  ! ${s.name}: ${r.error}`);
      continue;
    }
    if (!asJson) console.log(`  ✓ ${s.name}: ${r.tools.length} 个工具`);
    for (const t of r.tools) all.push({ ...t, server: s.name });
  }

  // 跨服务器两两比
  const flagged = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.server === b.server) continue;

      const nSim = jaccard(nameTokens(a.name), nameTokens(b.name));
      const dSim = jaccard(descTokens(a.description), descTokens(b.description));
      // 名字像 或 描述像，都算疑似重复
      if (nSim >= 0.5 || dSim >= 0.4) {
        flagged.push({
          a: `${a.server}/${a.name}`,
          b: `${b.server}/${b.name}`,
          nameSim: +nSim.toFixed(2),
          descSim: +dSim.toFixed(2),
          score: +(Math.max(nSim, dSim)).toFixed(2),
        });
      }
    }
  }
  flagged.sort((x, y) => y.score - x.score);

  const byServer = {};
  for (const t of all) byServer[t.server] = (byServer[t.server] || 0) + 1;
  const total = all.length;

  if (asJson) {
    console.log(JSON.stringify({ total, byServer, flagged }, null, 2));
    return;
  }

  console.log(`\n工具总数 ${total}`);
  console.log('按服务器: ' + Object.entries(byServer).map(([k, v]) => `${k}=${v}`).join('  '));

  if (!flagged.length) {
    console.log('\n没有发现跨服务器的近重复工具。');
  } else {
    console.log(`\n疑似重复 ${flagged.length} 对（名字相似 ≥0.5 或描述相似 ≥0.4）：\n`);
    for (const f of flagged.slice(0, 30)) {
      console.log(`  [${f.score}]  ${f.a}  ↔  ${f.b}`);
      console.log(`          名字相似 ${f.nameSim} / 描述相似 ${f.descSim}`);
    }
    if (flagged.length > 30) console.log(`  … 另有 ${flagged.length - 30} 对`);
  }

  console.log('\n处理建议：');
  console.log('  1. 客户端只能按服务器启停 —— 重叠要在服务器内部裁。');
  console.log('     desktopos 支持：DESKTOPOS_TOOLS=shell,diagnose 或 --only=shell,diagnose');
  console.log('  2. 每个重复对里只留能力更强的那一侧，另一侧整组关掉，别"都留着以防万一"。');
  console.log('  3. 每装一个新服务器就跑一次这个脚本，别让重叠悄悄累积。');
})().catch((e) => {
  console.error('审计失败:', e.message);
  process.exit(1);
});
