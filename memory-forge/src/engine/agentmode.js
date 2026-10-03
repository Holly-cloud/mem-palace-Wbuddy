'use strict';
/**
 * Agent 驱动模式 —— 用 agent 自带的模型完成抽取，解决模型配置门槛。
 *
 * ## 为什么这样设计
 *
 * 原方案要求用户自己准备模型端点与 API Key（Ollama / OpenAI 兼容 / Claude），
 * 这是整个工具里使用门槛最高的一环：装模型、配 endpoint、填 Key、调并发，
 * 任何一步不通就卡住。而用户已经在跟一个 agent 打交道了 —— 那个 agent
 * 本身就带着模型能力，何必再折腾一遍。
 *
 * 所以把职责切开：
 *
 *   agent 负责「理解」—— 从文本里判断什么是值得长期记住的信息
 *   引擎负责「机械」—— 解析、切分、schema 校验、去重、冲突检测、导出
 *
 * 这条边界很重要：判断交给 agent，但凡是能确定性完成的部分一律不外包，
 * 否则结果不可复现，也无法审计。
 *
 * ## 工作流
 *
 *   1. 引擎导出任务包（含抽取规范 + 待分析分块）
 *   2. agent 读任务包，逐块产出 JSON 结果
 *   3. 引擎导入结果，容错解析 + 归一化，走**完全相同**的下游管线
 *
 * 下游（去重 → 冲突检测 → 审查 → 导出）与直连模型模式一字不差，
 * 因此两种模式的产出可直接对比。
 *
 * ## 为什么结果要分块存放
 *
 * agent 有上下文限制，几千条记忆不可能一次读完。分块让 agent 能：
 *   - 一次处理一块，串行推进
 *   - 中断后从断点继续（看 manifest 里哪些块已完成）
 *   - 只重跑失败的那几块，不必全量重来
 *
 * 这也是 agent 相比单次 API 调用更合适的场景 —— 它能自己决定分几次。
 */

const fs = require('fs');
const path = require('path');

const { SYSTEM_PROMPT } = require('./extract');
const { normalizeCard, validateCard, TYPES } = require('./schema');
const { parseLooseJSON } = require('./llm');

const SPEC_VERSION = 1;
const MANIFEST = 'manifest.json';
const INSTRUCTIONS = 'INSTRUCTIONS.md';
const CHUNKS_DIR = 'chunks';
const RESULTS_DIR = 'results';
const ALL_MD = 'ALL.md';

// --- 任务包写出 ---------------------------------------------------------

/**
 * 生成 agent 抽取指令。
 *
 * 这份文本是 agent 产出质量的唯一决定因素，因此写得足够具体：
 * 给出正例与反例、明确边界、规定输出结构、说明常见错误。
 * 它由 SYSTEM_PROMPT 生成，保证与直连模式共用同一套规则，不会漂移。
 */
function buildInstructions(meta = {}) {
  const { sourceDesc = '待分析文本', existingSlots = [], style = 'auto' } = meta;

  const styleHint = {
    preference: '本次重点关注：用户偏好、身份信息、沟通习惯。',
    technical: '本次重点关注：环境配置、技术栈、操作规程。',
    lesson: '本次重点关注：踩过的坑、经验教训、决策理由。',
    auto: '按内容自行判断类型，不要强行归入某一类。',
  }[style] || '';

  const slotSection = existingSlots.length
    ? `\n## 已有记忆的 slot（除非原文明确改变了某条，否则不要重复抽取）\n\n${existingSlots
        .map((s) => `- ${s}`)
        .join('\n')}\n`
    : '';

  return `# 记忆抽取任务

你的任务：把下面的 ${sourceDesc} 转换为结构化记忆卡片。

你不需要配置任何模型或 API —— 你就是执行者。用你自己的判断力完成抽取。

## 核心原则

**只抽取值得长期记住的信息。** 判断标准：这条信息在未来某次对话中还会有用吗？
只服务于当前任务的内容不要抽。

**宁可少抽，绝不编造。** 原文没有的信息不要推测，不要补充你认为合理的默认值。
返回空数组 \`[]\` 是完全正确且可接受的结果。

## 记忆卡片结构

每张卡片是一件事：

- \`type\`（必填）：${Object.keys(TYPES).join(' / ')}
- \`subject\`（必填）：关于谁或什么。用 \`user\` / \`project:名称\` / \`env:名称\` / \`lesson:主题\` 形式，**不能含空格**
- \`predicate\`（必填）：哪个侧面，英文 snake_case，**不能含空格**。
  这是最关键的字段 —— 同一 subject+predicate 只能有一条有效记忆，所以要问自己：
  「这条信息讲的是关于这个对象的哪个侧面？」如果两句话讲的是不同侧面，它们属于不同 predicate，不算重复。
- \`value\`（必填）：主张本身，一行讲完，不超过 60 字
- \`title\`（必填）：一句话概括，不超过 30 字
- \`body\`（可选）：背景、原因、边界条件，不超过 200 字
- \`confidence\`（0–1）：你的确定程度。信息模糊或需要推断时给 0.4–0.6
- \`importance\`（0–1）：对未来决策的影响程度
- \`tags\`（字符串数组）：1–4 个，用于聚类
- \`aliases\`（字符串数组）：**中文触发词**，1–4 个。
  用户会用中文提问，你要让中文词汇能命中这张卡。例如 value 是「结论先行」，
  aliases 可以是 \`["回复风格","怎么回答","说话风格"]\`

${styleHint}${slotSection}
## 正例

原文提到「用户回复风格偏好结论先行，不需要铺垫和免责声明」：

\`\`\`json
{"cards": [
  {
    "type": "preference",
    "title": "偏好结论先行的技术回答",
    "subject": "user",
    "predicate": "reply_style",
    "value": "结论先行，不要铺垫和免责声明",
    "body": "技术问题不需要背景介绍。",
    "confidence": 0.9,
    "importance": 0.6,
    "tags": ["communication"],
    "aliases": ["回复风格", "怎么回答"]
  }
]}
\`\`\`

注意这一条只讲「风格」。如果原文还说「用中文回复」，那是**另一张卡**（predicate: reply_language）。

## 反例

❌ 多件事塞进一张卡

原文：「用户喜欢简洁的回答，且用中文，且在 macOS 上开发」

拆成三张：

\`\`\`json
{"cards": [
  {"type":"preference","title":"偏好精简回答","subject":"user","predicate":"reply_style","value":"偏好简洁的回答","body":"","confidence":0.9,"importance":0.6,"tags":["communication"],"aliases":["简洁"]},
  {"type":"preference","title":"默认中文回复","subject":"user","predicate":"reply_language","value":"中文","body":"","confidence":0.9,"importance":0.6,"tags":["communication"],"aliases":["语言"]},
  {"type":"environment","title":"开发环境为 macOS","subject":"env:workstation","predicate":"os","value":"macOS","body":"","confidence":0.9,"importance":0.8,"tags":["infra"],"aliases":["系统"]}
]}
\`\`\`

如果合成一张，\`subject\`+\`predicate\` 就无法准确描述，冲突检测会失效。

❌ 抽取无价值信息：寒暄、临时任务进度、agent 的中间推理、重复的确认

❌ 把推测当事实：原文说「可能下周完成」，不要写成「下周完成」

❌ 合并时丢失细节：具体数字、路径、条件要放进 \`body\`

## 输出要求

**只输出 JSON，不要任何解释文字。** 格式：

\`\`\`json
{"cards": [...]}
\`\`\`

### 怎么写回文件

每块内容对应一个结果文件，路径在下面「待处理分块」清单里给出。
把 JSON 写进对应的 \`results/\` 目录，文件名保持一致（扩展名改为 \`.result.json\`）。

如果某块确实没有值得抽取的内容，写 \`{"cards": []}\` 即可 —— 这也是有效结果，
不要为了"有产出"而硬凑。

写完之后回复一句简短确认（如「已完成 3/12 块」）即可，不要复述卡片内容。

## 待处理分块

${chunkListPlaceholder()}
`;
}

function chunkListPlaceholder() {
  return '（由 forge task 命令生成，见下方 CHUNKS 段落）';
}

/**
 * 写出一个任务包。
 */
function writeTaskPackage(outDir, { chunks, meta = {}, cards = [] }) {
  const root = path.resolve(outDir);
  const chunksDir = path.join(root, CHUNKS_DIR);
  const resultsDir = path.join(root, RESULTS_DIR);
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const chunkEntries = [];
  const allParts = [];

  chunks.forEach((chunk, i) => {
    const id = String(i + 1).padStart(3, '0');
    const baseName = `${id}-${slugish(chunk._sourceFile || 'chunk')}`;

    // 纯文件头分块（只有 file-meta 记录）没有实质内容。
    // 把它单列成一块会白白消耗 agent 一次读写往返 —— agent 只能回一句
    // {"cards": []}。这里提前标记，让 agent 知道可以直接跳过。
    const isMetaOnly = chunk.records.length > 0
      && chunk.records.every((r) => r.kind === 'file-meta');
    if (isMetaOnly) {
      const metaPath = path.join(chunksDir, `${baseName}.md`);
      fs.writeFileSync(metaPath, [
        `# 分块 ${id}`,
        '',
        '**此分块仅含文件元信息，无可抽取内容。**',
        '',
        `请直接写 \`{"cards": []}\` 到 \`${RESULTS_DIR}/${baseName}.result.json\` 即可跳过。`,
        '',
      ].join('\n'), 'utf8');
      chunkEntries.push({
        index: i,
        id,
        baseName,
        sourceFile: chunk._sourceFile || '',
        chars: chunk.chars,
        recordCount: 0,
        skippable: true,
        readPath: `${CHUNKS_DIR}/${baseName}.md`,
        resultPath: `${RESULTS_DIR}/${baseName}.result.json`,
      });
      return;
    }

    const mdPath = path.join(chunksDir, `${baseName}.md`);
    const jsonPath = path.join(chunksDir, `${baseName}.json`);

    // 每个分块的原文，agent 直接读这个
    const md = [
      `# 分块 ${id}`,
      '',
      `来源：${chunk._sourceFile || '未知'}`,
      `片段数：${chunk.recordCount}　字符数：${chunk.chars}`,
      '',
      '---',
      '',
      chunk.text,
      '',
      '---',
      '',
      `把结果写入 \`${RESULTS_DIR}/${baseName}.result.json\``,
    ].join('\n');

    fs.writeFileSync(mdPath, md, 'utf8');
    fs.writeFileSync(jsonPath, JSON.stringify({
      index: i,
      id,
      sourceFile: chunk._sourceFile || '',
      chars: chunk.chars,
      recordCount: chunk.recordCount,
      text: chunk.text,
      records: chunk.records.map((r) => ({
        id: r.id, locator: r.locator, kind: r.kind, chars: r.chars,
      })),
    }, null, 2), 'utf8');

    chunkEntries.push({
      index: i,
      id,
      baseName,
      sourceFile: chunk._sourceFile || '',
      chars: chunk.chars,
      recordCount: chunk.recordCount,
      readPath: `${CHUNKS_DIR}/${baseName}.md`,
      resultPath: `${RESULTS_DIR}/${baseName}.result.json`,
    });

    allParts.push(md);
  });

  fs.writeFileSync(path.join(root, ALL_MD), allParts.join('\n\n\n'), 'utf8');

  const existing = (meta.existingSlots || []).slice(0, 60);
  const instructions = buildInstructions({
    sourceDesc: meta.sourceDesc || '待分析文本',
    existingSlots: existing,
    style: meta.style || 'auto',
  }).replace(chunkListPlaceholder(), buildChunkList(chunkEntries));

  fs.writeFileSync(path.join(root, INSTRUCTIONS), instructions, 'utf8');

  const manifest = {
    specVersion: SPEC_VERSION,
    taskId: `task_${Date.now()}`,
    createdAt: new Date().toISOString(),
    mode: 'agent',
    sourceDesc: meta.sourceDesc || '',
    style: meta.style || 'auto',
    existingSlots: existing,
    chunkCount: chunks.length,
    chunks: chunkEntries,
    resultFormat: 'results/<baseName>.result.json → {"cards":[...]}',
  };
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');

  return { root, manifest, instructionsPath: path.join(root, INSTRUCTIONS) };
}

function buildChunkList(entries) {
  if (!entries.length) return '（无分块）';
  return entries.map((c) => {
    const note = c.skippable
      ? C_HTML_NOTE
      : `（${c.recordCount} 片段 / ${c.chars} 字符，来源 ${c.sourceFile || '未知'}）`;
    return `- **${c.id}** — 读 \`${c.readPath}\`，写 \`${c.resultPath}\` ${note}`;
  }).join('\n');
}

const C_HTML_NOTE = '（仅含文件元信息，可直接写 `{"cards": []}` 跳过）';

function slugish(text) {
  return String(text || 'chunk')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'chunk';
}

// --- 结果导入 -----------------------------------------------------------

/**
 * 容错解析 agent 的输出。
 *
 * agent 不会严格照搬格式，实际会遇到的偏差：
 *   - 包在 ```json 围栏里
 *   - 前后带解说文字
 *   - 直接输出数组而不是 {"cards":[...]}
 *   - 用 content/category 代替 body/type
 *   - subject 与 predicate 合成一个 slot 字段
 *
 * 这些都属于格式偏差而非判断错误，值得尽力吸收而不是直接丢弃。
 */
function coerceAgentCard(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let obj = { ...raw };

  // 1) 字段别名
  const alias = (from, to) => {
    if (obj[to] === undefined && obj[from] !== undefined) obj[to] = obj[from];
  };
  alias('category', 'type');
  alias('content', 'body');
  alias('text', 'body');
  alias('name', 'title');
  alias('slot', 'subject');
  alias('key', 'value');
  alias('desc', 'body');
  alias('summary', 'body');

  // 2) subject+predicate 被合成一个 slot 字段时拆回来
  if (obj.subject && !obj.predicate && typeof obj.subject === 'string' && obj.subject.includes('::')) {
    const [s, p] = obj.subject.split('::');
    obj.subject = s;
    obj.predicate = p;
  }
  // 反过来：只有一个 slot 字符串，没有 subject
  if (!obj.subject && typeof raw.slot === 'string' && raw.slot.includes('::')) {
    const [s, p] = raw.slot.split('::');
    obj.subject = s;
    obj.predicate = p;
  }

  // 3) type 大小写与中文标签归一
  if (obj.type) {
    const t = String(obj.type).trim();
    const zhMap = {
      身份: 'profile', 身份事实: 'profile',
      偏好: 'preference', 偏好约定: 'preference',
      环境: 'environment', 环境事实: 'environment',
      项目: 'project', 进行中工作: 'project',
      规程: 'procedure', 操作规程: 'procedure', 流程: 'procedure',
      教训: 'lesson', 经验: 'lesson', 经验教训: 'lesson',
      决策: 'decision', 决策记录: 'decision',
      事件: 'episode', 事件记录: 'episode',
    };
    obj.type = TYPES[t.toLowerCase()] ? t.toLowerCase() : (zhMap[t] || t.toLowerCase());
  }

  // 4) value 缺失时从 title 退化
  if (!obj.value && obj.title) obj.value = obj.title;

  // 5) tags/aliases 统一成数组
  for (const k of ['tags', 'aliases']) {
    if (typeof obj[k] === 'string') {
      obj[k] = obj[k].split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    }
  }

  // 6) 去掉 agent 常加的额外字段，避免污染 frontmatter
  for (const k of ['recordId', 'locator', 'source', 'index', 'reason', 'confidence_note']) {
    delete obj[k];
  }

  return normalizeCard(obj, { source: 'forge:agent' });
}

/**
 * 读取一个结果文件，返回卡片数组与问题列表。
 */
function readResultFile(filePath, chunkMeta) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { cards: [], error: `无法读取：${err.message}` };
  }

  const parsed = parseLooseJSON(text);
  if (!parsed) {
    return {
      cards: [],
      error: '无法解析为 JSON',
      raw: text.slice(0, 300),
    };
  }

  // 支持三种形态：{"cards":[]} / [...] / 多个卡片构成的数组
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (Array.isArray(parsed.cards)) list = parsed.cards;
  else if (Array.isArray(parsed.memories)) list = parsed.memories;
  else if (Array.isArray(parsed.items)) list = parsed.items;
  else if (parsed.card) list = [parsed.card];
  else {
    // 兜底：取对象里第一个数组字段
    const arrField = Object.values(parsed).find((v) => Array.isArray(v) && v.length
      && typeof v[0] === 'object');
    if (arrField) list = arrField;
  }

  if (!Array.isArray(list)) {
    return { cards: [], error: '未找到卡片数组', raw: text.slice(0, 300) };
  }

  const cards = [];
  const rejected = [];
  for (const raw of list.slice(0, 60)) {
    const card = coerceAgentCard(raw);
    if (!card) {
      rejected.push({
        item: String(raw && (raw.title || raw.value || JSON.stringify(raw)).slice(0, 120)),
        reason: '字段不完整或类型无效',
      });
      continue;
    }
    // schema 校验但不一票否决 —— 把问题记录下来交给人判断
    const problems = validateCard(card);
    if (problems.some((p) => p.includes('缺少必填') || p.includes('不能同时为空'))) {
      rejected.push({ item: card.title || card.value, reason: problems.join('；') });
      continue;
    }
    if (problems.length) card._warnings = problems;
    if (chunkMeta) {
      card._chunkIndex = chunkMeta.index;
      card._sourceFile = chunkMeta.sourceFile;
      card.source = `forge:agent/${chunkMeta.baseName}`;
    }
    cards.push(card);
  }

  return { cards, rejected, warnings: cards.filter((c) => c._warnings).length };
}

/**
 * 导入任务包的全部结果。
 */
function importResults(taskDir, { strict = false } = {}) {
  const root = path.resolve(taskDir);
  const manifestPath = path.join(root, MANIFEST);

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `未找到 ${MANIFEST}，这不是有效的任务包目录：${root}` };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `manifest.json 解析失败：${err.message}` };
  }

  if (manifest.specVersion !== SPEC_VERSION) {
    return {
      ok: false,
      error: `任务包版本不匹配（包 ${manifest.specVersion}，工具 ${SPEC_VERSION}），请重新生成任务包`,
    };
  }

  const chunks = manifest.chunks || [];
  const all = [];
  const rejected = [];
  const perChunk = [];
  const missing = [];

  for (const c of chunks) {
    const resultPath = path.join(root, c.resultPath);
    if (!fs.existsSync(resultPath)) {
      missing.push(c);
      perChunk.push({ ...c, state: 'missing' });
      continue;
    }
    const res = readResultFile(resultPath, c);
    if (res.error) {
      perChunk.push({ ...c, state: 'error', error: res.error, raw: res.raw });
      if (strict) {
        return { ok: false, error: `分块 ${c.id} 解析失败：${res.error}` };
      }
      continue;
    }
    all.push(...res.cards);
    (res.rejected || []).forEach((r) => rejected.push({ chunk: c.id, ...r }));
    perChunk.push({
      ...c,
      state: 'ok',
      cardCount: res.cards.length,
      rejected: (res.rejected || []).length,
      warnings: res.warnings || 0,
    });
  }

  const doneCount = perChunk.filter((c) => c.state === 'ok').length;

  return {
    ok: true,
    manifest,
    cards: all,
    rejected,
    perChunk,
    progress: {
      total: chunks.length,
      done: doneCount,
      missing: missing.length,
      percent: chunks.length ? Math.round((doneCount / chunks.length) * 100) : 0,
    },
  };
}

/** 只读地查看任务包进度，不解析卡片 */
function taskStatus(taskDir) {
  const root = path.resolve(taskDir);
  const manifestPath = path.join(root, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `未找到 ${MANIFEST}：${root}` };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const chunks = (manifest.chunks || []).map((c) => {
    const rp = path.join(root, c.resultPath);
    let state = 'missing';
    let cardCount = null;
    if (fs.existsSync(rp)) {
      const res = readResultFile(rp, c);
      if (res.error) state = 'error';
      else { state = 'ok'; cardCount = res.cards.length; }
    }
    return { id: c.id, sourceFile: c.sourceFile, resultPath: c.resultPath, state, cardCount };
  });
  const done = chunks.filter((c) => c.state === 'ok').length;
  return {
    ok: true,
    taskId: manifest.taskId,
    createdAt: manifest.createdAt,
    total: chunks.length,
    done,
    percent: chunks.length ? Math.round((done / chunks.length) * 100) : 0,
    chunks,
  };
}

module.exports = {
  SPEC_VERSION,
  MANIFEST,
  INSTRUCTIONS,
  CHUNKS_DIR,
  RESULTS_DIR,
  ALL_MD,
  buildInstructions,
  writeTaskPackage,
  importResults,
  taskStatus,
  readResultFile,
  coerceAgentCard,
};
