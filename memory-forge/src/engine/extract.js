'use strict';
/**
 * 抽取管线：分块 → 提示词 → LLM → 归一化 → 去重 → 冲突检测。
 *
 * 提示词设计是抽取质量的关键。几个刻意为之的约束：
 *   1) 要求"一卡一事"，并明确给出反例（避免把一整段话塞进一张卡）
 *   2) 强调只抽取 durable 的事实，过滤掉寒暄、临时任务状态
 *   3) 明确 slot 语义（subject × predicate），因为它决定后续冲突检测
 *   4) 要求给中文 aliases —— 库内 slot 用英文，查询是中文
 *   5) 允许返回空数组。宁可少抽也不要编造，这是记忆系统的底线。
 */

const { LLMClient, parseLooseJSON } = require('./llm');
const { TYPE_ORDER, TYPES } = require('./schema');

const SYSTEM_PROMPT = `你是一个记忆抽取器，负责把 Agent 记忆文本（对话记录、日志、笔记、配置片段）转换为结构化记忆卡片。

## 核心原则

**只抽取值得长期记住的信息。** 判断标准：这个信息在未来某次对话中还会有用吗？如果只服务于当前这个任务，就不要抽。

**宁可少抽，绝不编造。** 原文没有的信息不要推测，不要补充你认为合理的默认值。返回空数组 [] 是完全可接受且正确的答案。

## 记忆卡片结构

每张卡片是一件事，字段含义：

- \`type\`：必填，取值之一
  - profile 身份事实：用户是谁、姓名、职业、城市、长期身份
  - preference 偏好约定：希望如何被对待，语气、格式、风格、禁忌
  - environment 环境事实：机器、路径、工具链、版本、账号位置
  - project 进行中工作：有目标有起止的工作项与当前状态
  - procedure 操作规程：怎么做，命令、流程、约定、检查清单
  - lesson 经验教训：踩过的坑与结论。最有复用价值
  - decision 决策记录：做了什么选择、为什么
  - episode 事件记录：发生过什么。仅在其他类型都不合适时用

- \`subject\`：必填，关于谁/什么。用 \`user\` / \`project:名称\` / \`env:名称\` / \`lesson:主题\` 这样的形式，不要含空格
- \`predicate\`：必填，哪个侧面，用 snake_case 英文，不要含空格。
  这是关键字段：同一 subject+predicate 只能有一条有效记忆。
  例：user + reply_style（回复风格）、user + reply_language（回复语言）、
      project:memory-palace + storage_design（存储设计）
- \`value\`：必填，主张本身，一行讲完，不超过 60 字
- \`title\`：必填，一句话概括，不超过 30 字
- \`body\`：补充背景、原因、边界条件。不超过 200 字
- \`confidence\`：0–1。你的确定程度。信息模糊或需要推断时给低值（0.4–0.6）
- \`importance\`：0–1。对未来决策的影响程度
- \`tags\`：字符串数组，1–4 个，用于聚类
- \`aliases\`：字符串数组，**中文触发词**，1–4 个。
  用户会用中文提问，你要让中文词汇能命中这张卡。例：aliases: ["回复风格","怎么回答"]

## 必须避免

❌ 把多件事塞进一张卡 —— 「用户喜欢简洁的回答，且用中文，且在 macOS 上开发」
   ✅ 拆成三张卡，分别对应 reply_style / reply_language / environment

❌ 抽取无价值信息 —— 寒暄、临时任务进度、agent 的中间推理、重复的确认

❌ 把推测当事实 —— 原文说「可能下周完成」，不要写成「下周完成」

❌ 合并时丢失细节 —— body 里保留具体数字、路径、条件

## 输出格式

只输出 JSON，不要任何解释文字。格式：
{"cards": [ {...}, {...} ]}

没有值得抽取的内容时输出：{"cards": []}`;

function buildUserPrompt(chunkText, opts = {}) {
  const { existingSlots = [], style = 'auto', sourceHint = '' } = opts;

  let ctx = '';
  if (sourceHint) ctx += `\n## 来源\n${sourceHint}\n`;
  if (style !== 'auto') {
    ctx += `\n## 本次侧重\n${style === 'preference' ? '优先抽取用户偏好与身份信息' :
      style === 'technical' ? '优先抽取环境配置、技术栈、操作规程' :
      style === 'lesson' ? '优先抽取经验教训与决策理由' : ''}\n`;
  }
  if (existingSlots.length) {
    ctx += `\n## 已有记忆的 slot（避免重复，除非原文明确改变了某条）\n${existingSlots.slice(0, 60).join('\n')}\n`;
  }

  return `${ctx}
## 待抽取内容
每个片段带有 <record> 标签，id 与 loc 属性用于回溯来源。

${chunkText}

## 输出
严格按系统消息中的 JSON 格式输出。`;
}

/**
 * 抽取一个分块。
 */
async function extractChunk(client, chunk, opts = {}) {
  const { sourceHint, existingSlots, style, signal } = opts;
  const rendered = opts.rendered || chunk.text || '';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(rendered, { existingSlots, style, sourceHint }) },
  ];

  let res;
  try {
    res = await client.chat(messages, {
      onRetry: opts.onRetry,
    });
  } catch (err) {
    return { cards: [], error: err.message, chunkIndex: chunk.index };
  }
  if (signal?.aborted) return { cards: [], aborted: true, chunkIndex: chunk.index };

  const parsed = parseLooseJSON(res.content);
  if (!parsed) {
    return {
      cards: [],
      error: '无法解析 LLM 返回的 JSON',
      raw: String(res.content).slice(0, 600),
      chunkIndex: chunk.index,
    };
  }

  const rawCards = Array.isArray(parsed) ? parsed : parsed.cards || parsed.memories || parsed.items || [];
  if (!Array.isArray(rawCards)) {
    return { cards: [], error: 'JSON 中未找到 cards 数组', raw: String(res.content).slice(0, 400), chunkIndex: chunk.index };
  }

  const { normalizeCard } = require('./schema');
  const cards = [];
  const rejected = [];
  for (const raw of rawCards.slice(0, 40)) {
    const card = normalizeCard(raw, {
      source: opts.source || 'forge:import',
      provenance: chunk.records.map((r) => ({ recordId: r.id, locator: r.locator })),
    });
    if (card) cards.push(card);
    else rejected.push(raw && (raw.title || raw.value || JSON.stringify(raw).slice(0, 120)));
  }

  return {
    cards,
    rejected,
    chunkIndex: chunk.index,
    usage: res.usage,
  };
}

/**
 * 批量抽取全部分块。
 * 单块失败不影响整体：失败信息单独收集，UI 上可见并可重试。
 */
async function extractAll(client, chunks, opts = {}) {
  const { onProgress, onChunkDone, signal } = opts;

  const results = await client.runPool(
    chunks,
    async (chunk) => {
      const res = await extractChunk(client, chunk, opts);
      if (onChunkDone) onChunkDone(res);
      return res;
    },
    {
      signal,
      onProgress: (p) => {
        if (onProgress) onProgress({ done: p.done, total: p.total, percent: Math.round((p.done / p.total) * 100) });
      },
    }
  );

  const all = [];
  const errors = [];
  const rejected = [];

  results.forEach((r, i) => {
    if (!r.ok) {
      errors.push({ chunkIndex: i, error: r.error, recordCount: chunks[i] ? chunks[i].recordCount : 0 });
      return;
    }
    if (r.value.aborted) return;
    if (r.value.error) {
      errors.push({
        chunkIndex: i,
        error: r.value.error,
        raw: r.value.raw,
        recordCount: chunks[i] ? chunks[i].recordCount : 0,
      });
    }
    if (r.value.rejected) {
      rejected.push(...r.value.rejected.map((x) => ({ chunkIndex: i, item: x })));
    }
    if (r.value.cards) {
      r.value.cards.forEach((c) => {
        c._chunkIndex = i;
        all.push(c);
      });
    }
  });

  return { cards: all, errors, rejected, chunkCount: chunks.length };
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt, extractChunk, extractAll };
