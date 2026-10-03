'use strict';
/**
 * 浅尝模式 —— 从已有记忆库抽样并还原为记忆文本。
 *
 * ## 接入位置
 *
 * 完整模式的输入是「文件」，浅尝模式的输入是「记忆库」。两者最终都变成
 * Record[] 再交给同一套 chunkRecords → extractAll → dedupe → 冲突检测 管线。
 *
 *   完整模式：文件 → parseContent → records ─┐
 *                                           ├→ chunkRecords → extractAll → …
 *   浅尝模式：记忆库 → loadPalace → 抽样 → 还原为 records ─┘
 *
 * 因此浅尝模式不新增任何整理逻辑，只在管线**之前**多了一个「取样与还原」环节。
 * 这保证了试运行与全量运行的结果口径完全一致——同样的模型、同样的分块、
 * 同样的冲突判定，唯一的区别是喂进去的样本量。
 *
 * ## 只读保证
 *
 * 本模块只调用 loadPalace（只读）与 readFile，不做任何写操作。
 * 导出路径由 main.js 的 writeExport 守卫拦截（trial 模式直接禁止写入）。
 */

const fs = require('fs');
const path = require('path');

const { loadPalace } = require('./palace');

// --- 可复现随机数 -------------------------------------------------------

/**
 * mulberry32：小而快的可复现 PRNG。
 * 用固定 seed 可以让两次试运行抽到同一批记忆，从而对比不同模型/参数的效果。
 */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- 目标库校验 ---------------------------------------------------------

const ERROR_CATALOG = {
  NOT_FOUND: { title: '记忆库路径不存在', hint: '请确认路径拼写正确，且目录已创建。' },
  NOT_A_DIRECTORY: { title: '路径不是目录', hint: '请选择记忆库的根目录，而不是其中的某个文件。' },
  NO_PERMISSION: { title: '没有读取权限', hint: '请检查目录权限，或以有权限的身份运行。' },
  NO_CARDS: { title: '记忆库中没有记忆卡', hint: '目录下未找到 cards/**/*.md。确认这是 memory-palace 的根目录。' },
  NO_MATCHING: { title: '没有符合筛选条件的记忆', hint: '记忆库有卡片，但没有 active 状态的记忆，换个筛选范围试试。' },
  NO_SAMPLE: { title: '抽样数量不足', hint: '请提高数量或比例；数量与比例至少为 1。' },
  BAD_COUNT: { title: '抽样数量无效', hint: '数量需为正整数。' },
  BAD_RATIO: { title: '抽样比例无效', hint: '比例需在 0~1 之间（不含 0）。' },
  BAD_STRATEGY: { title: '未知的抽样策略', hint: '可选 random / stratified / slot。' },
  BAD_SCOPE: { title: '未知的筛选范围', hint: '可选 active / all。' },
  BAD_SEED: { title: '随机种子无效', hint: '种子需为整数，填写相同种子可复现同一样本。' },
  PROBLEMS: { title: '记忆库存在读取问题', hint: '部分卡片无法解析，请先修复后再试运行。' },
};

/**
 * 校验目标记忆库路径。区分「不存在 / 不是目录 / 无权限」，
 * 因为这三种情况的处理方式完全不同，不能笼统报「打开失败」。
 */
function validateTarget(root) {
  if (!root || typeof root !== 'string') {
    return { ok: false, code: 'NOT_FOUND', detail: '未提供路径' };
  }
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, code: 'NOT_FOUND', detail: root };
    }
    if (err.code === 'EACCES') {
      return { ok: false, code: 'NO_PERMISSION', detail: root };
    }
    return { ok: false, code: 'NOT_FOUND', detail: `${root} (${err.message})` };
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return {
      ok: false,
      code: err.code === 'EACCES' ? 'NO_PERMISSION' : 'NOT_FOUND',
      detail: resolved,
    };
  }

  if (!stat.isDirectory()) {
    return { ok: false, code: 'NOT_A_DIRECTORY', detail: resolved };
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (_) {
    return { ok: false, code: 'NO_PERMISSION', detail: resolved };
  }

  const loaded = loadPalace(resolved);
  return {
    ok: true,
    root: resolved,
    cards: loaded.cards,
    ids: loaded.ids,
    maxSeq: loaded.maxSeq,
    problems: loaded.problems,
  };
}

/** 把校验结果转成可直接展示的错误对象 */
function toError(result) {
  const meta = ERROR_CATALOG[result.code] || { title: '未知错误', hint: '' };
  return {
    ok: false,
    code: result.code,
    title: meta.title,
    hint: meta.hint,
    detail: result.detail || '',
  };
}

// --- 抽样 ---------------------------------------------------------------

const STRATEGIES = {
  random: {
    label: '随机抽样',
    hint: '在候选池中等概率抽取。适合快速验证流程是否跑通。',
  },
  stratified: {
    label: '分层抽样',
    hint: '按记忆类型分层，保证每种类型都有代表。适合预览归类效果。',
  },
  slot: {
    label: 'slot 扩散',
    hint: '优先覆盖不同 slot，便于暴露同一 slot 的潜在冲突。',
  },
};

const STATUS_SCOPES = {
  active: { label: '仅 active', hint: '只抽取当前生效的记忆（推荐）' },
  all: { label: '全部状态', hint: '含 superseded / expired / disputed' },
};

/**
 * 计算抽样计划（不执行抽取）。
 * count 与 ratio 二选一：ratio 为空时用 count，否则用 ratio。
 */
function planSample(cards, opts = {}) {
  const {
    strategy = 'random',
    count = null,
    ratio = null,
    statusScope = 'active',
    seed = null,
  } = opts;

  const warnings = [];

  if (!STRATEGIES[strategy]) {
    return { ok: false, code: 'BAD_STRATEGY', detail: `未知策略 ${strategy}` };
  }
  if (!STATUS_SCOPES[statusScope]) {
    return { ok: false, code: 'BAD_SCOPE', detail: `未知筛选范围 ${statusScope}` };
  }

  const pool = statusScope === 'active'
    ? cards.filter((c) => c.status === 'active')
    : [...cards];

  if (cards.length === 0) {
    return { ok: false, code: 'NO_CARDS' };
  }
  if (pool.length === 0) {
    return { ok: false, code: 'NO_MATCHING' };
  }

  // --- 目标样本数 ---
  let target;
  const useRatio = ratio !== null && ratio !== undefined && ratio !== '';
  if (useRatio) {
    const r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0 || r > 1) {
      return { ok: false, code: 'BAD_RATIO', detail: `比例必须在 0~1 之间，当前 ${ratio}` };
    }
    target = Math.ceil(pool.length * r);
    if (target < 1) {
      return { ok: false, code: 'NO_SAMPLE', detail: `${pool.length} × ${r} < 1` };
    }
  } else {
    // 注意不能用 `Number(count) || 20` —— 那会把 0 当假值静默替换成默认值 20，
    // 导致用户明确填 0 时拿到 1 条而非报错。
    const n = count === null || count === undefined || count === '' ? 20 : Number(count);
    if (!Number.isFinite(n)) {
      return { ok: false, code: 'BAD_COUNT', detail: `数量需为数字，当前 ${count}` };
    }
    if (n < 1) {
      return { ok: false, code: 'NO_SAMPLE', detail: `数量 ${count} < 1` };
    }
    target = Math.floor(n);
  }

  // 抽样数量超出容量：下调并明确告知，而不是静默截断
  if (target > pool.length) {
    warnings.push({
      code: 'SAMPLE_CLAMPED',
      message: `请求 ${target} 条，候选池只有 ${pool.length} 条，已按全部抽取`,
    });
    target = pool.length;
  }

  const effectiveSeed = seed === null || seed === undefined || seed === ''
    ? Math.floor(Math.random() * 2 ** 31)
    : Number(seed);
  if (!Number.isFinite(effectiveSeed)) {
    return { ok: false, code: 'BAD_SEED', detail: `seed 需为整数，当前 ${seed}` };
  }

  const rng = makeRng(effectiveSeed);
  let picked = [];

  if (strategy === 'random') {
    picked = shuffle(pool, rng).slice(0, target);
  } else if (strategy === 'stratified') {
    picked = stratifyBy(pool, target, rng);
    const coveredTypes = new Set(picked.map((c) => c.type));
    const allTypes = new Set(pool.map((c) => c.type));
    const missed = [...allTypes].filter((t) => !coveredTypes.has(t));
    if (missed.length) {
      warnings.push({
        code: 'SAMPLE_COVERAGE',
        message: `样本量不足以覆盖全部 ${allTypes.size} 种类型，缺少：${missed.join('、')}`,
      });
    }
  } else if (strategy === 'slot') {
    const res = spreadBySlot(pool, target, rng);
    picked = res.picked;
    if (res.uncoveredSlots) {
      warnings.push({
        code: 'SAMPLE_COVERAGE',
        message: `共 ${res.totalSlots} 个 slot，样本只覆盖 ${picked.length} 个（每 slot 至多取 1 条）`,
      });
    }
  }

  // 稳定排序：按 id 升序，让同一样本在多次运行中顺序一致
  picked.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return {
    ok: true,
    strategy,
    statusScope,
    seed: effectiveSeed,
    target,
    poolSize: pool.length,
    totalSize: cards.length,
    ratio: useRatio ? Number(ratio) : null,
    sampled: picked,
    warnings,
  };
}

/** 最大余额法分配：按各类型占比分配配额，保证总数精确等于 target */
function stratifyBy(pool, target, rng) {
  const groups = new Map();
  pool.forEach((c) => {
    const k = c.type || '(未分类)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });

  const keys = [...groups.keys()];
  const exact = keys.map((k) => (groups.get(k).length / pool.length) * target);
  const quota = exact.map((f) => Math.floor(f));
  let assigned = quota.reduce((a, b) => a + b, 0);

  // 余数按小数部分从大到小补齐
  const remainders = exact
    .map((f, i) => ({ i, frac: f - Math.floor(f) }))
    .sort((a, b) => b.frac - a.frac);
  let ri = 0;
  while (assigned < target && remainders.length) {
    quota[remainders[ri % remainders.length].i]++;
    assigned++;
    ri++;
  }
  // 配额超过该组实际数量时回收
  const overflow = [];
  quota.forEach((q, i) => {
    const cap = groups.get(keys[i]).length;
    if (q > cap) {
      overflow.push(q - cap);
      quota[i] = cap;
    }
  });
  let reclaimed = overflow.reduce((a, b) => a + b, 0);
  while (reclaimed > 0) {
    for (let i = 0; i < quota.length && reclaimed > 0; i++) {
      const cap = groups.get(keys[i]).length;
      const room = cap - quota[i];
      if (room > 0) {
        quota[i]++;
        reclaimed--;
      }
    }
  }

  const out = [];
  keys.forEach((k, i) => {
    if (quota[i] <= 0) return;
    out.push(...shuffle(groups.get(k), rng).slice(0, quota[i]));
  });
  return out;
}

/** 每个 slot 至多取 1 条，最大化 slot 覆盖 */
function spreadBySlot(pool, target, rng) {
  const bySlot = new Map();
  pool.forEach((c) => {
    const k = `${c.subject || '(无)'}::${c.predicate || '(无)'}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(c);
  });

  const slotKeys = shuffle([...bySlot.keys()], rng);
  const out = [];
  for (const k of slotKeys) {
    if (out.length >= target) break;
    const candidates = shuffle(bySlot.get(k), rng);
    // 该 slot 内优先取 active
    const active = candidates.find((c) => c.status === 'active') || candidates[0];
    out.push(active);
  }

  // 若 slot 数不足 target，用剩余候选补齐
  if (out.length < target) {
    const chosen = new Set(out.map((c) => c.id));
    const rest = shuffle(pool.filter((c) => !chosen.has(c.id)), rng);
    for (const c of rest) {
      if (out.length >= target) break;
      out.push(c);
    }
  }

  return { picked: out, totalSlots: bySlot.size };
}

// --- 卡片还原为记忆文本 ---------------------------------------------------

const TYPE_LABEL = {
  profile: '身份事实', preference: '偏好约定', environment: '环境事实',
  project: '进行中工作', procedure: '操作规程', lesson: '经验教训',
  decision: '决策记录', episode: '事件记录',
};

/**
 * 把一张记忆卡渲染成「一条记忆文本」。
 *
 * 刻意做成朴素文本而非直接把卡片塞进结果：这样浅尝模式走的是和真实
 * 记忆文件完全一样的解析路径，抽取环节的输入形态一致，试运行结果才有参考价值。
 */
function cardToRecord(card, index) {
  const lines = [];
  lines.push(`[记忆卡 ${card.id}]`);
  lines.push(`类型: ${TYPE_LABEL[card.type] || card.type}`);
  if (card.title) lines.push(`标题: ${card.title}`);
  lines.push(`主题/侧面: ${card.subject}::${card.predicate}`);
  if (card.value) lines.push(`主张: ${card.value}`);
  if (card.status && card.status !== 'active') lines.push(`状态: ${card.status}`);
  if (card.tags && card.tags.length) lines.push(`标签: ${card.tags.join('、')}`);
  if (card.aliases && card.aliases.length) lines.push(`别名: ${card.aliases.join('、')}`);
  if (card.body) lines.push(`正文:\n${card.body}`);
  const text = lines.join('\n');

  return {
    id: `s_${String(index + 1).padStart(4, '0')}`,
    text,
    locator: `${card.path || card.id}`,
    chars: text.length,
    kind: 'palace-card',
    section: TYPE_LABEL[card.type] || card.type,
    _cardId: card.id,
    _cardType: card.type,
    _cardStatus: card.status,
  };
}

/**
 * 把抽样结果转成 parser 认识的 Record[]，可直接喂给 chunkRecords。
 *
 * 关键：这里直接产出 Record，而不是把文本拼起来再交给 parseContent。
 * 因为 parseContent 会按标题层级合并段落，多张卡片拼成的文本会被并成
 * 一个块，导致「一条记录 = 一张记忆卡」的对应关系丢失、溯源失效。
 * 直接构造记录则保证一卡一条，与完整模式下 parseContent 的产物同构。
 */
function sampleToRecords(sampled) {
  return sampled.map((c, i) => cardToRecord(c, i));
}

// --- 试运行报告 ---------------------------------------------------------

/**
 * 汇总试运行结果。刻意只做「统计与归纳」，不做判断——
 * 判断留给完整模式的审查步骤。
 */
function buildReport(plan, extraction) {
  const sampled = plan.sampled;
  const byType = {};
  const byStatus = {};
  const bySubject = {};
  const slots = new Set();

  sampled.forEach((c) => {
    byType[c.type] = (byType[c.type] || 0) + 1;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    const head = (c.subject || '(未分类)').split(':')[0];
    bySubject[head] = (bySubject[head] || 0) + 1;
    slots.add(`${c.subject}::${c.predicate}`);
  });

  const cards = extraction.cards || [];
  const cardByType = {};
  cards.forEach((c) => { cardByType[c.type] = (cardByType[c.type] || 0) + 1; });

  const conflicts = extraction.internalConflicts || [];
  const dropped = extraction.deduped || [];
  const errors = extraction.errors || [];

  // 抽取覆盖率：多少张卡片通过了 schema 校验
  const validCount = cards.filter((c) => c.type && c.subject && c.predicate).length;

  return {
    mode: 'trial',
    sampling: {
      strategy: plan.strategy,
      strategyLabel: STRATEGIES[plan.strategy].label,
      statusScope: plan.statusScope,
      statusScopeLabel: STATUS_SCOPES[plan.statusScope].label,
      seed: plan.seed,
      requested: plan.target,
      poolSize: plan.poolSize,
      totalSize: plan.totalSize,
      ratio: plan.ratio,
      coverageRatio: plan.poolSize ? Number((plan.target / plan.poolSize).toFixed(4)) : 0,
    },
    organization: {
      byType,
      byStatus,
      bySubject,
      uniqueSlots: slots.size,
      typeOrder: Object.keys(byType).sort((a, b) => byType[b] - byType[a]),
    },
    extraction: {
      extracted: cards.length,
      valid: validCount,
      deduped: dropped.length,
      conflicts: conflicts.length,
      errors: errors.length,
      byType: cardByType,
    },
    warnings: [...(plan.warnings || [])],
    conflicts,
    errors,
    sampleCards: sampled.slice(0, 20).map((c) => ({
      id: c.id, title: c.title, type: c.type, status: c.status,
      slot: `${c.subject}::${c.predicate}`, value: c.value,
    })),
  };
}

/** 生成一句话摘要，用于界面顶部快速判断「这次试运行值不值」 */
function summarize(report) {
  const { sampling: s, extraction: e, organization: o } = report;
  const parts = [];
  parts.push(`从 ${s.totalSize} 张记忆中抽样 ${s.requested} 张（${s.strategyLabel}，占候选池 ${Math.round(s.coverageRatio * 100)}%）`);
  parts.push(`产出 ${e.extracted} 张结构化卡片`);
  if (e.deduped) parts.push(`去重 ${e.deduped} 条`);
  if (e.conflicts) parts.push(`发现 ${e.conflicts} 处 slot 冲突`);
  if (e.errors) parts.push(`${e.errors} 个分块出错`);
  parts.push(`覆盖 ${o.uniqueSlots} 个 slot、${o.typeOrder.length} 种类型`);
  return parts.join('；') + '。';
}

module.exports = {
  STRATEGIES,
  STATUS_SCOPES,
  ERROR_CATALOG,
  makeRng,
  shuffle,
  validateTarget,
  toError,
  planSample,
  sampleToRecords,
  cardToRecord,
  buildReport,
  summarize,
};
