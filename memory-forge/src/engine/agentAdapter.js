'use strict';
/**
 * Agent 适配 —— 检测宿主 agent、生成配置、验证连接。
 *
 * 当前只针对 hermes 做研发适配（用户明确要求），但结构上留了扩展点：
 * `ADAPTERS` 是一个注册表，加一个 agent 就是加一条记录，
 * 不需要改 MCP server 或界面。
 *
 * hermes 的 MCP 配置落在 `~/.hermes/config.yaml` 的 `mcp_servers` 段，
 * 本地服务器走 stdio 传输：
 *
 *   mcp_servers:
 *     memory_forge:
 *       command: "node"
 *       args: ["/abs/path/bin/forge-mcp.js"]
 *
 * 写 YAML 需要小心：不能引入依赖（yaml 解析库），也不该整体重写用户的
 * config.yaml —— 那可能损坏其他配置。所以策略是**文本级最小插入**：
 * 找到 `mcp_servers:` 段，在其中追加我们的条目；找不到就在文件末尾追加整段。
 * 这样既不动用户已有内容，也不会因为 YAML 缩进出错而毁掉整个文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'memory_forge';

// --- Agent 适配器注册表 -------------------------------------------------

const ADAPTERS = {
  hermes: {
    key: 'hermes',
    label: 'Hermes Agent',
    status: '研发适配中',
    mcpSupport: true,
    configPath: () => path.join(os.homedir(), '.hermes', 'config.yaml'),
    serverName: SERVER_NAME,
    // hermes 的工具名清洗规则：连字符与点替换为下划线
    toolPrefix: 'mcp__memory_forge__',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
    notes: [
      'hermes 用 ~/.hermes/config.yaml 的 mcp_servers 段配置 MCP 服务器',
      '本地服务器走 stdio 传输，hermes 把它作为子进程启动并通过 stdin/stdout 通信',
      '改动配置后需要在会话内执行 /reload-mcp 生效',
      '可以用 hermes mcp list 查看连接状态，hermes mcp test <名称> 做连接测试',
      '工具名会被 hermes 清洗为 mcp__memory_forge__<tool_name> 的形式',
    ],
    reloadHint: '在 hermes 会话中执行 /reload-mcp',
  },
};

// --- 检测 ----------------------------------------------------------------

function detectAgent(agentKey) {
  const adapter = ADAPTERS[agentKey];
  if (!adapter) return { ok: false, error: `未知的 agent 类型 ${agentKey}` };

  const configPath = adapter.configPath();
  const home = os.homedir();
  const hermesHome = path.join(home, '.hermes');

  const exists = fs.existsSync(hermesHome);
  const configExists = fs.existsSync(configPath);
  let installed = false;
  let version = null;

  // 从可能的安装位置推断版本
  const candidates = [
    path.join(hermesHome, 'hermes-agent', 'pyproject.toml'),
    path.join(hermesHome, 'pyproject.toml'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      if (m) { version = m[1]; break; }
    } catch (_) { /* 读不到就跳过 */ }
  }
  installed = exists;

  let registered = false;
  if (configExists) {
    try {
      registered = hasEntry(fs.readFileSync(configPath, 'utf8'));
    } catch (_) { /* 读不到配置视为未注册 */ }
  }

  return {
    ok: true,
    agent: agentKey,
    label: adapter.label,
    installed,
    version,
    configPath,
    configExists,
    registered,
    reloadHint: adapter.reloadHint,
    notes: adapter.notes,
    docsUrl: adapter.docsUrl,
    toolPrefix: adapter.toolPrefix,
  };
}

/**
 * 生成 hermes 的 MCP 配置片段。
 * 给界面展示 + 一键写入都用它，避免两处生成逻辑不一致。
 */
function buildConfigSnippet(agentKey, { serverPath, toolFilter = null } = {}) {
  const adapter = ADAPTERS[agentKey];
  if (!adapter) return null;

  const p = serverPath || path.join(__dirname, 'forge-mcp.js');

  const lines = [
    `  ${adapter.serverName}:`,
    `    command: "node"`,
    `    args: ["${p.replace(/\\/g, '/')}"]`,
    `    enabled: true`,
    `    timeout: 300`,
  ];

  if (toolFilter && toolFilter.length) {
    lines.push(`    tools:`);
    lines.push(`      include: [${toolFilter.map((t) => JSON.stringify(t)).join(', ')}]`);
  }

  return { snippet: lines.join('\n'), full: `mcp_servers:\n${lines.join('\n')}`, serverPath: p };
}

/**
 * 找出配置里是否已注册我们的条目。
 * 逐行扫描，记录键名所在行的缩进，作为后续替换的基准。
 */
function findEntry(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_-]+)\s*:/);
    if (!m || m[2] !== SERVER_NAME) continue;
    const baseIndent = m[1].length;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (!line.trim()) { end++; continue; }              // 空行：可能是条目末尾，跳过
      const ind = line.match(/^(\s*)/)[1].length;
      const isNewKey = /^(\s*)[A-Za-z0-9_-]+\s*:/.test(line);
      // 缩进浅于等于基准 → 出了本条目
      if (ind <= baseIndent && isNewKey) break;
      end++;
    }
    // 回退掉尾部空行，避免吞掉条目之间的分隔
    while (end > i + 1 && !lines[end - 1].trim()) end--;
    return { start: i, end, indent: ' '.repeat(baseIndent) };
  }
  return null;
}

function hasEntry(text) {
  return !!findEntry(text);
}

/** 用新片段替换已存在的条目，保留其余内容 */
function replaceEntry(text, snippet) {
  const found = findEntry(text);
  if (!found) return text;
  const lines = text.split('\n');
  const before = lines.slice(0, found.start);
  const after = lines.slice(found.end);
  return [...before, ...snippet.split('\n'), ...after].join('\n');
}

/**
 * 把配置写入 hermes 的 config.yaml。
 *
 * 采用最小侵入的文本插入，而不是「解析 YAML → 修改 → 序列化」：
 * 后者需要引入 yaml 依赖，且任何序列化差异都可能改写用户其他配置。
 * 文本插入只动 mcp_servers 段内的部分，用户的其他内容保持原样。
 */
function installConfig(agentKey, { serverPath, toolFilter = null, backup = true } = {}) {
  const adapter = ADAPTERS[agentKey];
  if (!adapter) return { ok: false, error: `未知的 agent 类型 ${agentKey}` };

  const configPath = adapter.configPath();
  const built = buildConfigSnippet(agentKey, { serverPath, toolFilter });
  if (!built) return { ok: false, error: '生成配置片段失败' };

  // 校验 server 脚本确实存在 —— 配置指向不存在的文件是最难排查的问题
  if (!fs.existsSync(built.serverPath)) {
    return {
      ok: false,
      error: `MCP server 脚本不存在：${built.serverPath}`,
      hint: '请确认 forge-mcp.js 的实际路径',
    };
  }

  let original = '';
  if (fs.existsSync(configPath)) {
    try {
      original = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `读取配置失败：${err.message}` };
    }
  }

  // 已注册则替换该条目，否则插入。
  //
  // 正则必须**逐行锚定**：条目体只匹配「缩进比键名深」的行，
  // 且不跨越同缩进的兄弟条目。早先用 `(?:[ \t]+.*\n|[ \t]*\n)*` 会贪婪吃掉
  // 后续条目（更新 memory_forge 时把 filesystem 也删了）——
  // 配置被静默破坏很难排查，所以这里逐行判断缩进，宁可多写几行也不能多删。
  let updated;
  let action;
  if (hasEntry(original)) {
    updated = replaceEntry(original, built.snippet);
    action = 'updated';
  } else if (/^mcp_servers:\s*$/m.test(original)) {
    // 找到 mcp_servers: 段，在段末追加
    updated = original.replace(/^(mcp_servers:\s*\n)/m, `$1${built.snippet}\n`);
    action = 'appended';
  } else if (original.trim() === '') {
    updated = `${built.full}\n`;
    action = 'created';
  } else {
    // 没有 mcp_servers 段，在文件末尾新增
    const sep = original.endsWith('\n') ? '' : '\n';
    updated = `${original}${sep}\n${built.full}\n`;
    action = 'section-created';
  }

  if (backup && original) {
    try {
      fs.writeFileSync(`${configPath}.forge-backup`, original, 'utf8');
    } catch (_) { /* 备份失败不阻断 */ }
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, updated, 'utf8');
  } catch (err) {
    return { ok: false, error: `写入配置失败：${err.message}`, path: configPath };
  }

  return {
    ok: true,
    action,
    configPath,
    serverPath: built.serverPath,
    reloadHint: adapter.reloadHint,
    snippet: built.snippet,
    nextSteps: [
      `重启 hermes 或在会话中执行 ${adapter.reloadHint}`,
      '执行 hermes mcp list 确认 memory_forge 已连接',
      `工具会以 ${adapter.toolPrefix}<name> 的形式出现`,
    ],
  };
}

/** 卸载：从 config.yaml 移除我们的条目 */
function uninstallConfig(agentKey) {
  const adapter = ADAPTERS[agentKey];
  if (!adapter) return { ok: false, error: `未知的 agent 类型 ${agentKey}` };
  const configPath = adapter.configPath();
  if (!fs.existsSync(configPath)) {
    return { ok: false, error: '配置文件不存在' };
  }
  const original = fs.readFileSync(configPath, 'utf8');
  if (!hasEntry(original)) {
    return { ok: true, action: 'not-installed', configPath };
  }
  const found = findEntry(original);
  const lines = original.split('\n');
  // 连同条目后的空行一起去掉，避免留下空洞
  let end = found.end;
  while (end < lines.length && !lines[end].trim()) end++;
  const updated = [...lines.slice(0, found.start), ...lines.slice(end)].join('\n');
  try {
    fs.writeFileSync(`${configPath}.forge-backup`, original, 'utf8');
    fs.writeFileSync(configPath, updated, 'utf8');
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }
  return { ok: true, action: 'removed', configPath, reloadHint: adapter.reloadHint };
}

/**
 * 自检：MCP server 是否能正常响应 initialize + tools/list。
 * 用子进程模拟 hermes 的握手方式，配置前先验证再写入。
 */
function selfTest(serverPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(serverPath)) {
      return resolve({ ok: false, error: `server 脚本不存在：${serverPath}` });
    }

    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let out = '';
    let err = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) { /* 已退出 */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: '自检超时（未在预期时间内响应）',
        stdout: out.slice(0, 500),
        stderr: err.slice(0, 500),
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n').filter((l) => l.trim());
      if (lines.length >= 2) {
        try {
          const init = JSON.parse(lines[0]);
          const tools = JSON.parse(lines[1]);
          const list = (tools.result && tools.result.tools) || [];
          finish({
            ok: true,
            protocolVersion: init.result && init.result.protocolVersion,
            serverInfo: init.result && init.result.serverInfo,
            toolCount: list.length,
            tools: list.map((t) => t.name),
            stderr: err.slice(0, 300),
          });
        } catch (e) {
          finish({ ok: false, error: `响应解析失败：${e.message}`, stdout: out.slice(0, 500) });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `启动失败：${e.message}` }));

    // 模拟 MCP 握手
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
}

module.exports = {
  ADAPTERS, SERVER_NAME,
  detectAgent, buildConfigSnippet, installConfig, uninstallConfig, selfTest,
};
