'use strict';
/**
 * 探查（Probe）—— 让 agent 先勘察未知格式，再由引擎按「配方」切分。
 *
 * ## 为什么需要
 *
 * Agent 记忆的格式远比「Markdown/JSON/日志/纯文本」四种能概括：
 *
 *   - ChatGPT / Claude 的对话导出（role + content 数组）
 *   - Codex / Claude Code 的会话 JSONL（content 里还嵌套数组）
 *   - Codex 的 rollout 文件（嵌套 event 结构）
 *   - YAML / TOML 配置
 *   - CSV 记忆表（表头 + 数据行）
 *   - 私有的自研格式
 *
 * 纯规则解析器能处理已知的，对未知的就只能瞎猜。这里有个具体的坑：
 * Codex 会话行长这样
 *
 *     {"type":"message","role":"user","content":[{"type":"input_text","text":"帮我重构"}]}
 *
 * 规则解析器只取字符串字段，于是「type=message, role=user」被留下，
 * 而**真正的内容 `帮我重构` 被完全丢弃** —— 因为它藏在数组里。
 *
 * 这类结构无法用正则穷举，得让能理解语义的一方来看。
 *
 * ## 职责边界
 *
 *   agent 判断「这是什么结构、该怎么切」→ 产出配方（recipe）
 *   引擎执行「按配方切分」           → 保证确定性与可复现
 *
 * agent 给的是**声明式配方**，不是代码。这样切分过程仍然可审计、
 * 可复现，agent 也不会因为写错代码而破坏流程。
 *
 * ## 配方示例
 *
 *   { "strategy": "jsonl",
 *     "fields": { "role": "role", "content": "content[].text" },
 *     "includeMeta": ["type"] }
 *
 * 引擎会按这个声明把每行渲染成可读文本。agent 不需要关心实现细节。
 */

const fs = require('fs');
const path = require('path');

const { detectFormat } = require('./parser');

// 配方支持的切分策略
const STRATEGIES = {
  // 每一行/每条记录独立成块
  lines: '逐行（每行一条记录）',
  jsonl: 'JSON Lines（每行一个 JSON 对象）',
  json_array: 'JSON 数组（每个元素一条记录）',
  // 结构化文本
  conversation: '对话记录（按 role/说话人分组）',
  record_separator: '按自定义分隔符切分',
  // 文本类
  markdown: 'Markdown（按标题层级）',
  yaml: 'YAML / TOML 配置（按顶层键）',
  csv: 'CSV / TSV 表格（按数据行）',
  log: '日志（按时间戳）',
  blank_line: '空行分段',
  // 兜底
  whole: '整个文件作为一条记录',
};

// --- 文件采样 -----------------------------------------------------------

/**
 * 采样一个文件用于探查。
 *
 * 不给 agent 全文 —— 大文件会撑爆上下文，而且 agent 判断格式靠的是
 * **结构特征**而非具体内容。所以给：头部、尾部、结构统计。
 * 这三点足以让 agent 判断出「这是对话导出」「这是嵌套 JSONL」这类结论。
 */
function sampleFile(filePath, { headChars = 3000, tailChars = 1200 } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { error: err.message };
  }

  const stats = analyzeStructure(text);
  const head = text.slice(0, headChars);
  const tail = text.length > headChars + tailChars
    ? text.slice(-tailChars)
    : '';

  return {
    path: filePath,
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
    chars: text.length,
    lines: text.split(/\r?\n/).length,
    ext: path.extname(filePath).toLowerCase(),
    ruleGuess: detectFormat(filePath, text),
    head,
    tail,
    truncated: text.length > headChars + tailChars,
    ...stats,
  };
}

/**
 * 结构统计 —— 给 agent 判断格式提供客观依据。
 * 全部是机械计算，不含判断。
 */
function analyzeStructure(text) {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim());

  // 逐行尝试 JSON 解析，算成功率
  let jsonLines = 0;
  let nestedContent = 0;
  for (const l of nonEmpty.slice(0, 200)) {
    const t = l.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try {
      const o = JSON.parse(t);
      jsonLines++;
      // 探测嵌套数组内容 —— Codex/Claude 会话的特征
      if (o && typeof o === 'object') {
        for (const v of Object.values(o)) {
          if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && typeof x.text === 'string')) {
            nestedContent++;
            break;
          }
        }
      }
    } catch (_) { /* 不是 JSON 行 */ }
  }

  // 对话角色标记
  const roleMarkers = {
    role_user: (text.match(/"role"\s*:\s*"user"/g) || []).length,
    role_assistant: (text.match(/"role"\s*:\s*"assistant"/g) || []).length,
    role_system: (text.match(/"role"\s*:\s*"system"/g) || []).length,
    chatgpt_mapping: (text.match(/"mapping"/g) || []).length,
  };

  // CSV 特征
  const firstLine = nonEmpty[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const consistentCommas = nonEmpty.slice(0, 10)
    .every((l) => (l.match(/,/g) || []).length === commaCount);

  // YAML 特征
  const yamlTopKeys = nonEmpty
    .filter((l) => /^[a-zA-Z_][\w-]*\s*:/.test(l))
    .length;

  // 时间戳
  const timestampLines = nonEmpty.filter((l) =>
    /^\s*[\[\(]?\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}/.test(l) ||
    /^\s*\d{2}:\d{2}:\d{2}/.test(l) ||
    /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(l)
  ).length;

  // Markdown 标题
  const headings = nonEmpty.filter((l) => /^#{1,6}\s+/.test(l)).length;

  // 缩进层级（YAML/代码块特征）
  const indented = nonEmpty.filter((l) => /^\s{2,}/.test(l)).length;

  // 分隔符候选
  const separators = ['\n---\n', '\n===\n', '\n\n\n', '\n--\n']
    .map((s) => ({ sep: JSON.stringify(s), count: text.split(s).length - 1 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  let jsonValid = false;
  let jsonRoot = null;
  try {
    jsonValid = !!JSON.parse(text);
    if (jsonValid) {
      const parsed = JSON.parse(text);
      jsonRoot = Array.isArray(parsed) ? `array(${parsed.length})`
        : typeof parsed === 'object' ? Object.keys(parsed).slice(0, 8).join(',') : typeof parsed;
    }
  } catch (_) { /* 不是完整 JSON */ }

  return {
    nonEmptyLines: nonEmpty.length,
    jsonLineRate: nonEmpty.length ? +(jsonLines / Math.min(nonEmpty.length, 200)).toFixed(2) : 0,
    nestedContentLines: nestedContent,
    roleMarkers,
    csvLike: commaCount >= 2 && consistentCommas,
    csvColumns: commaCount + 1,
    tsvLike: tabCount >= 2,
    yamlLikeKeys: yamlTopKeys,
    indentedRatio: nonEmpty.length ? +(indented / nonEmpty.length).toFixed(2) : 0,
    timestampRatio: nonEmpty.length ? +(timestampLines / Math.min(nonEmpty.length, 200)).toFixed(2) : 0,
    headingCount: headings,
    separatorCandidates: separators.slice(0, 3),
    jsonValid,
    jsonRoot,
  };
}

/**
 * 生成探查任务包。
 *
 * 与抽取任务包同样的形态：manifest + 样本文件 + 规范。
 * agent 读样本，写配方。
 */
function writeProbeTask(outDir, { files, meta = {} }) {
  const root = path.resolve(outDir);
  const samplesDir = path.join(root, 'samples');
  const recipesDir = path.join(root, 'recipes');
  fs.mkdirSync(samplesDir, { recursive: true });
  fs.mkdirSync(recipesDir, { recursive: true });

  const entries = [];
  files.forEach((f, i) => {
    const id = String(i + 1).padStart(3, '0');
    const baseName = `${id}-${slugish(path.basename(f.path))}`;
    const sample = sampleFile(f.path);
    if (sample.error) return;

    fs.writeFileSync(path.join(samplesDir, `${baseName}.json`),
      JSON.stringify(sample, null, 2), 'utf8');

    entries.push({
      index: i,
      id,
      baseName,
      path: f.path,
      name: sample.name,
      size: sample.size,
      samplePath: `samples/${baseName}.json`,
      recipePath: `recipes/${baseName}.recipe.json`,
      // 预判：规则解析器怎么切，供 agent 参考或推翻
      ruleGuess: sample.ruleGuess,
    });
  });

  const instructions = buildProbeInstructions(entries);
  fs.writeFileSync(path.join(root, 'INSTRUCTIONS.md'), instructions, 'utf8');

  const manifest = {
    specVersion: 1,
    kind: 'probe',
    taskId: `probe_${Date.now()}`,
    createdAt: new Date().toISOString(),
    fileCount: entries.length,
    files: entries,
    recipeFormat: 'recipes/<baseName>.recipe.json',
    strategyReference: STRATEGIES,
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return { root, manifest, instructionsPath: path.join(root, 'INSTRUCTIONS.md') };
}

function slugish(text) {
  return String(text || 'file')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'file';
}

// --- 探查指令 -----------------------------------------------------------

function buildProbeInstructions(entries) {
  const strategyList = Object.entries(STRATEGIES)
    .map(([k, v]) => `- \`${k}\` — ${v}`).join('\n');

  const fileList = entries.map((e) =>
    `- **${e.id}** \`${e.name}\` — 读 \`${e.samplePath}\`，写 \`${e.recipePath}\`（${e.size} 字节，规则猜测为 ${e.ruleGuess}）`
  ).join('\n');

  return `# 记忆格式探查任务

Agent 记忆的格式千差万别。在抽取之前，需要先搞清楚每个文件**是什么结构、该怎么切**。

你不需要配置任何模型 —— 你就是执行者。

## 为什么需要这一步

规则解析器只认识 Markdown / JSON / JSONL / 日志 / 纯文本这几种，遇到未知结构只能瞎猜，
而猜错的后果很严重。举例：

\`\`\`jsonl
{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我重构记忆模块"}]}
\`\`\`

上面这行 JSONL（Codex / Claude Code 的会话格式），规则解析器只会取到字符串字段
\`type=message\` 和 \`role=user\`，而**真正有意义的内容「帮我重构记忆模块」藏在数组里，会被完全丢弃**。

这种结构没法用正则穷举，所以需要你看一眼。

## 你要产出什么

每个文件一份**切分配方**（recipe）—— 一份声明式 JSON，告诉引擎「这个文件该怎么切」。
**不是代码**，是声明。这样切分过程可审计、可复现。

### 配方格式

\`\`\`json
{
  "file": "原文件名",
  "strategy": "jsonl",
  "fields": {
    "role": "role",
    "content": "content[].text"
  },
  "includeMeta": ["type", "timestamp"],
  "separator": null,
  "note": "Codex 会话格式，真实内容在 content[].text"
}
\`\`\`

### 字段说明

- \`strategy\`（必填）：切分策略，见下方列表
- \`fields\`：字段映射，\`{"显示名": "JSON路径"}\`。
  JSON 路径支持 \`a.b\` 与 \`a[].text\`（数组内所有元素的 text 字段）
- \`includeMeta\`：额外原样带上的元字段（如 type、timestamp）
- \`separator\`：\`record_separator\` 策略的分隔符字符串；\`conversation\` 策略的角色前缀
- \`note\`：你的判断依据，会记入审计，便于日后回溯

### 可用策略

${strategyList}

## 判断要点

1. **先看结构统计**。样本 JSON 里的 \`jsonLineRate\`（多少行是合法 JSON）、
   \`nestedContentLines\`（含嵌套内容数组的行数）、\`roleMarkers\`（对话角色出现次数）、
   \`csvLike\` / \`yamlLikeKeys\` 都是客观线索，先看这些。

2. **规则猜测只是参考**。它可能对（常见格式）也可能错（私有格式）。
   觉得不对就推翻它，这正是这一步的意义。

3. **拿不准就用 \`whole\`**。整个文件作为一条记录交给抽取阶段。
   宁可不切，也不要切错 —— 切错会破坏语义完整性，而这是无法挽回的。

4. **对话记录要用 \`conversation\`**，并把角色标记写进 \`separator\`：
   \`"separator": "User:|Assistant:|用户:|助手:"\`。
   角色信息很重要，抽取时要能分辨哪句是用户的真实意图、哪句是模型的话。

5. **宁少勿多**。只声明真正需要的字段，把噪音字段（id、uuid、token 数等）排除掉。

## 写回方式

把配方 JSON 写进 \`recipes/\` 目录，文件名与样本对应（把 \`.json\` 换成 \`.recipe.json\`）。

示例 —— 对话导出：

\`\`\`json
{
  "file": "chatgpt-export.json",
  "strategy": "json_array",
  "fields": { "角色": "role", "内容": "content" },
  "includeMeta": ["timestamp"],
  "note": "ChatGPT 对话导出，数组每项是一条消息"
}
\`\`\`

示例 —— Codex 会话 JSONL：

\`\`\`json
{
  "file": "codex-session.jsonl",
  "strategy": "jsonl",
  "fields": { "角色": "role", "内容": "content[].text" },
  "includeMeta": ["type"],
  "note": "Codex 会话格式，内容在 content[].text 数组里"
}
\`\`\`

写完之后回复一句「已勘察 N 个文件」即可，不要复述配方内容。

## 待探查文件

${fileList}
`;
}

// --- 配方校验与加载 ------------------------------------------------------

const VALID_FIELD_PATH = /^[a-zA-Z_$][\w$]*(\[\])?(\.[a-zA-Z_$][\w$]*(\[\])?)*$/;

function validateRecipe(recipe) {
  const problems = [];
  if (!recipe || typeof recipe !== 'object') {
    return ['配方必须是 JSON 对象'];
  }
  if (!recipe.strategy) {
    problems.push('缺少 strategy');
  } else if (!Object.keys(STRATEGIES).includes(recipe.strategy)) {
    problems.push(`未知策略 "${recipe.strategy}"，可用：${Object.keys(STRATEGIES).join(' / ')}`);
  }
  if (recipe.fields !== undefined) {
    if (typeof recipe.fields !== 'object' || recipe.fields === null) {
      problems.push('fields 必须是对象');
    } else {
      Object.entries(recipe.fields).forEach(([label, p]) => {
        if (typeof p !== 'string' || !VALID_FIELD_PATH.test(p)) {
          problems.push(`字段映射 "${label}" 的路径 "${p}" 不合法（支持 a.b 与 a[].text 形式）`);
        }
      });
    }
  }
  if (recipe.includeMeta !== undefined && !Array.isArray(recipe.includeMeta)) {
    problems.push('includeMeta 必须是数组');
  }
  if (recipe.separator !== undefined && recipe.separator !== null && typeof recipe.separator !== 'string') {
    problems.push('separator 必须是字符串或 null');
  }
  return problems;
}

/**
 * 按 JSON 路径取值，支持 a.b 与 a[].text。
 * 找不到返回 null（不报错 —— 字段可选是常态）。
 *
 * `[]` 的语义是「数组内每个元素都取该字段，结果合并」：
 *   { content: [{text:'a'},{text:'b'}] }  配 'content[].text'  → 'a\nb'
 *
 * 注意：**只有路径里显式写了 `[]` 才展开数组**。
 * 不带 `[]` 的普通路径（'content'、'a.b.c'、'tags'）保持常规取值行为，
 * 只是最终结果若为数组会拼接成字符串 —— 这样字段类型不可预知时也不会丢数据。
 */
function pickPath(obj, pathStr) {
  if (obj === null || obj === undefined) return null;

  const parts = pathStr.split('.');
  let cur = obj;

  for (const raw of parts) {
    if (cur === null || cur === undefined) return null;
    const isArrayStep = raw.endsWith('[]');
    const key = isArrayStep ? raw.slice(0, -2) : raw;

    if (isArrayStep) {
      // 显式展开：取出数组元素，接着由下一段继续处理
      const arr = cur[key];
      if (!Array.isArray(arr)) {
        // 该字段本身不是数组 —— 当普通键处理，尽力而为
        cur = arr;
        continue;
      }
      cur = arr
        .filter((x) => x !== null && x !== undefined)
        .map((x) => (typeof x === 'object' ? x : { __scalar: x }));
      continue;
    }

    // 普通键：数组则逐元素取值（收集），否则直取
    if (Array.isArray(cur)) {
      const mapped = cur
        .map((x) => (x && typeof x === 'object' ? x[key] : undefined))
        .filter((x) => x !== undefined);
      // 全都没这个键 → 保留数组本身，交给归一化阶段处理
      cur = mapped.length ? mapped : cur;
    } else {
      cur = cur[key];
    }
  }

  if (cur === null || cur === undefined) return null;
  return normalizeValue(cur);
}

/** 把取到的值归一化成字符串；数组元素优先取 text 字段 */
function normalizeValue(val) {
  if (val === null || val === undefined) return null;

  if (Array.isArray(val)) {
    const vals = val.map((x) => {
      if (x === null || x === undefined) return null;
      if (typeof x === 'object') {
        if (typeof x.text === 'string') return x.text;
        if (typeof x.content === 'string') return x.content;
        if ('__scalar' in x) return String(x.__scalar);
        return JSON.stringify(x);
      }
      return String(x);
    }).filter((x) => x !== null && x !== '');
    return vals.length ? vals.join('\n') : null;
  }

  if (typeof val === 'object') return JSON.stringify(val);
  if (val === '') return null;
  return String(val);
}

/**
 * 加载一个任务的全部配方。
 */
function loadRecipes(taskDir) {
  const root = path.resolve(taskDir);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `未找到 manifest.json：${root}` };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const recipes = [];
  const missing = [];
  const invalid = [];

  for (const f of manifest.files || []) {
    const rp = path.join(root, f.recipePath);
    if (!fs.existsSync(rp)) { missing.push(f); continue; }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(rp, 'utf8'));
    } catch (err) {
      invalid.push({ file: f, error: `JSON 解析失败：${err.message}` });
      continue;
    }
    const problems = validateRecipe(parsed);
    if (problems.length) {
      invalid.push({ file: f, error: problems.join('；') });
      continue;
    }
    recipes.push({ ...f, recipe: parsed });
  }

  return {
    ok: true,
    manifest,
    recipes,
    missing,
    invalid,
    progress: {
      total: (manifest.files || []).length,
      done: recipes.length,
      missing: missing.length,
      invalid: invalid.length,
    },
  };
}

/** 探查任务进度（不校验配方，只看文件在不在） */
function probeStatus(taskDir) {
  const root = path.resolve(taskDir);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `未找到 manifest.json：${root}` };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = (manifest.files || []).map((f) => {
    const rp = path.join(root, f.recipePath);
    let state = 'missing';
    let strategy = '';
    let error = '';
    if (fs.existsSync(rp)) {
      try {
        const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
        const problems = validateRecipe(r);
        if (problems.length) { state = 'invalid'; error = problems.join('；'); }
        else { state = 'ok'; strategy = r.strategy; }
      } catch (err) {
        state = 'invalid';
        error = `JSON 解析失败：${err.message}`;
      }
    }
    return { id: f.id, name: f.name, strategy, state, error };
  });
  const done = files.filter((f) => f.state === 'ok').length;
  return {
    ok: true,
    taskId: manifest.taskId,
    total: files.length,
    done,
    percent: files.length ? Math.round((done / files.length) * 100) : 0,
    files,
  };
}

module.exports = {
  STRATEGIES,
  sampleFile,
  analyzeStructure,
  writeProbeTask,
  buildProbeInstructions,
  validateRecipe,
  pickPath,
  loadRecipes,
  probeStatus,
};
