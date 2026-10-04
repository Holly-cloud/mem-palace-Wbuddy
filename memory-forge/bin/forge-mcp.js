'use strict';
/**
 * MCP Server —— 让 hermes agent 驱动记忆铸造厂。
 *
 * ## 为什么需要 MCP 而不是让 agent 走 CLI
 *
 * 走 CLI 的话，agent 需要知道：
 *   - 工具装在哪（绝对路径）
 *   - 命令怎么拼（task/probe/split/import 各有参数）
 *   - 中间产物落在哪（任务包目录、results 文件名规则）
 *
 * 这些都是「实现细节」，agent 每轮都得重新推断，一旦猜错就整条流程断掉。
 *
 * 走 MCP 的话，agent 只需要理解一件事：**有哪些工具、各自做什么**。
 * 路径、参数、文件名规则全由 server 内部维护。工具名语义化到可以直接
 * 当自然语言用，比如 `forge_read_chunk`。
 *
 * 所以 MCP server 的设计原则是：**把工作流的知识固化进工具的语义里**，
 * 而不是让 agent 记住一串命令。
 *
 * ## 工具分组
 *
 *   勘察：probe_start / probe_read_sample / probe_write_recipe / probe_status
 *   切分：split_by_recipe
 *   抽取：task_start / task_read_chunk / task_write_result / task_status
 *   汇总：import_results / palace_doctor / palace_search
 *
 * 分组的意义是让 agent 能分阶段推进，也方便按需筛选
 * （hermes 支持 tools.include 白名单，只暴露用得到的工具）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE = path.join(__dirname, '..', 'src', 'engine');
const parser = require(path.join(ENGINE, 'parser'));
const probe = require(path.join(ENGINE, 'probe'));
const splitter = require(path.join(ENGINE, 'splitByRecipe'));
const agentmode = require(path.join(ENGINE, 'agentmode'));
const merge = require(path.join(ENGINE, 'merge'));
const sampler = require(path.join(ENGINE, 'sampler'));
const { loadPalace } = require(path.join(ENGINE, 'palace'));
const { TYPES, TYPE_ORDER, LINK_RELATIONS } = require(path.join(ENGINE, 'schema'));

// --- 工作区管理 ---------------------------------------------------------
//
// 任务包是中间产物，需要一个稳定的工作区，而不是散在系统临时目录 ——
// agent 需要能预测路径、事后能回看。

function workspaceRoot() {
  const override = process.env.FORGE_WORKSPACE;
  if (override) return path.resolve(override);
  const home = os.homedir();
  return path.join(home, '.memory-forge', 'workspace');
}

function ensureWorkspace() {
  const root = workspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 任务状态：把任务包目录登记到索引，方便按任务 ID 查找。
 * 不用记忆 agent 记路径 —— 它只需要报 task_id。
 */
function indexPath() {
  return path.join(ensureWorkspace(), 'tasks.json');
}

function loadTaskIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveTaskIndex(idx) {
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf8');
}

function registerTask(taskId, kind, dir, extra = {}) {
  const idx = loadTaskIndex();
  idx[taskId] = { id: taskId, kind, dir, createdAt: new Date().toISOString(), ...extra };
  saveTaskIndex(idx);
  return idx[taskId];
}

function resolveTaskDir(taskId) {
  const idx = loadTaskIndex();
  if (idx[taskId]) {
    if (fs.existsSync(idx[taskId].dir)) return idx[taskId].dir;
    // 登记的目录已不存在，回退到按约定路径查找
  }
  // 容错：允许直接传路径
  if (taskId && fs.existsSync(taskId) && fs.statSync(taskId).isDirectory()) {
    return path.resolve(taskId);
  }
  return null;
}

function taskDirOf(dir) {
  return dir || path.join(ensureWorkspace(), 'scratch');
}

// --- 工具实现 -----------------------------------------------------------

const tools = {};

/**
 * 勘察文件格式，生成探查任务。
 * 返回的 sampledFiles 里带结构统计，agent 据此判断该怎么切。
 */
tools.probe_start = ({ files, taskId }) => {
  if (!Array.isArray(files) || !files.length) {
    return { ok: false, error: '请提供 files 数组（至少一个文件路径）' };
  }
  const entries = [];
  const previews = [];
  const missing = [];

  for (const f of files) {
    const p = path.resolve(String(f));
    if (!fs.existsSync(p)) { missing.push(String(f)); continue; }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      // 目录 → 展开一层（常见做法：直接传记忆库目录）
      fs.readdirSync(p).forEach((name) => {
        const sub = path.join(p, name);
        if (fs.statSync(sub).isFile()) entries.push({ path: sub, name });
      });
      continue;
    }
    entries.push({ path: p, name: path.basename(p) });
  }

  if (!entries.length) {
    return { ok: false, error: `没有可探查的文件${missing.length ? '：' + missing.join('、') : ''}` };
  }

  const id = taskId || `probe-${Date.now()}`;
  const out = path.join(taskDirOf(), id);
  const pkg = probe.writeProbeTask(out, { files: entries, meta: {} });
  registerTask(id, 'probe', pkg.root, { fileCount: entries.length });

  // 结构速览 —— 直接给 agent 判读依据
  const overview = [];
  for (const f of entries) {
    const s = probe.sampleFile(f.path);
    const signals = [];
    if (s.jsonLineRate > 0.7) signals.push('JSONL');
    if (s.roleMarkers.role_user || s.roleMarkers.role_assistant || s.roleMarkers.chatgpt_mapping) signals.push('对话');
    if (s.nestedContentLines > 0) signals.push('含嵌套内容数组（规则解析会丢失，必须在配方里用 a[].text 路径）');
    if (s.csvLike) signals.push('CSV');
    if (s.yamlLikeKeys > 0 && s.indentedRatio > 0.2) signals.push('YAML');
    if (s.timestampRatio > 0.4) signals.push('日志时间戳');
    if (s.headingCount > 2) signals.push('Markdown 标题');
    overview.push({
      file: f.name,
      chars: s.chars,
      lines: s.lines,
      ruleGuess: s.ruleGuess,
      signals,
      sampleFile: `${path.basename(pkg.root)}/${f.samplePath}`,
      recipeFile: `${path.basename(pkg.root)}/${f.recipePath}`,
    });
  }

  return {
    ok: true,
    taskId: id,
    taskDir: pkg.root,
    fileCount: entries.length,
    missing,
    instructionsFile: path.join(pkg.root, 'INSTRUCTIONS.md'),
    overview,
    nextSteps: [
      `读取 ${path.join(pkg.root, 'samples/')} 下每个 JSON，里面是文件头尾片段与结构统计`,
      '为每个文件写一份切分配方，调用 forge_probe_write_recipe',
      '全部写完后调用 forge_split_by_recipe',
    ],
    strategies: Object.keys(probe.STRATEGIES),
  };
};

/**
 * 读取某个文件的结构采样 —— agent 判断格式的依据。
 */
tools.probe_read_sample = ({ taskId, file }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到探查任务 ${taskId}` };

  const mPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mPath)) return { ok: false, error: '任务目录不是有效的探查任务' };
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));

  const entry = manifest.files.find(
    (f) => f.name === file || f.id === file || f.samplePath.includes(file)
  );
  if (!entry) {
    return {
      ok: false,
      error: `任务里没有文件 ${file}`,
      available: manifest.files.map((f) => ({ id: f.id, name: f.name })),
    };
  }

  const sPath = path.join(dir, entry.samplePath);
  if (!fs.existsSync(sPath)) return { ok: false, error: `采样文件不存在：${entry.samplePath}` };
  const sample = JSON.parse(fs.readFileSync(sPath, 'utf8'));

  return {
    ok: true,
    file: entry.name,
    // 结构统计全部是机械计算结果，不含判断，作为 agent 的判断依据
    structure: {
      chars: sample.chars,
      lines: sample.lines,
      jsonLineRate: sample.jsonLineRate,
      nestedContentLines: sample.nestedContentLines,
      roleMarkers: sample.roleMarkers,
      csvLike: sample.csvLike,
      csvColumns: sample.csvColumns,
      yamlLikeKeys: sample.yamlLikeKeys,
      indentedRatio: sample.indentedRatio,
      timestampRatio: sample.timestampRatio,
      headingCount: sample.headingCount,
      separatorCandidates: sample.separatorCandidates,
    },
    head: sample.head,
    tail: sample.tail || '',
    recipeFile: `${path.basename(dir)}/${entry.recipePath}`,
  };
};

/**
 * 写一份切分配方。
 */
tools.probe_write_recipe = ({ taskId, file, strategy, fields, includeMeta, separator, note }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到探查任务 ${taskId}` };

  const mPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mPath)) return { ok: false, error: '任务目录不是有效的探查任务' };
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));

  const entry = manifest.files.find((f) => f.name === file || f.id === file);
  if (!entry) {
    return {
      ok: false,
      error: `任务里没有文件 ${file}`,
      available: manifest.files.map((f) => ({ id: f.id, name: f.name })),
    };
  }

  const recipe = { file: entry.name, strategy, fields: fields || {} };
  if (includeMeta && includeMeta.length) recipe.includeMeta = includeMeta;
  if (separator) recipe.separator = separator;
  if (note) recipe.note = note;

  const problems = probe.validateRecipe(recipe);
  if (problems.length) {
    return {
      ok: false,
      error: `配方不合法：${problems.join('；')}`,
      problems,
      availableStrategies: Object.keys(probe.STRATEGIES),
    };
  }

  const rPath = path.join(dir, entry.recipePath);
  fs.mkdirSync(path.dirname(rPath), { recursive: true });
  fs.writeFileSync(rPath, JSON.stringify(recipe, null, 2), 'utf8');

  // 返回整体进度，让 agent 知道还剩几个
  const st = probe.probeStatus(dir);
  return {
    ok: true,
    file: entry.name,
    strategy,
    progress: { done: st.done, total: st.total, percent: st.percent },
    remaining: st.files.filter((f) => f.state !== 'ok').map((f) => f.name),
  };
};

tools.probe_status = ({ taskId }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到探查任务 ${taskId}` };
  const st = probe.probeStatus(dir);
  if (!st.ok) return st;
  return {
    ok: true,
    progress: { done: st.done, total: st.total, percent: st.percent },
    files: st.files,
  };
};

/**
 * 按配方切分，生成抽取任务。
 */
tools.split_by_recipe = ({ taskId, taskIdOut, chunkBudget }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到探查任务 ${taskId}` };

  const loaded = probe.loadRecipes(dir);
  if (!loaded.ok) return loaded;
  if (!loaded.recipes.length) {
    return {
      ok: false,
      error: '没有可用配方。先为每个文件调用 forge_probe_write_recipe。',
      missing: loaded.missing.map((m) => m.name),
    };
  }

  const built = splitter.buildChunksFromRecipes(
    loaded.manifest.files, loaded, { budget: Number(chunkBudget) || 6000 }
  );
  if (!built.chunks.length) return { ok: false, error: '切分后没有内容，请检查配方' };

  const id = taskIdOut || `task-${Date.now()}`;
  const out = path.join(taskDirOf(), id);
  const pkg = agentmode.writeTaskPackage(out, {
    chunks: built.chunks,
    meta: { sourceDesc: `${loaded.recipes.length} 个按探查配方切分的文件`, style: 'auto' },
  });
  registerTask(id, 'extract', pkg.root, { chunkCount: pkg.manifest.chunkCount });

  return {
    ok: true,
    taskId: id,
    taskDir: pkg.root,
    chunkCount: pkg.manifest.chunkCount,
    instructionsFile: pkg.instructionsPath,
    perFile: built.perFile,
    fallbackFiles: loaded.missing.map((m) => m.name),
    invalidRecipes: loaded.invalid,
    nextSteps: [
      `读取 ${pkg.instructionsPath} 了解抽取规范`,
      `调用 forge_task_read_chunk 逐块读取内容`,
      '抽取结果用 forge_task_write_result 写回',
      '全部完成后调用 forge_import_results',
    ],
  };
};

/**
 * 跳过探查，直接生成抽取任务（格式已知时用）。
 */
tools.task_start = ({ files, taskId, chunkBudget, palaceRoot }) => {
  if (!Array.isArray(files) || !files.length) {
    return { ok: false, error: '请提供 files 数组' };
  }
  const chunks = [];
  const missing = [];
  for (const f of files) {
    const p = path.resolve(String(f));
    if (!fs.existsSync(p)) { missing.push(String(f)); continue; }
    if (fs.statSync(p).isDirectory()) {
      fs.readdirSync(p).forEach((name) => {
        const sub = path.join(p, name);
        if (fs.statSync(sub).isFile()) {
          parser.chunkRecords(
            parser.parseContent(sub, fs.readFileSync(sub, 'utf8')).records,
            { budget: Number(chunkBudget) || 6000 }
          ).forEach((c) => { c._sourceFile = name; c._sourcePath = sub; chunks.push(c); });
        }
      });
      continue;
    }
    parser.chunkRecords(
      parser.parseContent(p, fs.readFileSync(p, 'utf8')).records,
      { budget: Number(chunkBudget) || 6000 }
    ).forEach((c) => { c._sourceFile = path.basename(p); c._sourcePath = p; chunks.push(c); });
  }

  if (!chunks.length) {
    return { ok: false, error: `没有可处理的内容${missing.length ? '：' + missing.join('、') : ''}` };
  }

  let existingSlots = [];
  if (palaceRoot && fs.existsSync(palaceRoot)) {
    try { existingSlots = agentmode ? require(path.join(ENGINE, 'palace')).slotList(loadPalace(palaceRoot).cards, 60) : []; }
    catch (_) { existingSlots = []; }
  }

  const id = taskId || `task-${Date.now()}`;
  const out = path.join(taskDirOf(), id);
  const pkg = agentmode.writeTaskPackage(out, {
    chunks,
    meta: { sourceDesc: `${files.length} 个文件`, style: 'auto', existingSlots },
  });
  registerTask(id, 'extract', pkg.root, { chunkCount: pkg.manifest.chunkCount });

  return {
    ok: true,
    taskId: id,
    taskDir: pkg.root,
    chunkCount: pkg.manifest.chunkCount,
    instructionsFile: pkg.instructionsPath,
    fallbackFiles: missing,
    nextSteps: [
      `读取 ${pkg.instructionsPath} 了解抽取规范`,
      '调用 forge_task_read_chunk 逐块读取',
      '调用 forge_task_write_result 写回结果',
    ],
  };
};

/**
 * 读取一个分块的内容。这是 agent 抽取时的主要数据入口。
 */
/**
 * 按 index 或 id 定位分块。
 *
 * 必须区分「数字」与「id 字符串」：chunk 的 id 是 `001` 这样的三位零填充，
 * 若把传入的 `1` 也拿去当 id 匹配 `001`，就会命中另一个分块 ——
 * agent 写错分块时内容会静默落到别人的结果文件里。
 * 纯数字一律按 index 处理；非数字才按 id 处理。
 */
function findChunk(manifest, ref) {
  const chunks = manifest.chunks || [];
  if (ref === undefined || ref === null) return null;
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && String(ref).trim() !== '') {
    return chunks.find((c) => c.index === asNum) || null;
  }
  const id = String(ref).trim();
  return chunks.find((c) => c.id === id) || null;
}

tools.task_read_chunk = ({ taskId, index }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到任务 ${taskId}` };

  const mPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mPath)) return { ok: false, error: '任务目录无效' };
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));

  const chunks = manifest.chunks || [];
  if (index === undefined || index === null) {
    const st = agentmode.taskStatus(dir);
    return {
      ok: true,
      total: chunks.length,
      progress: { done: st.done, total: st.total, percent: st.percent },
      chunks: chunks.map((c) => ({
        index: c.index, id: c.id, sourceFile: c.sourceFile,
        chars: c.chars, recordCount: c.recordCount, resultPath: c.resultPath,
      })),
    };
  }

  const entry = findChunk(manifest, index);
  if (!entry) {
    return { ok: false, error: `没有分块 ${index}`, total: chunks.length };
  }

  const mdPath = path.join(dir, entry.readPath);
  if (!fs.existsSync(mdPath)) return { ok: false, error: `分块文件缺失：${entry.readPath}` };

  // 只取正文部分（去掉首尾的说明性文字）
  const raw = fs.readFileSync(mdPath, 'utf8');
  const bodyMatch = raw.match(/---\n\n([\s\S]*?)\n\n---/);
  const body = bodyMatch ? bodyMatch[1] : raw;

  const rp = path.join(dir, entry.resultPath);
  return {
    ok: true,
    index: entry.index,
    id: entry.id,
    sourceFile: entry.sourceFile,
    resultFile: `${path.basename(dir)}/${entry.resultPath}`,
    alreadyDone: fs.existsSync(rp),
    skippable: !!entry.skippable,
    content: body,
  };
};

/**
 * 写某个分块的抽取结果。
 */
tools.task_write_result = ({ taskId, index, cards, note }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到任务 ${taskId}` };

  const mPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mPath)) return { ok: false, error: '任务目录无效' };
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));

  const entry = findChunk(manifest, index);
  if (!entry) return { ok: false, error: `没有分块 ${index}` };

  // 用 agentmode 的容错逻辑归一化，写之前就告诉 agent 哪些字段有问题
  const normalized = [];
  const rejected = [];
  for (const raw of (cards || []).slice(0, 60)) {
    const card = agentmode.coerceAgentCard(raw);
    if (!card) {
      rejected.push({ item: String(raw && (raw.title || raw.value || '')).slice(0, 80), reason: '缺 subject/predicate/value 或 type 无效' });
      continue;
    }
    normalized.push(card);
  }

  const payload = { cards: normalized.map(stripInternal) };
  const rPath = path.join(dir, entry.resultPath);
  fs.mkdirSync(path.dirname(rPath), { recursive: true });
  fs.writeFileSync(rPath, JSON.stringify(payload, null, 2), 'utf8');

  const st = agentmode.taskStatus(dir);
  return {
    ok: true,
    index: entry.index,
    accepted: normalized.length,
    rejected,
    progress: { done: st.done, total: st.total, percent: st.percent },
    remaining: st.chunks.filter((c) => c.state !== 'ok').map((c) => c.id),
    allDone: st.done === st.total,
    note: note || undefined,
  };
};

function stripInternal(card) {
  const out = {};
  Object.keys(card).forEach((k) => {
    if (!k.startsWith('_')) out[k] = card[k];
  });
  return out;
}

/** 导入结果并跑下游管线。默认不写盘。 */
tools.import_results = ({ taskId, palaceRoot, write, dryRun }) => {
  const dir = resolveTaskDir(taskId);
  if (!dir) return { ok: false, error: `未找到任务 ${taskId}` };

  const taskMeta = loadTaskIndex()[taskId] || {};

  // 浅尝模式：即使传了 write 也不写 —— 试运行的目的是预览，不是落地。
  const isTrialTask = taskMeta.kind === 'trial';
  const allowWrite = write && !isTrialTask;

  const res = agentmode.importResults(dir);
  if (!res.ok) return res;

  const cards = res.cards.map((c, i) => ({ ...c, _localId: c._localId || `A${i + 1}` }));
  const dd = merge.dedupe(cards);
  const conflicts = merge.findInternalConflicts(dd.kept);

  let baselineCards = [];
  if (palaceRoot && fs.existsSync(palaceRoot)) {
    baselineCards = loadPalace(palaceRoot).cards;
  }
  const cmp = merge.compareWithBaseline(dd.kept, baselineCards);

  const report = {
    ok: true,
    mode: isTrialTask ? 'trial' : 'full',
    readonly: isTrialTask,
    progress: res.progress,
    cardCount: dd.kept.length,
    deduped: dd.dropped.length,
    internalConflicts: conflicts.length,
    baselineConflicts: cmp.conflicts.length,
    rejected: res.rejected,
    conflicts: conflicts.map((cf) => ({
      slot: cf.slot,
      members: cf.members.map((m) => ({ title: m.title, value: m.value, source: m.source })),
      suggestion: cf.suggestion,
    })),
    written: false,
  };

  // 试运行报告：抽样参数 + 组织结构 + 归类分布，供快速判断值不值
  if (isTrialTask && taskMeta.plan) {
    const sampled = sampleOfTask(taskMeta, dir);
    const t = sampler.buildReport(
      { ...taskMeta.plan, sampled },
      { cards: dd.kept, deduped: dd.dropped, internalConflicts: conflicts, errors: [] },
    );
    t.summary = sampler.summarize(t);
    report.trialReport = t;
  }

  if (isTrialTask) {
    report.notice = write
      ? '浅尝模式不会写入文件。确认结果满意后，请用 forge_task_start 处理完整内容。'
      : '浅尝模式只预览，不写盘。';
  } else if (allowWrite && palaceRoot) {    const base = loadPalace(palaceRoot);
    const assigned = merge.assignIds(dd.kept, (base.maxSeq || 0) + 1, base.ids);
    let written = 0;
    const failed = [];
    for (const { id, card } of assigned) {
      const dir = path.join(palaceRoot, 'cards', card.type);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const { renderCard, cardFileName } = require(path.join(ENGINE, 'schema'));
        fs.writeFileSync(path.join(dir, cardFileName(id, card.title)), renderCard(card, id), 'utf8');
        written++;
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }
    try {
      const seqPath = path.join(palaceRoot, '.palace', 'seq.txt');
      fs.mkdirSync(path.dirname(seqPath), { recursive: true });
      const cur = parseInt(fs.readFileSync(seqPath, 'utf8').trim() || '0', 10) || 0;
      const next = assigned.length ? parseInt(assigned[assigned.length - 1].id.replace('mem_', ''), 10) : cur;
      if (next > cur) fs.writeFileSync(seqPath, `${next}\n`, 'utf8');
    } catch (_) { /* seq 同步失败不阻断 */ }

    report.written = true;
    report.writtenCount = written;
    report.failed = failed;
    report.idRange = assigned.length
      ? { from: assigned[0].id, to: assigned[assigned.length - 1].id }
      : null;
    report.verifyCommand = `cd "${palaceRoot}" && python bin/palace.py doctor`;
  } else if (dryRun !== false) {
    report.nextStep = write
      ? '确认无误后重新调用并设置 write=true'
      : '确认无误后调用时传 write=true 与 palaceRoot 以写入记忆库';
  }

  return report;
};

/**
 * 从任务包还原抽样样本的元信息（类型/状态分布用）。
 *
 * 试运行报告要回答「这批样本长什么样」—— 类型分布、slot 覆盖、状态。
 * 这些在生成任务包时写进了分块的 _sourceFile / _strategy，
 * 但卡片本身要等 agent 抽取后才存在，所以这里从 manifest 重建。
 */
function sampleOfTask(taskMeta, dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return (manifest.chunks || []).map((c) => ({
      id: c.id,
      type: 'unknown',
      title: c.sourceFile || '',
      status: 'active',
      subject: '',
      predicate: '',
      value: '',
    }));
  } catch (_) {
    return [];
  }
}

/**
 * 浅尝模式：从已有记忆库抽样一小批，走同样的抽取流程，全程只读。
 *
 * 与完整模式的差别只在「输入从哪来」：完整模式读文件，
 * 浅尝模式从记忆库随机/分层/按 slot 抽 N 条。
 * 下游管线（去重、冲突检测、对比）完全一致，所以两种模式的
 * 结果口径可以直接对比。
 */
tools.trial_start = ({ palaceRoot, count, ratio, strategy, statusScope, seed, taskId, chunkBudget }) => {
  if (!palaceRoot) {
    return { ok: false, error: '浅尝模式需要 palaceRoot —— 指定要试运行的记忆库目录' };
  }
  const target = sampler.validateTarget(palaceRoot);
  if (!target.ok) {
    const e = sampler.toError(target);
    return { ok: false, code: e.code, error: `${e.title}：${e.detail || palaceRoot}`, hint: e.hint };
  }

  const plan = sampler.planSample(target.cards, {
    strategy: strategy || 'random',
    count: count === undefined || count === null ? 20 : Number(count),
    ratio: ratio === undefined || ratio === null ? null : Number(ratio),
    statusScope: statusScope || 'active',
    seed: seed === undefined || seed === null ? null : Number(seed),
  });
  if (!plan.ok) {
    const e = sampler.toError(plan);
    return { ok: false, code: e.code, error: `${e.title}：${e.detail || ''}`, hint: e.hint };
  }

  const records = sampler.sampleToRecords(plan.sampled);
  const chunks = parser.chunkRecords(records, { budget: Number(chunkBudget) || 6000 });

  const id = taskId || `trial-${Date.now()}`;
  const out = path.join(taskDirOf(), id);
  const pkg = agentmode.writeTaskPackage(out, {
    chunks,
    meta: {
      sourceDesc: `记忆库样本（${plan.strategy} 抽取 ${plan.target} / ${plan.poolSize} 条）`,
      style: 'auto',
      // 浅尝的样本本身就来自这个库，不必再提示已有 slot
      existingSlots: [],
    },
  });
  // 记下抽样计划，import 时用它产出试运行报告
  registerTask(id, 'trial', pkg.root, {
    chunkCount: pkg.manifest.chunkCount,
    plan: {
      strategy: plan.strategy, statusScope: plan.statusScope, seed: plan.seed,
      ratio: plan.ratio, target: plan.target, poolSize: plan.poolSize,
      totalSize: plan.totalSize, warnings: plan.warnings,
    },
  });

  return {
    ok: true,
    taskId: id,
    taskDir: pkg.root,
    chunkCount: pkg.manifest.chunkCount,
    readonly: true,
    sampling: {
      strategy: plan.strategy,
      strategyLabel: sampler.STRATEGIES[plan.strategy].label,
      statusScope: plan.statusScope,
      sampled: plan.target,
      poolSize: plan.poolSize,
      totalSize: plan.totalSize,
      seed: plan.seed,
      coverageRatio: Number((plan.target / plan.poolSize).toFixed(4)),
      warnings: plan.warnings,
    },
    samplePreview: plan.sampled.slice(0, 10).map((c) => ({
      id: c.id, type: c.type, title: c.title,
      slot: `${c.subject}::${c.predicate}`, value: c.value, status: c.status,
    })),
    instructionsFile: pkg.instructionsPath,
    nextSteps: [
      `读取 ${pkg.instructionsPath} 了解抽取规范`,
      '调用 forge_task_read_chunk 逐块处理，结果用 forge_task_write_result 写回',
      '调用 forge_import_results（不要传 write）查看试运行报告 —— 它不会写入任何文件',
    ],
    note: '浅尝模式全程只读。确认结果满意后再用完整模式处理全部记忆。',
  };
};

/** 体检记忆库 */
tools.palace_doctor = ({ palaceRoot }) => {
  if (!palaceRoot || !fs.existsSync(palaceRoot)) {
    return { ok: false, error: `记忆库路径不存在：${palaceRoot || '(未提供)'}` };
  }
  const loaded = loadPalace(palaceRoot);
  const conflicts = [];
  const slots = {};
  loaded.cards.forEach((c) => {
    if (c.status !== 'active') return;
    const k = `${c.subject}::${c.predicate}`;
    slots[k] = (slots[k] || 0) + 1;
  });
  Object.entries(slots).forEach(([slot, n]) => {
    if (n > 1) conflicts.push({ slot, count: n });
  });

  const byType = {};
  const byStatus = {};
  loaded.cards.forEach((c) => {
    byType[c.type] = (byType[c.type] || 0) + 1;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  });

  return {
    ok: true,
    palaceRoot,
    cardCount: loaded.cards.length,
    activeCount: loaded.cards.filter((c) => c.status === 'active').length,
    maxId: loaded.maxSeq,
    byType,
    byStatus,
    conflictSlots: conflicts,
    problems: loaded.problems,
  };
};

/** 检索记忆库 */
tools.palace_search = ({ query, palaceRoot, limit }) => {
  if (!palaceRoot || !fs.existsSync(palaceRoot)) {
    return { ok: false, error: `记忆库路径不存在：${palaceRoot || '(未提供)'}` };
  }
  const cards = loadPalace(palaceRoot).cards.filter((c) => c.status === 'active');
  const q = String(query || '').toLowerCase();
  const terms = q.split(/[\s,.;:!?，。；：、]+/).filter(Boolean);

  const scored = cards.map((c) => {
    const hay = `${c.title} ${c.value} ${c.subject} ${c.predicate} ${(c.tags || []).join(' ')} ${(c.aliases || []).join(' ')} ${c.body}`.toLowerCase();
    let score = 0;
    terms.forEach((t) => { if (hay.includes(t)) score += 1; });
    if (hay.includes(q)) score += 2;
    score += c.importance * 0.5;
    return { c, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(limit) || 10);

  return {
    ok: true,
    query,
    total: cards.length,
    results: scored.map(({ c, score }) => ({
      id: c.id, title: c.title, slot: `${c.subject}::${c.predicate}`,
      value: c.value, type: c.type, score: Number(score.toFixed(2)),
    })),
  };
};

/** 列出记忆类型与字段要求 —— agent 抽取时需要知道这些 */
tools.list_types = () => ({
  ok: true,
  types: TYPE_ORDER.map((k) => ({
    key: k, label: TYPES[k].label, description: TYPES[k].desc,
    ttlDays: TYPES[k].ttl,
  })),
  fieldRules: {
    subject: '必填。关于谁/什么，如 user / project:名称 / env:名称。不能含空格。',
    predicate: '必填。哪个侧面，英文 snake_case，不能含空格。同一 subject+predicate 只能有一条 active 记忆。',
    value: '必填。主张本身，一行讲完。',
    title: '必填。一句话概括。',
    body: '可选。背景、原因、边界条件。',
    aliases: '可选但推荐。中文触发词数组，让中文查询能命中这张卡。',
  },
  linkRelations: LINK_RELATIONS,
  outputFormat: '{"cards": [...]}',
});

// --- MCP 协议实现 -------------------------------------------------------
//
// 只实现 stdio 传输 —— hermes 的本地 MCP 服务器走的就是 stdio，
// 无需 HTTP、无需端口、无需鉴权。协议是 JSON-RPC 2.0 over stdin/stdout。

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'memory-forge', version: '1.0.0' };

/** MCP 工具描述表：告诉客户端每个工具做什么、需要什么参数 */
const TOOL_DEFS = [
  {
    name: 'forge_probe_start',
    description:
      '第 1 步（格式不统一时）：勘察记忆文件的结构，生成探查任务。' +
      '返回每个文件的结构统计（jsonLineRate、nestedContentLines、roleMarkers 等），' +
      '据此判断每个文件该怎么切。Agent 记忆格式千差万别——对话导出、Codex 会话 JSONL、' +
      'YAML 配置、CSV 记忆表等，规则解析器对它们会丢内容，所以需要先勘察。' +
      '若文件都是常见格式（Markdown/日志），可跳过这步直接用 forge_task_start。',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '文件路径数组，也可传目录' },
        taskId: { type: 'string', description: '可选，自定义任务 ID' },
      },
      required: ['files'],
    },
  },
  {
    name: 'forge_probe_read_sample',
    description:
      '读取某个待探查文件的结构采样：头部/尾部片段 + 客观统计。' +
      '不传 file 则返回全部文件的采样。统计字段是机械计算结果，不含判断，作为你判断格式的依据。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        file: { type: 'string', description: '文件名或文件 ID。不传则列出全部' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'forge_probe_write_recipe',
    description:
      '为某个文件写一份切分配方（声明式，非代码）。' +
      'strategy 从 forge_probe_start 返回的 strategies 里选。' +
      'fields 是 {"显示名": "JSON路径"}，路径支持 a.b 与 a[].text。' +
      '关键：若结构统计显示 nestedContentLines > 0（内容藏在数组里，如 Codex 会话），' +
      'fields 里必须用 a[].text 形式，否则内容会丢失。拿不准就用 strategy="whole"。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        file: { type: 'string' },
        strategy: {
          type: 'string',
          enum: Object.keys(probe.STRATEGIES),
          description: '切分策略',
        },
        fields: {
          type: 'object',
          description: '字段映射 {"角色":"role","内容":"content[].text"}',
          additionalProperties: { type: 'string' },
        },
        includeMeta: { type: 'array', items: { type: 'string' }, description: '额外带上的元字段' },
        separator: { type: 'string', description: 'record_separator/conversation 策略的分隔符' },
        note: { type: 'string', description: '判断依据，会写入报告便于回溯' },
      },
      required: ['taskId', 'file', 'strategy'],
    },
  },
  {
    name: 'forge_probe_status',
    description: '查看探查进度：哪些文件已写配方、哪些还没。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'forge_split_by_recipe',
    description:
      '按探查配方切分文件，生成抽取任务。未写配方的文件会自动用规则解析器兜底。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '探查任务 ID' },
        taskIdOut: { type: 'string', description: '可选，抽取任务 ID' },
        chunkBudget: { type: 'number', description: '每块字符预算，默认 6000' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'forge_task_start',
    description:
      '跳过探查，直接生成抽取任务。适用于文件格式已知且规整的情况（常见 Markdown、日志）。' +
      '格式不统一时建议先用 forge_probe_start。',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        taskId: { type: 'string' },
        chunkBudget: { type: 'number' },
        palaceRoot: { type: 'string', description: '可选，已有记忆库目录，用于提示已有 slot 减少重复抽取' },
      },
      required: ['files'],
    },
  },
  {
    name: 'forge_task_read_chunk',
    description:
      '读取一个分块的内容。不传 index 则返回分块清单与进度。' +
      'alreadyDone=true 表示这块已提交结果，可跳过。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        index: { type: 'number', description: '分块序号；不传则列清单' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'forge_task_write_result',
    description:
      '提交某个分块的抽取结果。cards 数组每项是一个记忆卡。' +
      '字段要求：type（见 forge_list_types）、subject、predicate、value、title 必填，' +
      'aliases 推荐填中文触发词。空数组是合法结果，表示该块无值得记住的内容。' +
      '返回里会告诉你哪些卡片字段有问题（rejected），以及整体进度。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        index: { type: 'number' },
        cards: { type: 'array', items: { type: 'object' }, description: '记忆卡数组' },
      },
      required: ['taskId', 'index', 'cards'],
    },
  },
  {
    name: 'forge_trial_start',
    description:
      '浅尝模式：从已有记忆库抽样一小批（默认 20 条），跑与完整模式一致的抽取流程。' +
      '用于在处理整个记忆库之前先验证效果 —— 抽样、切分、抽取、去重、冲突检测口径完全一致，' +
      '只是输入量小。★ 全程只读：后续的 forge_import_results 不会写入任何文件。' +
      'strategy 选 slot 时每个 slot 至多取 1 条，最容易暴露潜在的同 slot 矛盾。' +
      'seed 填固定值可复现同一批样本，便于对比不同模型的效果。' +
      '返回的 sampling 字段说明这次抽了多少、覆盖多少、seed 是多少。',
    inputSchema: {
      type: 'object',
      properties: {
        palaceRoot: { type: 'string', description: '要试运行的记忆库目录（memory-palace 根目录）' },
        count: { type: 'number', description: '抽样条数，默认 20。与 ratio 二选一' },
        ratio: { type: 'number', description: '抽样比例 0~1，与 count 二选一' },
        strategy: {
          type: 'string',
          enum: ['random', 'stratified', 'slot'],
          description: 'random 等概率；stratified 按类型分层；slot 每 slot 至多 1 条（易暴露冲突）',
        },
        statusScope: {
          type: 'string',
          enum: ['active', 'all'],
          description: 'active 只抽当前生效的（默认）；all 含已过期/被取代的',
        },
        seed: { type: 'number', description: '随机种子，填固定值可复现同一批样本' },
        taskId: { type: 'string' },
        chunkBudget: { type: 'number' },
      },
      required: ['palaceRoot'],
    },
  },
  {
    name: 'forge_import_results',
    description:
      '导入全部结果并跑下游管线（去重 → 冲突检测 → 与已有记忆对比），' +
      '传 write=true 与 palaceRoot 时把卡片写入记忆库。' +
      '★ 请始终用这个工具写盘，不要自己往 cards/ 目录手写 .md 文件 —— ' +
      '手写会漏掉字段、可能写错 frontmatter 分隔符（\\\\--- 会让整张卡读不出来），' +
      '而且不会被计入 ID 序列。工具会用 renderCard 渲染，保证格式与 schema 一致。' +
      '浅尝任务（forge_trial_start 创建）即使传 write 也不会写 —— 会返回 notice 说明。' +
      '返回会列出所有冲突 slot —— 工具不会替你判断哪条为真，需要你或用户裁决。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        palaceRoot: { type: 'string', description: '记忆库目录（memory-palace 根目录）' },
        write: { type: 'boolean', description: '是否写入记忆库，默认 false' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'forge_palace_doctor',
    description: '体检记忆库：卡片数、类型分布、状态分布、有争议的 slot、结构问题。',
    inputSchema: {
      type: 'object',
      properties: { palaceRoot: { type: 'string' } },
      required: ['palaceRoot'],
    },
  },
  {
    name: 'forge_palace_search',
    description: '检索记忆库中已生效的记忆。用于抽取前先了解「已经知道什么」，避免重复。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        palaceRoot: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query', 'palaceRoot'],
    },
  },
  {
    name: 'forge_list_types',
    description: '列出 8 种记忆类型及其含义、TTL，以及 subject/predicate/value 等字段的填写规则。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// 实现用短名（便于内部引用），协议层用 forge_ 前缀的完整名。
// 这里做一次映射，并断言两者一致 —— 前缀不一致会导致 agent
// 看到工具列表却调不动任何工具，是最难排查的一类问题。
const IMPL = {};
Object.keys(tools).forEach((short) => { IMPL[`forge_${short}`] = tools[short]; });

const MISSING = TOOL_DEFS.map((t) => t.name).filter((n) => typeof IMPL[n] !== 'function');
if (MISSING.length) {
  // 启动即失败优于运行期才暴露 —— agent 会把整个 server 当成不可用
  process.stderr.write(`[forge-mcp] 致命错误：以下工具声明了但未实现：${MISSING.join(', ')}\n`);
  process.exit(1);
}

const EXTRA = Object.keys(IMPL).filter(
  (n) => !TOOL_DEFS.some((t) => t.name === n)
);
if (EXTRA.length) {
  process.stderr.write(`[forge-mcp] 警告：以下工具已实现但未在 tools/list 声明，agent 看不到：${EXTRA.join(', ')}\n`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      // 客户端通知，无需响应
      return;

    case 'tools/list':
      reply(id, { tools: TOOL_DEFS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const fn = IMPL[name];
      if (!fn) {
        return replyError(id, -32601, `未知工具 ${name}`, {
          available: TOOL_DEFS.map((t) => t.name),
        });
      }
      let result;
      try {
        result = fn(args);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      reply(id, {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
        isError: result && result.ok === false,
      });
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    default:
      if (id !== undefined && id !== null) {
        replyError(id, -32601, `不支持的方法 ${method}`);
      }
  }
}

function main() {
  ensureWorkspace();
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    buffer += data;
    let idx;
    // 可能粘了多条 JSON-RPC 消息
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch (err) {
        // 解析失败只记日志，不污染 stdout（stdout 是协议通道）
        process.stderr.write(`[forge-mcp] 解析失败: ${err.message}\n`);
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('[forge-mcp] memory-forge MCP server 已启动\n');
}

if (require.main === module) {
  main();
}

module.exports = { tools, TOOL_DEFS, handle, workspaceRoot, resolveTaskDir };
