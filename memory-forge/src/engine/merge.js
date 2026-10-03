'use strict';
/**
 * 归并：批内去重、跨批去重、与已有记忆库冲突对比。
 *
 * 冲突判定沿用 memory-palace 的 slot 语义：
 *   同一 (subject, predicate) 下出现两条不同的主张 = 冲突。
 * 这与 palace 的 doctor 检测口径完全一致，因此 GUI 里看到的冲突
 * 就是导入后 palace 会报的冲突，不会出现两套标准。
 */

const { digestOf, validateCard } = require('./schema');

/** 近似重复检测：忽略标点与空白后的字符集合相似度 */
function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

/**
 * 相似度。
 *
 * 不用朴素的 bigram Jaccard —— 它对短文本系统性偏低
 * （「结论先行」vs「结论先行，不要铺垫」只有 0.43，会被误判为矛盾）。
 * 改用 Dice + 较短文本覆盖率 的加权组合，既惩罚长度悬殊，
 * 又不会因为一侧是另一侧的子串就完全失效。
 */
function similarity(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const grams = (s) => {
    const set = new Set();
    if (s.length === 1) { set.add(s); return set; }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };

  const ga = grams(na);
  const gb = grams(nb);
  if (!ga.size || !gb.size) return 0;

  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;

  const dice = (2 * inter) / (ga.size + gb.size);
  // 较短一方被覆盖的比例：捕捉「一方是另一方子集」——
  // 这是记忆补充细节最典型的形态（"结论先行" → "结论先行，不要铺垫"）
  const coverage = inter / Math.min(ga.size, gb.size);
  // 长度一致性：抑制长文本蹭短文本高分，但给足下限，
  // 否则「子集」这种最该判为相关的场景会被压到阈值以下
  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  const lengthFactor = 0.85 + 0.15 * lenRatio;

  return Math.min(1, (0.35 * dice + 0.65 * coverage) * lengthFactor);
}

function slotOf(card) {
  return `${String(card.subject || '').trim().toLowerCase()}::${String(card.predicate || '').trim().toLowerCase()}`;
}

/**
 * 阈值依据（由 test 中的用例校准，见 README「相似度阈值」）：
 *   完全相同 1.00 · 近义改写 0.94 · 补充细节 0.77–0.80
 *   同主题矛盾 0.60 · 同类不同值 0.50 · 同前缀无关 0.27 · 完全不同 0.00
 */
const THRESHOLD = {
  identical: 0.93,     // 与基线一致，跳过
  enrichment: 0.70,    // 相关但更详细，合并正文
  contradiction: 0.52, // 低于此值视为真正矛盾
  nearDuplicate: 0.88, // 批内近似重复
};

/**
 * 批内去重。exact = digest 完全相同；near = 同 slot 且 value 高度相似。
 */
function dedupe(cards, { nearThreshold = THRESHOLD.nearDuplicate } = {}) {
  const kept = [];
  const dropped = [];
  const byDigest = new Map();
  const bySlot = new Map();

  for (const card of cards) {
    if (card._dropped) continue;
    const d = card._digest || digestOf(card);
    const slot = slotOf(card);

    if (byDigest.has(d)) {
      dropped.push({ card, reason: 'exact-duplicate', mergedInto: byDigest.get(d)._localId });
      continue;
    }

    const peers = bySlot.get(slot) || [];
    const near = peers.find((p) => similarity(p.value, card.value) >= nearThreshold);
    if (near) {
      dropped.push({ card, reason: 'near-duplicate', mergedInto: near._localId });
      continue;
    }

    card._localId = card._localId || `L${kept.length + 1}`;
    card._digest = d;
    kept.push(card);
    byDigest.set(d, card);
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(card);
  }

  return { kept, dropped };
}

/**
 * 检出内部冲突：同一 slot 下多条主张不一致。
 */
function findInternalConflicts(cards) {
  const bySlot = new Map();
  for (const c of cards) {
    if (c._dropped) continue;
    const s = slotOf(c);
    if (!bySlot.has(s)) bySlot.set(s, []);
    bySlot.get(s).push(c);
  }

  const conflicts = [];
  for (const [slot, members] of bySlot) {
    if (members.length < 2) continue;

    const values = members.map((m) => normalizeForCompare(m.value));
    const allSame = values.every((v) => v === values[0]);
    const maxPairSim = Math.max(...members.map((a) =>
      Math.max(...members.filter((b) => b !== a).map((b) => similarity(a.value, b.value)))
    ));

    conflicts.push({
      slot,
      kind: allSame ? 'duplicate' : 'divergent',
      members,          // 传引用：裁决阶段依赖同一个对象的 _localId
      similarity: maxPairSim,
      suggestion: suggestResolution(members, maxPairSim),
    });
  }
  conflicts.sort((a, b) => b.members.length - a.members.length);
  return conflicts;
}

function suggestResolution(members, maxPairSim) {
  if (maxPairSim >= THRESHOLD.nearDuplicate) {
    return { action: 'merge', confidence: 0.95, rationale: '主张高度相似，建议合并为一条' };
  }
  // 明确变更措辞优先级最高：即使新旧表述高度重叠
  // （"设计中" → "已上线，不再是设计中" 相似度仍有 0.71），
  // 也应判为取代而非合并 —— 语义变了，措辞相似不算数。
  const hasExplicitChange = members.some((m) =>
    /(不再|改为|换成|改成|已经?上线|已上线|完成|结束|从现在起|no longer|switched to|instead of)/i.test(m.value || '')
  );
  if (hasExplicitChange) {
    return { action: 'supersede', confidence: 0.8, rationale: '存在明确变更措辞，建议保留最新的那条' };
  }
  if (maxPairSim >= THRESHOLD.enrichment) {
    return { action: 'merge', confidence: 0.75, rationale: '主张高度相似，建议合并为一条' };
  }
  return { action: 'escalate', confidence: 0, rationale: '主张不一致，需人工判断哪条为真' };
}

/**
 * 与已有记忆库对比。
 * baseline: 从 palace 的 cards 目录下解析出的卡片数组。
 */
function compareWithBaseline(newCards, baseline) {
  if (!baseline || baseline.length === 0) {
    return { conflicts: [], newSlots: [...new Set(newCards.map(slotOf))], updates: [] };
  }

  const baseBySlot = new Map();
  for (const b of baseline) {
    if (b.status !== 'active') continue;
    const s = slotOf(b);
    if (!baseBySlot.has(s)) baseBySlot.set(s, []);
    baseBySlot.get(s).push(b);
  }

  const conflicts = [];
  const updates = [];
  const newSlotSet = new Set();

  const newBySlot = new Map();
  for (const c of newCards) {
    if (c._dropped) continue;
    const s = slotOf(c);
    if (!newBySlot.has(s)) newBySlot.set(s, []);
    newBySlot.get(s).push(c);
  }

  for (const [slot, incoming] of newBySlot) {
    const existing = baseBySlot.get(slot);
    if (!existing || existing.length === 0) {
      newSlotSet.add(slot);
      continue;
    }

    // 逐条比对：完全一致 / 高度相似（等于补细节）/ 真正矛盾
    for (const inc of incoming) {
      let best = null;
      let bestSim = 0;
      for (const ex of existing) {
        const sim = similarity(inc.value, ex.value);
        if (sim > bestSim) { bestSim = sim; best = ex; }
      }

      if (bestSim >= THRESHOLD.identical) {
        conflicts.push({
          slot, kind: 'identical', newCard: inc, existingCard: best, similarity: bestSim,
          suggestion: { action: 'skip', confidence: 0.95, rationale: '与已有记忆一致，建议跳过' },
        });
      } else if (bestSim >= THRESHOLD.enrichment) {
        conflicts.push({
          slot, kind: 'enrichment', newCard: inc, existingCard: best, similarity: bestSim,
          suggestion: { action: 'enrich', confidence: 0.8, rationale: '与已有记忆相关但更详细，建议合并正文' },
        });
      } else {
        conflicts.push({
          slot, kind: 'contradiction', newCard: inc, existingCard: best, similarity: bestSim,
          suggestion: { action: 'escalate', confidence: 0, rationale: '与已有记忆矛盾，需人工确认哪条为真' },
        });
      }
    }
  }

  conflicts.sort((a, b) => {
    const rank = { contradiction: 0, enrichment: 1, identical: 2 };
    return rank[a.kind] - rank[b.kind] || a.similarity - b.similarity;
  });

  // 已有记忆库里存在、但本次导入未覆盖的 slot —— 可能是遗漏，值得提示
  const covered = new Set(newBySlot.keys());
  for (const [slot, existing] of baseBySlot) {
    if (!covered.has(slot) && existing.length > 0) {
      updates.push({ slot, existingCount: existing.length });
    }
  }

  return { conflicts, newSlots: [...newSlotSet], updates };
}

/**
 * 应用人工裁决。
 * decisions: [{ slot, action, keepLocalIds?, note? }]
 */
function applyDecisions(cards, conflicts, decisions) {
  const actionOf = new Map();
  decisions.forEach((d) => actionOf.set(d.slot, d.action));

  const dropped = new Set();
  const mergedBodies = new Map();
  const notes = new Map();

  conflicts.forEach((cf) => {
    const action = actionOf.get(cf.slot);
    if (!action) return;
    const members = cf.members;

    if (action === 'merge') {
      // 保留信息量最大的一条，其余正文并入
      const sorted = [...members].sort((a, b) =>
        String(b.body || '').length + String(b.value || '').length -
        (String(a.body || '').length + String(a.value || '').length)
      );
      const keeper = sorted[0];
      mergedBodies.set(keeper._localId, sorted.slice(1)
        .map((m) => m.value + (m.body ? `\n${m.body}` : ''))
        .filter(Boolean)
        .join('\n\n'));
      sorted.slice(1).forEach((m) => dropped.add(m._localId));
      if (sorted[1]) {
        notes.set(keeper._localId, `合并了 ${sorted.length - 1} 条重复记忆（来自同一 slot）`);
      }
    } else if (action === 'supersede') {
      const sorted = [...members].sort((a, b) =>
        String(b.recorded_at || '').localeCompare(String(a.recorded_at || ''))
      );
      sorted.slice(1).forEach((m) => dropped.add(m._localId));
      notes.set(sorted[0]._localId, `取代了同 slot 的 ${sorted.length - 1} 条旧记忆`);
    } else if (action === 'keep-first') {
      const sorted = [...members];
      sorted.slice(1).forEach((m) => dropped.add(m._localId));
    } else if (action === 'dispute') {
      members.forEach((m) => { m.status = 'disputed'; });
    } else if (action === 'drop') {
      members.forEach((m) => dropped.add(m._localId));
    } else if (action === 'skip') {
      members.forEach((m) => dropped.add(m._localId));
    }
  });

  const out = [];
  cards.forEach((c) => {
    if (c._dropped || dropped.has(c._localId)) return;
    const card = { ...c };
    if (mergedBodies.has(c._localId)) {
      card.body = `${card.body || card.value}\n\n${mergedBodies.get(c._localId)}`.trim();
    }
    if (notes.has(c._localId)) {
      card.body = `${card.body || card.value}\n\n> 转换备注：${notes.get(c._localId)}`.trim();
    }
    out.push(card);
  });

  return out;
}

/**
 * 为导入的卡片分配 ID。需要传入已有 palace 的 seq 以避免冲突。
 */
function assignIds(cards, startSeq = 1, existingIds = new Set()) {
  let seq = startSeq;
  const used = new Set(existingIds);
  return cards.map((card) => {
    let id;
    do {
      id = `mem_${String(seq).padStart(5, '0')}`;
      seq++;
    } while (used.has(id));
    used.add(id);
    return { id, card };
  });
}

/** 最终导出前校验，过滤不合法卡片但保留原因 */
function finalCheck(cards) {
  const ok = [];
  const rejected = [];
  for (const c of cards) {
    const problems = validateCard(c);
    if (problems.length === 0) ok.push(c);
    else rejected.push({ card: c, problems });
  }
  return { ok, rejected };
}

module.exports = {
  THRESHOLD,
  dedupe,
  findInternalConflicts,
  compareWithBaseline,
  applyDecisions,
  assignIds,
  finalCheck,
  similarity,
  slotOf,
};
