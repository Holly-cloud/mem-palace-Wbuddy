'use strict';
/**
 * Electron 主进程。
 *
 * 安全基线：contextIsolation 开、nodeIntegration 关、sandbox 开，
 * 渲染进程只能通过 preload 暴露的白名单 API 触达能力。
 *
 * 抽取任务在主进程跑：耗时、可取消、崩溃只影响后台，
 * 不会让渲染进程界面卡死。
 *
 * 启动注意：若环境里存在 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯
 * Node 运行时，报 `Cannot read properties of undefined (reading 'whenReady')`。
 * 该变量由 Electron 在启动前读取，主进程代码无法补救 —— 请用 start.sh
 * 启动，它会先剥离该变量。
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const parser = require('../src/engine/parser');
const { LLMClient } = require('../src/engine/llm');
const { extractAll } = require('../src/engine/extract');
const merge = require('../src/engine/merge');
const sampler = require('../src/engine/sampler');
const agentmode = require('../src/engine/agentmode');
const { loadPalace, slotList } = require('../src/engine/palace');
const { renderCard, cardFileName, validateCard, TYPES, TYPE_ORDER } = require('../src/engine/schema');

const isDev = process.argv.includes('--dev');

// --- 抽取任务管理 -------------------------------------------------------

const jobs = new Map(); // jobId -> { cancelled }

function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#faf9f7',
    title: '记忆铸造厂 · Memory Forge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  // 设置页独立窗口：它是「工具能否运转」的前置条件 ——
  // 没接上 Agent 时工具没有推理能力，所以值得一个独立窗口反复查看。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// 禁止导航到外部页面
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
});

// --- IPC：文件与目录 -----------------------------------------------------

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择要转换的记忆文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '所有支持的格式', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'ndjson', 'log'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: '纯文本', extensions: ['txt'] },
      { name: 'JSON', extensions: ['json', 'jsonl', 'ndjson'] },
      { name: '日志', extensions: ['log'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

ipcMain.handle('dialog:openDirectory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择已有记忆库目录（用于冲突对比，可跳过）',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('fs:readFiles', async (_e, filePaths) => {
  const out = [];
  for (const p of filePaths) {
    try {
      const stat = fs.statSync(p);
      if (stat.size > parser.MAX_FILE_BYTES) {
        out.push({
          path: p, name: path.basename(p),
          error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），已跳过。上限 ${parser.MAX_FILE_BYTES / 1024 / 1024}MB`,
        });
        continue;
      }
      const text = fs.readFileSync(p, 'utf8');
      const parsed = parser.parseContent(p, text);
      out.push({
        path: p,
        name: path.basename(p),
        size: stat.size,
        format: parsed.format,
        stats: parsed.stats,
        // 完整文本随记录一并返回：抽取阶段直接复用这些记录，
        // 不再二次读盘解析（那会把已切好的记录再切一遍）。
        // preview 只供界面展示，不参与抽取。
        records: parsed.records.map((r) => ({
          id: r.id, locator: r.locator, kind: r.kind,
          chars: r.chars, section: r.section || '',
          text: r.text,
          preview: r.text.slice(0, 240),
        })),
      });
    } catch (err) {
      out.push({ path: p, name: path.basename(p), error: err.message });
    }
  }
  return out;
});

ipcMain.handle('fs:readRecordText', async (_e, { filePath, recordIds }) => {
  const parsed = parser.parseContent(filePath, fs.readFileSync(filePath, 'utf8'));
  return parsed.records
    .filter((r) => recordIds.includes(r.id))
    .map((r) => ({ id: r.id, locator: r.locator, text: r.text }));
});

// --- IPC：模型探测 -------------------------------------------------------

ipcMain.handle('llm:detect', async (_e, config) => {
  try {
    return { ok: true, results: await LLMClient.detect(config || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('llm:test', async (_e, config) => {
  try {
    const client = new LLMClient(config);
    const res = await client.chat([
      { role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '返回 {"ok":true}' },
    ]);
    return { ok: true, preview: String(res.content).slice(0, 200), info: client.describe() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC：抽取任务 -------------------------------------------------------

/**
 * 组装抽取输入。
 *
 * 完整模式与试运行唯一的差别就是这里返回的 chunks 怎么来的，
 * 后面的分块 → 抽取 → 去重 → 冲突检测 → 报告完全共用。
 */
function buildChunks({ files, mode, sampleOptions, palaceRoot, chunkBudget }) {
  if (mode === 'trial') {
    const target = sampler.validateTarget(palaceRoot);
    if (!target.ok) return { error: sampler.toError(target) };

    const plan = sampler.planSample(target.cards, sampleOptions || {});
    if (!plan.ok) return { error: sampler.toError({ ...plan, detail: plan.detail }) };

    const records = sampler.sampleToRecords(plan.sampled);
    const chunks = parser.chunkRecords(records, { budget: chunkBudget || 6000 });
    chunks.forEach((c, i) => {
      c._sourceFile = `样本(${plan.target} 条)`;
      c._sourcePath = target.root;
      c._sampledIds = plan.sampled.map((s) => s.id);
      c._samplePlan = plan;
      c._sampleIndex = i;
    });
    return { chunks, plan, target };
  }

  const chunks = [];
  for (const f of files || []) {
    if (f.error || !f.records) continue;
    // 直接用 fs:readFiles 已解析好的 records，不重新读盘解析。
    // 二次 parseContent 会把已切好的记录再切一遍，破坏
    // 「一条记录 = 一段语义」的对应关系，也让界面预览与实际抽取不一致。
    const fileChunks = parser.chunkRecords(f.records, { budget: chunkBudget || 6000 });
    fileChunks.forEach((c) => {
      c._sourceFile = f.name;
      c._sourcePath = f.path;
      chunks.push(c);
    });
  }
  return { chunks };
}

ipcMain.handle('extract:start', async (event, {
  config, files, existingSlots, palaceRoot, chunkBudget, style, mode, sampleOptions,
}) => {
  const jobId = newJobId();
  const ctrl = { cancelled: false };
  jobs.set(jobId, ctrl);

  const isTrial = mode === 'trial';
  const assembled = buildChunks({ files, mode, sampleOptions, palaceRoot, chunkBudget });
  if (assembled.error) {
    jobs.delete(jobId);
    return { jobId: null, error: assembled.error };
  }
  const { chunks, plan } = assembled;

  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };

  // 异步执行，立即返回 jobId
  (async () => {
    try {
      const client = new LLMClient(config);
      const result = await extractAll(client, chunks, {
        existingSlots: existingSlots || [],
        palaceRoot,
        style: style || 'auto',
        onProgress: (p) => send('extract:progress', { jobId, mode: isTrial ? 'trial' : 'full', ...p }),
        onChunkDone: (r) => {
          if (r.error) {
            send('extract:chunkError', {
              jobId,
              chunkIndex: r.chunkIndex,
              error: r.error,
              raw: r.raw || '',
              sourceFile: chunks[r.chunkIndex] ? chunks[r.chunkIndex]._sourceFile : '',
            });
          }
        },
      });

      if (ctrl.cancelled) {
        send('extract:cancelled', { jobId });
        return;
      }

      result.cards.forEach((c) => {
        const chunk = chunks[c._chunkIndex];
        if (chunk) {
          c._sourceFile = chunk._sourceFile;
          c.source = isTrial ? 'forge:trial' : `forge:${chunk._sourceFile}`;
        }
      });

      const { kept, dropped } = merge.dedupe(result.cards);
      const internalConflicts = merge.findInternalConflicts(kept);

      let baselineCards = [];
      let baselineInfo = null;
      if (palaceRoot) {
        const base = loadPalace(palaceRoot);
        baselineCards = base.cards;
        baselineInfo = {
          cardCount: base.cards.length,
          maxSeq: base.maxSeq,
          problems: base.problems,
          found: base.found,
        };
      }
      const baselineCmp = merge.compareWithBaseline(kept, baselineCards);

      // 试运行：额外生成抽样与组织结构报告，且绝不写盘
      let trialReport = null;
      if (isTrial && plan) {
        trialReport = sampler.buildReport(plan, {
          cards: kept,
          deduped: dropped,
          internalConflicts,
          errors: result.errors,
        });
        trialReport.summary = sampler.summarize(trialReport);
      }

      send('extract:done', {
        jobId,
        mode: isTrial ? 'trial' : 'full',
        cards: kept,
        deduped: dropped,
        internalConflicts,
        baselineConflicts: baselineCmp.conflicts,
        newSlots: baselineCmp.newSlots,
        uncoveredSlots: baselineCmp.updates,
        errors: result.errors,
        rejected: result.rejected,
        chunkCount: chunks.length,
        baselineInfo,
        trialReport,
        // 试运行固化参数，确认后可直接复用
        sampleOptions: plan ? {
          strategy: plan.strategy,
          statusScope: plan.statusScope,
          seed: plan.seed,
          ratio: plan.ratio,
          count: plan.ratio ? null : plan.target,
          poolSize: plan.poolSize,
          totalSize: plan.totalSize,
        } : null,
      });
    } catch (err) {
      send('extract:failed', { jobId, error: err.message, stack: err.stack });
    } finally {
      jobs.delete(jobId);
    }
  })();

  return { jobId, chunkCount: chunks.length, mode: isTrial ? 'trial' : 'full' };
});

ipcMain.handle('extract:cancel', (_e, { jobId }) => {
  const job = jobs.get(jobId);
  if (job) {
    job.cancelled = true;
    return { ok: true };
  }
  return { ok: false, error: '任务不存在或已结束' };
});

// --- IPC：schema 元信息 ---------------------------------------------------

ipcMain.handle('meta:types', async () => {
  return {
    types: TYPE_ORDER.map((k) => ({ key: k, ...TYPES[k] })),
  };
});

// --- IPC：导出 ------------------------------------------------------------

ipcMain.handle('export:preview', async (_e, { cards, startSeq }) => {
  const withIds = merge.assignIds(cards, startSeq || 1);
  const check = merge.finalCheck(withIds.map((x) => ({ ...x.card, id: x.id })));
  const byType = {};
  check.ok.forEach((c) => { byType[c.type] = (byType[c.type] || 0) + 1; });
  return {
    ok: check.ok.map((c) => ({ id: c.id, title: c.title, type: c.type, slot: `${c.subject}::${c.predicate}` })),
    rejected: check.rejected.map((r) => ({
      title: r.card.title || '(无标题)', type: r.card.type,
      slot: `${r.card.subject || '?'}::${r.card.predicate || '?'}`,
      problems: r.problems,
    })),
    byType,
    total: cards.length,
    nextSeq: withIds.length ? parseInt(withIds[withIds.length - 1].id.replace('mem_', ''), 10) + 1 : startSeq || 1,
  };
});

ipcMain.handle('export:write', async (_e, { cards, targetDir, startSeq, mode }) => {
  // 只读守卫：试运行绝不允许写入任何记忆库。
  // 这条检查放在主进程而非渲染进程，因为写盘是危险动作，
  // 不能依赖界面是否正确传参。
  if (mode === 'trial' || mode === 'preview') {
    return { ok: false, error: '试运行模式不会写入任何文件。请确认结果后切换到完整模式。' };
  }
  if (!targetDir) {
    return { ok: false, error: '未指定目标目录' };
  }
  // mode: 'merge' 写入 cards/<type>/；'archive' 写入 archive/
  const withIds = merge.assignIds(cards, startSeq || 1);
  const check = merge.finalCheck(withIds.map((x) => ({ ...x.card, id: x.id })));
  if (check.rejected.length && !forceAllowed(check.rejected)) {
    return { ok: false, error: '存在不合规卡片', rejected: check.rejected };
  }

  const written = [];
  const failed = [];
  const backupRoot = path.join(targetDir, '.palace', 'import-backups');

  for (const card of check.ok) {
    const sub = mode === 'archive' ? path.join('archive', card.type) : path.join('cards', card.type);
    const dir = path.join(targetDir, sub);
    const file = path.join(dir, cardFileName(card.id, card.title));
    try {
      fs.mkdirSync(dir, { recursive: true });

      // 若已存在同名文件（同一 id），先备份再覆盖
      if (fs.existsSync(file)) {
        fs.mkdirSync(backupRoot, { recursive: true });
        const bak = path.join(backupRoot, `${card.id}-${Date.now()}.md`);
        fs.copyFileSync(file, bak);
      }

      fs.writeFileSync(file, renderCard(card, card.id), 'utf8');
      written.push({ id: card.id, file, rel: path.join(sub, cardFileName(card.id, card.title)) });
    } catch (err) {
      failed.push({ id: card.id, error: err.message });
    }
  }

  // 同步 palace 的 seq.txt，保证后续 CLI 不会分配重复 ID
  let seqUpdated = false;
  try {
    const seqPath = path.join(targetDir, '.palace', 'seq.txt');
    fs.mkdirSync(path.dirname(seqPath), { recursive: true });
    const current = parseInt(fs.readFileSync(seqPath, 'utf8').trim() || '0', 10) || 0;
    const next = withIds.length ? parseInt(withIds[withIds.length - 1].id.replace('mem_', ''), 10) : current;
    if (next > current) {
      fs.writeFileSync(seqPath, `${next}\n`, 'utf8');
      seqUpdated = true;
    }
  } catch (_) { /* seq 同步失败不阻断导入 */ }

  return { ok: true, written, failed, seqUpdated, rejected: check.rejected };
});

function forceAllowed(rejected) {
  return rejected.every((r) => r.problems.every((p) => p.includes('超过') || p.includes('上限')));
}

// --- IPC：窗口 -----------------------------------------------------------

ipcMain.handle('window:openSettings', async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 860,
    minWidth: 720,
    minHeight: 640,
    backgroundColor: '#faf9f7',
    title: '连接设置 · 记忆铸造厂',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'));
  return { ok: true };
});

ipcMain.handle('window:openAbout', async () => {
  await shell.openExternal('https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp');
  return { ok: true };
});

// --- IPC：配置与 Agent 适配 ----------------------------------------------

/**
 * 检测宿主 Agent 状态。
 * 工具本身不独立运行 —— 它没有内置模型，需要 Agent 驱动，
 * 所以「Agent 是否就绪」是工具可用性的前提，必须显式呈现。
 */
ipcMain.handle('config:detectAgent', async (_e, { agent }) => {
  const adapter = require('../src/engine/agentAdapter');
  try {
    return adapter.detectAgent(agent || 'hermes');
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:listAgents', async () => {
  const adapter = require('../src/engine/agentAdapter');
  return {
    agents: Object.values(adapter.ADAPTERS).map((a) => ({
      key: a.key,
      label: a.label,
      status: a.status,
      mcpSupport: a.mcpSupport,
      notes: a.notes,
      docsUrl: a.docsUrl,
    })),
  };
});

ipcMain.handle('config:previewSnippet', async (_e, { agent, toolFilter }) => {
  const adapter = require('../src/engine/agentAdapter');
  const serverPath = path.join(__dirname, '..', 'bin', 'forge-mcp.js');
  const built = adapter.buildConfigSnippet(agent || 'hermes', {
    serverPath, toolFilter: toolFilter || null,
  });
  return {
    ok: true,
    snippet: built.snippet,
    full: built.full,
    serverPath,
    serverExists: fs.existsSync(built.serverPath),
  };
});

ipcMain.handle('config:install', async (_e, { agent, toolFilter }) => {
  const adapter = require('../src/engine/agentAdapter');
  try {
    const res = adapter.installConfig(agent || 'hermes', {
      serverPath: path.join(__dirname, '..', 'bin', 'forge-mcp.js'),
      toolFilter: toolFilter || null,
    });
    // 安装后立刻自检，让用户立刻知道能不能跑通
    if (res.ok) {
      const test = await adapter.selfTest(res.serverPath);
      res.selfTest = test;
    }
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:uninstall', async (_e, { agent }) => {
  const adapter = require('../src/engine/agentAdapter');
  try {
    return adapter.uninstallConfig(agent || 'hermes');
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('config:selfTest', async (_e, { serverPath }) => {
  const adapter = require('../src/engine/agentAdapter');
  const p = serverPath || path.join(__dirname, '..', 'bin', 'forge-mcp.js');
  try {
    return await adapter.selfTest(p);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** 列出 MCP 工具清单，供界面展示 */
ipcMain.handle('config:listTools', async () => {
  const { TOOL_DEFS } = require('../bin/forge-mcp.js');
  return {
    tools: TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description.split('\n')[0].slice(0, 100),
      required: (t.inputSchema && t.inputSchema.required) || [],
    })),
  };
});

// --- IPC：格式探查 -------------------------------------------------------

/**
 * 生成探查任务包 —— 让 agent 先勘察未知格式。
 *
 * 存在的意义：规则解析器面对 Codex 会话那种
 * `{"content":[{"text":"..."}]}` 结构时，会只取到顶层字符串字段
 * 而把真正有意义的内容整个丢掉。让能理解语义的一方先看一眼。
 */
ipcMain.handle('probe:makeTask', async (_e, { filePaths }) => {
  const probe = require('../src/engine/probe');
  const files = [];
  const previews = [];

  for (const p of filePaths || []) {
    if (!fs.existsSync(p)) continue;
    files.push({ path: p, name: path.basename(p) });
    try {
      const s = probe.sampleFile(p);
      // 只把结构摘要送回界面（不送 head 内容，避免界面刷屏）
      const marks = [];
      if (s.jsonLineRate > 0.7) marks.push('JSONL');
      if (s.roleMarkers?.role_user || s.roleMarkers?.chatgpt_mapping) marks.push('对话');
      if (s.nestedContentLines > 0) marks.push('嵌套内容');
      if (s.csvLike) marks.push(`CSV`);
      if (s.yamlLikeKeys > 0 && s.indentedRatio > 0.2) marks.push('YAML');
      if (s.timestampRatio > 0.4) marks.push('日志');
      if (s.headingCount > 2) marks.push('Markdown');
      previews.push({
        name: s.name,
        chars: s.chars,
        ruleGuess: s.ruleGuess,
        marks,
        nestedContentLines: s.nestedContentLines,
        csvLike: s.csvLike,
        jsonLineRate: s.jsonLineRate,
      });
    } catch (err) {
      previews.push({ name: path.basename(p), error: err.message });
    }
  }

  if (!files.length) {
    return { ok: false, error: '没有可探查的文件' };
  }

  const out = path.join(app.getPath('temp'), `forge-probe-${Date.now()}`);
  const pkg = probe.writeProbeTask(out, { files, meta: {} });
  return {
    ok: true,
    root: pkg.root,
    fileCount: pkg.manifest.fileCount,
    instructionsPath: pkg.instructionsPath,
    instructions: fs.readFileSync(pkg.instructionsPath, 'utf8'),
    manifest: pkg.manifest,
    previews,
    strategies: probe.STRATEGIES,
  };
});

ipcMain.handle('probe:status', async (_e, { probeDir }) => {
  const probe = require('../src/engine/probe');
  try {
    return probe.probeStatus(probeDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 按配方切分，生成抽取任务包。
 */
ipcMain.handle('probe:split', async (_e, { probeDir, chunkBudget }) => {
  const probe = require('../src/engine/probe');
  const splitter = require('../src/engine/splitByRecipe');
  try {
    const loaded = probe.loadRecipes(probeDir);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    if (!loaded.recipes.length) {
      return {
        ok: false,
        error: `没有可用配方。${loaded.missing.length} 个文件未提交探查结果，请让 agent 先完成探查。`,
        missing: loaded.missing,
      };
    }

    const built = splitter.buildChunksFromRecipes(
      loaded.manifest.files, loaded,
      { budget: chunkBudget || 6000 }
    );
    if (!built.chunks.length) {
      return { ok: false, error: '切分后没有内容，请检查配方' };
    }

    const out = path.join(app.getPath('temp'), `forge-task-${Date.now()}`);
    const pkg = agentmode.writeTaskPackage(out, {
      chunks: built.chunks,
      meta: {
        sourceDesc: `${loaded.recipes.length} 个按探查配方切分的文件`,
        style: 'auto',
        existingSlots: [],
      },
    });

    return {
      ok: true,
      root: pkg.root,
      chunkCount: pkg.manifest.chunkCount,
      instructionsPath: pkg.instructionsPath,
      manifest: pkg.manifest,
      perFile: built.perFile,
      missing: loaded.missing.map((m) => m.name),
      invalid: loaded.invalid,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC：Agent 驱动模式 --------------------------------------------------

/**
 * 生成 agent 抽取任务包。
 *
 * 这是「不配置模型」的关键：GUI 负责解析切分，agent 负责理解。
 */
ipcMain.handle('agent:makeTask', async (_e, { files, palaceRoot, chunkBudget, style }) => {
  const chunks = [];
  for (const f of files || []) {
    if (f.error || !f.records) continue;
    parser.chunkRecords(f.records, { budget: chunkBudget || 6000 }).forEach((c) => {
      c._sourceFile = f.name;
      c._sourcePath = f.path;
      chunks.push(c);
    });
  }
  if (!chunks.length) {
    return { ok: false, error: '没有可处理的文件' };
  }

  const out = path.join(app.getPath('temp'), `forge-task-${Date.now()}`);
  const meta = {
    sourceDesc: `${(files || []).filter((f) => !f.error).length} 个文件`,
    style: style || 'auto',
    existingSlots: palaceRoot ? slotList(loadPalace(palaceRoot).cards, 60) : [],
  };
  const pkg = agentmode.writeTaskPackage(out, { chunks, meta });

  // 任务包放在临时目录，GUI 不主动写用户的磁盘位置；由 agent 决定后续
  return {
    ok: true,
    root: pkg.root,
    chunkCount: pkg.manifest.chunkCount,
    instructionsPath: pkg.instructionsPath,
    instructions: fs.readFileSync(pkg.instructionsPath, 'utf8'),
    manifest: pkg.manifest,
  };
});

/** 只读查看任务进度 */
ipcMain.handle('agent:status', async (_e, { taskDir }) => {
  try {
    return agentmode.taskStatus(taskDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 导入 agent 产出的结果，跑与直连模式完全相同的下游管线。
 */
ipcMain.handle('agent:import', async (_e, { taskDir, palaceRoot, samplePlan, sampleStats }) => {
  let res;
  try {
    res = agentmode.importResults(taskDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) return res;

  const cards = res.cards.map((c, i) => ({ ...c, _localId: c._localId || `A${i + 1}` }));

  const dd = merge.dedupe(cards);
  const internalConflicts = merge.findInternalConflicts(dd.kept);

  let baselineCards = [];
  let baselineInfo = null;
  if (palaceRoot) {
    const base = loadPalace(palaceRoot);
    baselineCards = base.cards;
    baselineInfo = { cardCount: base.cards.length, maxSeq: base.maxSeq, found: base.found };
  }
  const baselineCmp = merge.compareWithBaseline(dd.kept, baselineCards);

  // 浅尝模式：前端带上抽样计划与样本构成，这里产出预览报告
  let trialReport = null;
  if (samplePlan) {
    trialReport = sampler.buildReport(
      { ...samplePlan, sampled: sampleStats || [] },
      { cards: dd.kept, deduped: dd.dropped, internalConflicts, errors: [] },
    );
    trialReport.summary = sampler.summarize(trialReport);
  }

  return {
    ok: true,
    mode: samplePlan ? 'trial' : 'agent',
    cards: dd.kept,
    deduped: dd.dropped,
    internalConflicts,
    baselineConflicts: baselineCmp.conflicts,
    newSlots: baselineCmp.newSlots,
    errors: [],
    rejected: res.rejected,
    progress: res.progress,
    perChunk: res.perChunk,
    baselineInfo,
    trialReport,
  };
});

/** 任务包目录 → 写入记忆库（与 export:write 同一套 ID 分配与渲染逻辑） */
ipcMain.handle('agent:write', async (_e, { cards, targetDir, startSeq }) => {
  if (!targetDir) return { ok: false, error: '未指定目标目录' };
  const withIds = merge.assignIds(cards, startSeq || 1);
  const check = merge.finalCheck(withIds.map((x) => ({ ...x.card, id: x.id })));
  if (check.rejected.length) {
    return { ok: false, error: '存在不合规卡片', rejected: check.rejected };
  }
  const written = [];
  const failed = [];
  for (const card of check.ok) {
    const dir = path.join(targetDir, 'cards', card.type);
    const file = path.join(dir, cardFileName(card.id, card.title));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, renderCard(card, card.id), 'utf8');
      written.push({ id: card.id, rel: path.join('cards', card.type, cardFileName(card.id, card.title)) });
    } catch (err) {
      failed.push({ id: card.id, error: err.message });
    }
  }
  try {
    const seqPath = path.join(targetDir, '.palace', 'seq.txt');
    fs.mkdirSync(path.dirname(seqPath), { recursive: true });
    const cur = parseInt(fs.readFileSync(seqPath, 'utf8').trim() || '0', 10) || 0;
    const next = withIds.length ? parseInt(withIds[withIds.length - 1].id.replace('mem_', ''), 10) : cur;
    if (next > cur) fs.writeFileSync(seqPath, `${next}\n`, 'utf8');
  } catch (_) { /* seq 同步失败不阻断 */ }
  return { ok: true, written, failed };
});

// --- IPC：浅尝模式 -------------------------------------------------------

/**
 * 试运行前置检查。返回记忆库概况与抽样能力，供界面渲染参数选项。
 * 只读，不写任何文件。
 */
ipcMain.handle('trial:inspect', async (_e, { palaceRoot, sampleOptions }) => {
  const target = sampler.validateTarget(palaceRoot);
  if (!target.ok) {
    return { ok: false, error: sampler.toError(target), strategies: sampler.STRATEGIES };
  }

  const plan = sampler.planSample(target.cards, sampleOptions || {});
  if (!plan.ok) {
    return {
      ok: false,
      error: sampler.toError({ ...plan, detail: plan.detail }),
      strategies: sampler.STRATEGIES,
      scopes: sampler.STATUS_SCOPES,
      library: {
        cardCount: target.cards.length,
        problems: target.problems,
        byType: target.cards.reduce((acc, c) => {
          acc[c.type] = (acc[c.type] || 0) + 1; return acc;
        }, {}),
        activeCount: target.cards.filter((c) => c.status === 'active').length,
        uniqueSlots: new Set(target.cards.map((c) => `${c.subject}::${c.predicate}`)).size,
      },
    };
  }

  return {
    ok: true,
    strategies: sampler.STRATEGIES,
    scopes: sampler.STATUS_SCOPES,
    library: {
      root: target.root,
      cardCount: target.cards.length,
      activeCount: target.cards.filter((c) => c.status === 'active').length,
      uniqueSlots: new Set(target.cards.map((c) => `${c.subject}::${c.predicate}`)).size,
      byType: target.cards.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {}),
      problems: target.problems,
    },
    plan: {
      requested: plan.target,
      poolSize: plan.poolSize,
      totalSize: plan.totalSize,
      strategy: plan.strategy,
      statusScope: plan.statusScope,
      seed: plan.seed,
      ratio: plan.ratio,
      coverageRatio: Number((plan.target / plan.poolSize).toFixed(4)),
      warnings: plan.warnings,
      sample: plan.sampled.slice(0, 30).map((c) => ({
        id: c.id, title: c.title, type: c.type, status: c.status,
        slot: `${c.subject}::${c.predicate}`, value: c.value,
      })),
      sampleTotal: plan.sampled.length,
    },
  };
});

/**
 * 确认试运行结果后，固化参数供正式全量运行复用。
 * 只回传参数，不执行任何抽取。
 */
ipcMain.handle('trial:commitParams', async (_e, { sampleOptions, mode, chunkBudget, style, config }) => {
  return {
    ok: true,
    message: '已按试运行参数准备全量运行，请确认模式与目标目录。',
    params: {
      mode: mode === 'full' ? 'full' : 'trial',
      chunkBudget: chunkBudget || 6000,
      style: style || 'auto',
      // 试运行的抽样参数不带到全量：全量要处理全部记忆
      sampleOptions: null,
      config: config || null,
      carriedFrom: sampleOptions ? {
        strategy: sampleOptions.strategy,
        statusScope: sampleOptions.statusScope,
        seed: sampleOptions.seed,
        sampledCount: sampleOptions.count,
        poolSize: sampleOptions.poolSize,
      } : null,
    },
  };
});

ipcMain.handle('meta:strategies', async () => {
  return { strategies: sampler.STRATEGIES, scopes: sampler.STATUS_SCOPES };
});

// --- IPC：palace 读取 -----------------------------------------------------

ipcMain.handle('palace:load', async (_e, { root }) => {
  const res = loadPalace(root);
  return {
    ok: true,
    cardCount: res.cards.length,
    maxSeq: res.maxSeq,
    problems: res.problems,
    found: res.found,
    slots: slotList(res.cards, 100),
    sample: res.cards.slice(0, 5).map((c) => ({
      id: c.id, title: c.title, slot: `${c.subject}::${c.predicate}`, value: c.value, status: c.status,
    })),
  };
});
