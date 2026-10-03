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

/**
 * hermes 数据目录的候选位置。
 *
 * 各平台布局不同，不能只认 ~/.hermes：
 *   Linux / macOS : ~/.hermes
 *   Windows       : %LOCALAPPDATA%\hermes  （Roaming\hermes 是 Electron 运行时数据，
 *                                             里面只有 Cache/Preferences，不是配置）
 *
 * 实际在 Windows 上验证过：配置在 %LOCALAPPDATA%\hermes\config.yaml。
 * 早期只查 ~/.hermes，在 Windows 上会误报「未安装」。
 */
function hermesHome() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'hermes');
  }
  return path.join(home, '.hermes');
}

// --- Agent 适配器注册表 -------------------------------------------------

const ADAPTERS = {
  hermes: {
    key: 'hermes',
    label: 'Hermes Agent',
    status: '研发适配中',
    mcpSupport: true,
    homeDir: hermesHome,
    configPath: () => path.join(hermesHome(), 'config.yaml'),
    // Windows 上 hermes.exe 的实际位置，用于生成 PATH 或直接调用
    executable: () => {
      const exe = path.join(hermesHome(), 'bin', 'hermes.exe');
      return fs.existsSync(exe) ? exe : null;
    },
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

  const homeDir = adapter.homeDir();
  const configPath = adapter.configPath();
  const configExists = fs.existsSync(configPath);
  const homeExists = fs.existsSync(homeDir);

  // 版本：hermes-agent/ 下可能有源码，从 pyproject 读
  let version = null;
  const candidates = [
    path.join(homeDir, 'hermes-agent', 'pyproject.toml'),
    path.join(homeDir, 'pyproject.toml'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      if (m) { version = m[1]; break; }
    } catch (_) { /* 读不到就跳过 */ }
  }
  // 退而求其次：config.yaml 里的 _config_version 说明来自哪个版本
  let configVersion = null;
  if (configExists) {
    try {
      const txt = fs.readFileSync(configPath, 'utf8');
      const m = txt.match(/^_config_version:\s*(\d+)/m);
      if (m) configVersion = Number(m[1]);
    } catch (_) { /* 忽略 */ }
  }

  let registered = false;
  let registeredTools = 0;
  if (configExists) {
    try {
      const txt = fs.readFileSync(configPath, 'utf8');
      registered = hasEntry(txt);
      const entry = findEntry(txt);
      if (entry) {
        const block = txt.split('\n').slice(entry.start, entry.end).join('\n');
        const inc = block.match(/include:\s*\[([^\]]*)\]/);
        if (inc) {
          registeredTools = inc[1].split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean).length;
        }
      }
    } catch (_) { /* 读不到配置视为未注册 */ }
  }

  const exe = adapter.executable ? adapter.executable() : null;

  return {
    ok: true,
    agent: agentKey,
    label: adapter.label,
    status: adapter.status,
    installed: homeExists || !!exe,
    homeDir,
    version,
    configVersion,
    configPath,
    configExists,
    registered,
    registeredTools,
    executable: exe,
    reloadHint: adapter.reloadHint,
    notes: adapter.notes,
    docsUrl: adapter.docsUrl,
    toolPrefix: adapter.toolPrefix,
    // Windows 上 PATH 里通常没有 hermes，调用时需要用绝对路径
    executableOnPath: false,
  };
}

/**
 * 找出可用于 stdio 子进程的 node 可执行文件。
 *
 * 为什么需要这个：hermes 启动 stdio 子进程时只传「安全变量」
 * （PATH、HOME、LANG 等）。在 Windows 上，如果 node 来自某个
 * 不在系统 PATH 的托管运行时目录（版本管理器、包管理器沙箱等），
 * 子进程就会因为找不到 node 而启动失败 —— 表现是 MCP server 无响应。
 * 所以这里直接定位 node 的绝对路径写进配置。
 */
function resolveNodePath() {
  // 1) 当前进程用的 node 就是最可靠的答案
  if (process.execPath && /node(\.exe)?$/i.test(process.execPath)) {
    return process.execPath;
  }
  // 2) 环境变量里显式指定的
  if (process.env.FORGE_NODE && fs.existsSync(process.env.FORGE_NODE)) {
    return process.env.FORGE_NODE;
  }
  // 3) Windows 上常见的安装位置
  if (process.platform === 'win32') {
    const guesses = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
      // 托管运行时布局（本机开发环境即是此形态）
      path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions'),
    ];
    for (const g of guesses) {
      if (fs.existsSync(g)) {
        if (fs.statSync(g).isFile()) return g;
        // 目录 → 找最新的版本子目录
        try {
          const subs = fs.readdirSync(g)
            .map((n) => path.join(g, n))
            .filter((p) => fs.statSync(p).isDirectory())
            .sort();
          for (let i = subs.length - 1; i >= 0; i--) {
            const exe = path.join(subs[i], 'node.exe');
            if (fs.existsSync(exe)) return exe;
          }
        } catch (_) { /* 继续找下一个 */ }
      }
    }
  }
  // 4) 退回 'node'，赌它在 PATH 里
  return 'node';
}

/**
 * YAML 标量字符串。
 *
 * 不用双引号：双引号里反斜杠是转义符，Windows 路径的 `C:\Users`
 * 里的 `\U` 不是合法转义序列，会让整个 config.yaml 解析失败。
 *
 * 也不用双引号的另一个考虑：Node 的 spawn 在 Windows 上对正斜杠路径
 * 可用，但对需要按原生路径分隔符查找依赖 DLL 的可执行文件可能报 ENOENT。
 * 单引号包裹保留原样反斜杠，既避开 YAML 转义，又不给 spawn 添麻烦。
 *
 * 单引号 YAML 里唯一需要转义的是单引号本身（写成两个）。
 */
function yamlStr(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 生成 hermes 的 MCP 配置片段。
 * 给界面展示 + 一键写入都用它，避免两处生成逻辑不一致。
 */
function buildConfigSnippet(agentKey, { serverPath, toolFilter = null, nodePath = null } = {}) {
  const adapter = ADAPTERS[agentKey];
  if (!adapter) return null;

  const p = serverPath || path.join(__dirname, '..', '..', 'bin', 'forge-mcp.js');
  const node = nodePath || resolveNodePath();

  const lines = [
    `  ${adapter.serverName}:`,
    `    command: ${yamlStr(node)}`,
    `    args: ["${String(p).replace(/\\/g, '/')}"]`,
    `    enabled: true`,
    `    timeout: 300`,
  ];

  if (toolFilter && toolFilter.length) {
    lines.push(`    tools:`);
    lines.push(`      include: [${toolFilter.map((t) => JSON.stringify(t)).join(', ')}]`);
  }

  return {
    snippet: lines.join('\n'),
    full: `mcp_servers:\n${lines.join('\n')}`,
    serverPath: p,
    nodePath: node,
  };
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
  // 供验证脚本与测试复用
  hermesHome, resolveNodePath, findEntry, hasEntry,
};
