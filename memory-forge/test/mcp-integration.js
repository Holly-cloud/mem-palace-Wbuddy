#!/usr/bin/env node
'use strict';
/**
 * MCP 端到端测试：模拟 hermes 通过 MCP 协议驱动整个流程。
 * 走真实的 JSON-RPC over stdio，不用内部调用绕过协议层。
 *
 * 运行： node test/mcp-integration.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { spawn } = require('child_process');
const adapter = require('../src/engine/agentAdapter');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const SERVER = path.resolve(__dirname, '..', 'bin', 'forge-mcp.js');
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-'));

// --- MCP 客户端 ----------------------------------------------------------

class McpClient {
  constructor(serverPath, workspace) {
    this.proc = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORGE_WORKSPACE: workspace },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buffer += d;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p(msg); }
        } catch (_) { /* 非 JSON 行忽略 */ }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) return reject(new Error(msg.error.message));
        resolve(msg.result);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** 调工具并解析返回的 JSON 文本 */
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args || {} });
    const text = res.content && res.content[0] && res.content[0].text;
    try { return JSON.parse(text); } catch (_) { return { ok: false, error: '返回非 JSON', raw: text }; }
  }

  async close() {
    try { this.proc.stdin.end(); } catch (_) { /* 已关闭 */ }
    try { this.proc.kill(); } catch (_) { /* 已退出 */ }
  }
}

(async () => {
  const c = new McpClient(SERVER, WORKSPACE);

  // --- 1. 协议握手 ---
  section('MCP 协议握手');

  const init = await c.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  ok('initialize 返回协议版本', init.protocolVersion === '2024-11-05', init.protocolVersion);
  ok('返回 serverInfo', init.serverInfo && init.serverInfo.name === 'memory-forge');
  ok('声明 tools 能力', init.capabilities && !!init.capabilities.tools);

  const list = await c.request('tools/list', {});
  ok('tools/list 返回工具', list.tools.length === 12, `got ${list.tools.length}`);

  const toolNames = list.tools.map((t) => t.name);
  const expectedTools = [
    'forge_probe_start', 'forge_probe_read_sample', 'forge_probe_write_recipe',
    'forge_probe_status', 'forge_split_by_recipe', 'forge_task_start',
    'forge_task_read_chunk', 'forge_task_write_result', 'forge_import_results',
    'forge_palace_doctor', 'forge_palace_search', 'forge_list_types',
  ];
  expectedTools.forEach((n) => ok(`工具 ${n} 已注册`, toolNames.includes(n)));

  ok('每个工具都有描述', list.tools.every((t) => t.description && t.description.length > 20));
  ok('每个工具都有 inputSchema', list.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  ok('必填参数已标注',
    list.tools.find((t) => t.name === 'forge_probe_start').inputSchema.required.includes('files'));

  // --- 2. 类型说明 ---
  section('类型与字段说明');

  const types = await c.call('forge_list_types', {});
  ok('返回 8 种类型', types.types.length === 8, `got ${types.types.length}`);
  ok('含 subject 规则', /不能含空格/.test(types.fieldRules.subject));
  ok('含 predicate 规则', /只能有一条 active/.test(types.fieldRules.predicate));
  ok('含中文别名建议', /中文触发词/.test(types.fieldRules.aliases));
  ok('给出输出格式', types.outputFormat.includes('cards'));

  // --- 3. 探查流程（格式不统一时） ---
  section('探查流程（agent 驱动）');

  const srcDir = path.join(WORKSPACE, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const codexFile = path.join(srcDir, 'codex.jsonl');
  const chatFile = path.join(srcDir, 'chat.json');
  fs.writeFileSync(codexFile, [
    '{"type":"message","role":"user","content":[{"type":"input_text","text":"冲突键用什么"}]}',
    '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"用 slot"}]}',
    '{"type":"message","role":"user","content":[{"type":"input_text","text":"我偏好标记而非删除"}]}',
  ].join('\n'), 'utf8');
  fs.writeFileSync(chatFile, JSON.stringify([
    { role: 'user', content: '我偏好结论先行' },
    { role: 'assistant', content: '好的' },
  ]), 'utf8');

  const probeRes = await c.call('forge_probe_start', { files: [codexFile, chatFile], taskId: 'T1' });
  ok('探查启动成功', probeRes.ok === true);
  ok('返回任务 ID', probeRes.taskId === 'T1');
  ok('返回任务目录', !!probeRes.taskDir && fs.existsSync(probeRes.taskDir));
  ok('返回结构速览', probeRes.overview.length === 2);
  const codexOverview = probeRes.overview.find((o) => o.file === 'codex.jsonl');
  ok('★ 检测到嵌套内容（关键信号）',
    codexOverview.signals.some((s) => s.includes('嵌套内容')),
    JSON.stringify(codexOverview.signals));
  ok('给出下一步指引', probeRes.nextSteps.length === 3);
  ok('返回可用策略列表', probeRes.strategies.includes('jsonl'));

  // 读取采样
  const sample = await c.call('forge_probe_read_sample', { taskId: 'T1', file: 'codex.jsonl' });
  ok('读取采样成功', sample.ok === true);
  ok('采样含头部内容', sample.head.includes('冲突键用什么'));
  ok('采样含结构统计', typeof sample.structure.jsonLineRate === 'number');
  ok('结构统计字段齐全',
    ['jsonLineRate', 'nestedContentLines', 'roleMarkers', 'csvLike', 'headingCount']
      .every((k) => k in sample.structure),
    Object.keys(sample.structure || {}).join(','));
  ok('统计标注嵌套内容行数', sample.structure.nestedContentLines === 3,
    `got ${sample.structure && sample.structure.nestedContentLines}`);
  ok('给出配方文件名', sample.recipeFile.includes('.recipe.json'));

  const noSample = await c.call('forge_probe_read_sample', { taskId: 'T1', file: '不存在.md' });
  ok('读不存在的文件给出候选列表', noSample.ok === false && Array.isArray(noSample.available));

  // 写配方
  const badRecipe = await c.call('forge_probe_write_recipe', {
    taskId: 'T1', file: 'codex.jsonl', strategy: '不存在的策略',
  });
  ok('非法策略被拒', badRecipe.ok === false);
  ok('返回可用策略帮助修正', Array.isArray(badRecipe.availableStrategies));

  const badFields = await c.call('forge_probe_write_recipe', {
    taskId: 'T1', file: 'codex.jsonl', strategy: 'jsonl', fields: { 内容: 'a..b' },
  });
  ok('非法字段路径被拒', badFields.ok === false && /不合法/.test(badFields.error));

  const r1 = await c.call('forge_probe_write_recipe', {
    taskId: 'T1', file: 'codex.jsonl', strategy: 'jsonl',
    fields: { 角色: 'role', 内容: 'content[].text' }, includeMeta: ['type'],
    note: '内容在 content[].text 里',
  });
  ok('配方写入成功', r1.ok === true);
  ok('返回进度', r1.progress.done === 1 && r1.progress.total === 2);
  ok('列出剩余文件', r1.remaining.length === 1);

  await c.call('forge_probe_write_recipe', {
    taskId: 'T1', file: 'chat.json', strategy: 'json_array',
    fields: { 角色: 'role', 内容: 'content' },
  });

  const pStat = await c.call('forge_probe_status', { taskId: 'T1' });
  ok('探查进度 100%', pStat.progress.percent === 100);
  ok('两个文件状态均为 ok', pStat.files.every((f) => f.state === 'ok'));

  // 切分
  const splitRes = await c.call('forge_split_by_recipe', { taskId: 'T1', taskIdOut: 'X1', chunkBudget: 2000 });
  ok('切分成功', splitRes.ok === true);
  ok('切分产生分块', splitRes.chunkCount >= 2, `got ${splitRes.chunkCount}`);
  ok('返回每个文件的切分明细', splitRes.perFile.length === 2);
  ok('codex 用 jsonl 策略', splitRes.perFile.find((f) => f.name === 'codex.jsonl').strategy === 'jsonl');
  ok('无兜底文件', (splitRes.fallbackFiles || []).length === 0);

  // --- 4. 抽取流程 ---
  section('抽取流程（agent 逐块处理）');

  const chunksRes = await c.call('forge_task_read_chunk', { taskId: 'X1' });
  ok('返回分块清单', chunksRes.total >= 2);
  ok('返回进度', chunksRes.progress.total === chunksRes.total);

  const chunk0 = await c.call('forge_task_read_chunk', { taskId: 'X1', index: 0 });
  ok('读取分块成功', chunk0.ok === true);
  ok('★ 分块含嵌套内容（探查的收益）', chunk0.content.includes('冲突键用什么'),
    chunk0.content.slice(0, 120));
  ok('分块标注角色', chunk0.content.includes('角色'));
  ok('返回结果文件名', chunk0.resultFile.includes('.result.json'));
  ok('初始未提交结果', chunk0.alreadyDone === false);

  // agent 提交结果
  const writeRes = await c.call('forge_task_write_result', {
    taskId: 'X1', index: 0,
    cards: [
      { type: 'preference', title: '偏好标记而非删除', subject: 'user',
        predicate: 'conflict_policy', value: '冲突时标记而不是删除',
        body: '', confidence: 0.9, importance: 0.8, aliases: ['冲突处理'] },
      // 故意写一张缺字段的，验证容错
      { type: 'lesson', body: '缺少 subject 和 predicate' },
    ],
  });
  ok('结果提交成功', writeRes.ok === true);
  ok('接受合法卡片', writeRes.accepted === 1, `got ${writeRes.accepted}`);
  ok('拒绝缺字段卡片', writeRes.rejected.length === 1);
  ok('拒绝原因可读', /subject|predicate|value/.test(writeRes.rejected[0].reason));
  ok('返回进度', writeRes.progress.total === writeRes.progress.total);

  const reread = await c.call('forge_task_read_chunk', { taskId: 'X1', index: 0 });
  ok('已提交的分块标记完成', reread.alreadyDone === true);

  // 处理剩余分块
  for (let i = 1; i < chunksRes.total; i++) {
    await c.call('forge_task_write_result', { taskId: 'X1', index: i, cards: [] });
  }
  const allDone = await c.call('forge_task_write_result', {
    taskId: 'X1', index: 0, cards: [
      { type: 'preference', title: '偏好标记而非删除', subject: 'user',
        predicate: 'conflict_policy', value: '冲突时标记而不是删除',
        confidence: 0.9, importance: 0.8, aliases: ['冲突处理'] },
      { type: 'preference', title: '偏好结论先行', subject: 'user',
        predicate: 'reply_style', value: '结论先行', confidence: 0.9, aliases: ['回复风格'] },
    ],
  });
  ok('覆盖已有结果成功', allDone.ok === true);
  ok("全部完成时提示可导入", allDone.allDone === true, `done=${allDone.progress.done}/${allDone.progress.total}`);

  // --- 5. 导入 ---
  section('导入与下游管线');

  const importRes = await c.call('forge_import_results', { taskId: 'X1' });
  ok('导入成功', importRes.ok === true);
  ok('产出卡片', importRes.cardCount >= 2, `got ${importRes.cardCount}`);
  ok('默认不写盘', importRes.written === false);
  ok('给出下一步指引', /write=true/.test(importRes.nextStep || ''));

  // --- 6. 记忆库工具 ---
  section('记忆库工具');

  const noPalace = await c.call('forge_palace_doctor', { palaceRoot: path.join(WORKSPACE, 'nope') });
  ok('不存在的记忆库被明确报错', noPalace.ok === false && /不存在/.test(noPalace.error));

  // 造一个小记忆库
  const palaceDir = path.join(WORKSPACE, 'palace');
  const { normalizeCard, renderCard, cardFileName } = require('../src/engine/schema');
  const card1 = normalizeCard({ type: 'preference', title: '偏好结论先行',
    subject: 'user', predicate: 'reply_style', value: '结论先行' }, {});
  fs.mkdirSync(path.join(palaceDir, 'cards', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(palaceDir, 'cards', 'preference', cardFileName('mem_00001', card1.title)),
    renderCard(card1, 'mem_00001'), 'utf8'
  );

  const doctor = await c.call('forge_palace_doctor', { palaceRoot: palaceDir });
  ok('体检成功', doctor.ok === true);
  ok('读到卡片数', doctor.cardCount === 1);
  ok('返回类型分布', !!doctor.byType.preference);

  const search = await c.call('forge_palace_search', { query: '结论先行', palaceRoot: palaceDir });
  ok('检索成功', search.ok === true);
  ok('检索命中', search.results.length >= 1);
  ok('返回 slot', search.results[0].slot === 'user::reply_style');

  // 写盘
  const writeRes2 = await c.call('forge_import_results', {
    taskId: 'X1', palaceRoot: palaceDir, write: true,
  });
  ok('写入成功', writeRes2.written === true);
  ok('报告写入数量', writeRes2.writtenCount >= 2, `got ${writeRes2.writtenCount}`);
  ok('报告 ID 范围', !!writeRes2.idRange);
  ok('给出校验命令', /doctor/.test(writeRes2.verifyCommand || ''));

  const after = await c.call('forge_palace_doctor', { palaceRoot: palaceDir });
  ok('记忆库卡片数增加', after.cardCount > doctor.cardCount,
    `${doctor.cardCount} → ${after.cardCount}`);

  // --- 7. 错误处理 ---
  section('错误处理');

  const noTask = await c.call('forge_task_read_chunk', { taskId: '不存在任务' });
  ok('未知任务明确报错', noTask.ok === false && /未找到/.test(noTask.error));

  const badIndex = await c.call('forge_task_read_chunk', { taskId: 'X1', index: 999 });
  ok('越界分块明确报错', badIndex.ok === false && /没有分块/.test(badIndex.error));

  const noFiles = await c.call('forge_probe_start', { files: [] });
  ok('空文件列表报错', noFiles.ok === false);

  const missingFiles = await c.call('forge_probe_start', { files: [path.join(WORKSPACE, '不存在.md')] });
  ok('文件不存在时报错', missingFiles.ok === false && /没有可探查/.test(missingFiles.error));

  const unknownTaskImport = await c.call('forge_import_results', { taskId: '不存在任务' });
  ok('导入未知任务报错', unknownTaskImport.ok === false);

  // isError 标记
  const errCall = await c.request('tools/call', { name: 'forge_probe_start', arguments: { files: [] } });
  ok('错误结果带 isError 标记', errCall.isError === true);

  const unknownTool = await c.request('tools/call', { name: '不存在的工具', arguments: {} })
    .catch((e) => ({ error: { message: e.message } }));
  ok('未知工具被拒', !!unknownTool.error || unknownTool.isError === true);

  // --- 8. 只读保证 ---
  section('只读保证');

  const srcBefore = {
    codex: fs.readFileSync(codexFile, 'utf8'),
    chat: fs.readFileSync(chatFile, 'utf8'),
  };
  await c.call('forge_probe_start', { files: [codexFile, chatFile], taskId: 'T2' });
  await c.call('forge_probe_read_sample', { taskId: 'T2', file: 'codex.jsonl' });
  ok('探查未改动源文件',
    fs.readFileSync(codexFile, 'utf8') === srcBefore.codex
    && fs.readFileSync(chatFile, 'utf8') === srcBefore.chat);

  await c.close();

  // --- 9. agent 适配器 ---
  section('hermes 适配');

  const adapters = adapter.ADAPTERS;
  ok('注册了 hermes 适配器', !!adapters.hermes);
  ok('标记为研发适配中', adapters.hermes.status.includes('研发适配'));
  ok('标注 MCP 支持', adapters.hermes.mcpSupport === true);

  const snippet = adapter.buildConfigSnippet('hermes', { serverPath: SERVER });
  ok('生成配置片段', snippet.snippet.includes('memory_forge:'));
  // command 用 node 的绝对路径而非裸 'node'：hermes 启动 stdio 子进程时
  // 只传受限环境变量，托管运行时通常不在 PATH 里，写裸名字会启动失败
  ok('配置含 command', /command:\s*['"].*node(\.exe)?['"]/.test(snippet.snippet),
    snippet.snippet.split('\n')[1]);
  ok('command 用绝对路径（避免 PATH 受限）',
    !/command:\s*['"]node(\.exe)?['"]/.test(snippet.snippet));
  ok('command 用单引号（避开 YAML 反斜杠转义）',
    /command:\s*'/.test(snippet.snippet));
  ok('配置含 args 指向 server', snippet.snippet.includes('forge-mcp.js'));
  ok('args 用双引号且路径为正斜杠', /args:\s*\["[^"]*forge-mcp\.js"\]/.test(snippet.snippet));
  ok('配置含 enabled', snippet.snippet.includes('enabled: true'));
  ok('完整片段含 mcp_servers', snippet.full.startsWith('mcp_servers:'));

  const filtered = adapter.buildConfigSnippet('hermes', { serverPath: SERVER, toolFilter: ['forge_probe_start'] });
  ok('支持工具白名单', filtered.snippet.includes('include:'));
  ok('白名单列出工具', filtered.snippet.includes('forge_probe_start'));

  const detect = adapter.detectAgent('hermes');
  ok('检测返回 ok', detect.ok === true);
  // hermes 数据目录在 Windows 上是 %LOCALAPPDATA%\hermes，不是 ~/.hermes
  ok('给出配置路径', /hermes[/\\]config\.yaml$/.test(detect.configPath),
    detect.configPath);
  ok('给出工具前缀', detect.toolPrefix === 'mcp__memory_forge__');
  ok('给出重载提示', detect.reloadHint.includes('/reload-mcp'));
  ok('给出文档链接', (detect.docsUrl || '').includes('hermes'));
  ok('列出注意事项', detect.notes.length >= 4);

  const badAgent = adapter.detectAgent('不存在的agent');
  ok('未知 agent 被拒', badAgent.ok === false);

  // --- Windows 场景（本次真实适配发现的问题）---
  section('Windows 路径与 YAML');

  // hermes 数据目录：Windows 上是 %LOCALAPPDATA%\hermes，不是 ~/.hermes
  const winHome = adapter.hermesHome();
  ok('hermesHome 按平台返回正确位置',
    process.platform === 'win32'
      ? winHome.includes('AppData') && winHome.endsWith('hermes')
      : winHome.endsWith('.hermes'),
    winHome);

  // YAML 双引号里反斜杠是转义符 —— Windows 路径必须用单引号
  const winSnippet = adapter.buildConfigSnippet('hermes', {
    serverPath: 'C:\\x\\forge-mcp.js',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  ok('command 用单引号包裹', /command:\s*'C:\\Program Files\\nodejs\\node\.exe'/.test(winSnippet.snippet),
    winSnippet.snippet.split('\n')[1]);
  ok('单引号内保留反斜杠（原生路径）', winSnippet.snippet.includes('C:\\Program Files'));

  // 生成的 YAML 不能有非法转义（双引号里的 \U 之类会让整个配置解析失败）
  ok('生成的片段无非法 YAML 转义', (() => {
    const quoted = winSnippet.snippet.match(/"[^"]*"/g) || [];
    const illegal = quoted.filter((s) => {
      // 双引号串里只允许 \" \\ \n \t \u \x 等转义
      const re = /\\(.)/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        if (!'"\\nrtu xabfv0'.includes(m[1])) return true;
      }
      return false;
    });
    return illegal.length === 0;
  })());

  // command 必须是绝对路径：hermes 只传受限环境变量，托管运行时不在 PATH
  ok('command 为绝对路径', /command:\s*'[^']*[\\/]/.test(winSnippet.snippet));
  ok('解析出的 node 路径可用', (() => {
    const np = adapter.resolveNodePath();
    return np === 'node' || require('fs').existsSync(np);
  })(), adapter.resolveNodePath());
  ok('resolveNodePath 优先当前进程的解释器',
    adapter.resolveNodePath() === process.execPath
    || adapter.resolveNodePath() === 'node');

  const badInstall = adapter.installConfig('hermes', { serverPath: path.join(WORKSPACE, '不存在.js') });
  ok('安装时校验 server 存在', badInstall.ok === false && /不存在/.test(badInstall.error));

  // 文本插入逻辑（用临时目录验证，不动真实 ~/.hermes）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-hermes-'));
  const fakeAdapter = {
    ...adapters.hermes,
    configPath: () => path.join(fakeHome, '.hermes', 'config.yaml'),
  };
  const realAdapters = adapter.ADAPTERS;
  adapter.ADAPTERS.hermes = fakeAdapter;
  try {
    // 场景 A：配置不存在
    const inst1 = adapter.installConfig('hermes', { serverPath: SERVER });
    ok('新环境创建配置', inst1.ok === true && inst1.action === 'created');
    ok('创建的配置含 mcp_servers',
      fs.readFileSync(fakeAdapter.configPath(), 'utf8').includes('mcp_servers:'));

    // 场景 B：已有其他 MCP 服务器
    const cfgPath = fakeAdapter.configPath();
    fs.writeFileSync(cfgPath,
      'mcp_servers:\n  filesystem:\n    command: "npx"\n    args: ["-y", "server-fs"]\n', 'utf8');
    const inst2 = adapter.installConfig('hermes', { serverPath: SERVER });
    ok('追加到已有段落', inst2.ok === true && inst2.action === 'appended');
    const after2 = fs.readFileSync(cfgPath, 'utf8');
    ok('★ 未破坏原有配置', after2.includes('filesystem:') && after2.includes('server-fs'));
    ok('★ 原有缩进保持', /  filesystem:\n    command: "npx"/.test(after2));
    ok('★ 新条目缩进正确', /\n  memory_forge:\n    command:\s*['"]/.test(after2),
      after2.split('\n').slice(1, 4).join(' | '));

    // 场景 C：重复安装 → 更新而非重复
    const inst3 = adapter.installConfig('hermes', { serverPath: SERVER });
    ok('重复安装为更新', inst3.ok === true && inst3.action === 'updated');
    const count = (fs.readFileSync(cfgPath, 'utf8').match(/memory_forge:/g) || []).length;
    ok('未产生重复条目', count === 1, `found ${count}`);
    ok('更新后仍保留原有配置', fs.readFileSync(cfgPath, 'utf8').includes('filesystem:'));

    // 场景 D：无 mcp_servers 段
    fs.writeFileSync(cfgPath, 'model: gpt-4\ntemperature: 0.7\n', 'utf8');
    const inst4 = adapter.installConfig('hermes', { serverPath: SERVER });
    ok('无段落时新建段', inst4.ok === true && inst4.action === 'section-created');
    const after4 = fs.readFileSync(cfgPath, 'utf8');
    ok('★ 保留了非 MCP 配置', after4.includes('model: gpt-4') && after4.includes('temperature'));
    ok('新增段落内容正确', after4.includes('mcp_servers:') && after4.includes('memory_forge:'));

    // 场景 E：备份
    ok('安装了备份', fs.existsSync(`${cfgPath}.forge-backup`));

    // 场景 F：卸载
    const un = adapter.uninstallConfig('hermes');
    ok('卸载成功', un.ok === true && un.action === 'removed');
    const afterUn = fs.readFileSync(cfgPath, 'utf8');
    ok('★ 卸载后保留原有配置', afterUn.includes('filesystem:') || afterUn.includes('model:'));
    ok('卸载移除了我们的条目', !afterUn.includes('memory_forge:'));

    const un2 = adapter.uninstallConfig('hermes');
    ok('重复卸载不报错', un2.ok === true && un2.action === 'not-installed');
  } finally {
    adapter.ADAPTERS.hermes = realAdapters;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }

  // --- 10. 自检 ---
  section('连接自检');

  const st = await adapter.selfTest(SERVER);
  ok('自检通过', st.ok === true);
  ok('返回协议版本', st.protocolVersion === '2024-11-05');
  ok('返回工具数量', st.toolCount === 12);
  ok('列出工具名', st.tools.includes('forge_probe_start'));

  const stBad = await adapter.selfTest(path.join(WORKSPACE, '不存在.js'));
  ok('不存在的 server 自检失败', stBad.ok === false);

  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  console.log('\n' + '='.repeat(46));
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log('='.repeat(46));
  if (fail) {
    console.log('\n失败详情:');
    failures.forEach((f) => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试异常:', err.message);
  console.error(err.stack);
  process.exit(1);
});
