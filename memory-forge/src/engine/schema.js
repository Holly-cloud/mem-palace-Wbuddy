'use strict';
/**
 * 记忆卡 schema —— 与 memory-palace 的 card.py 严格对齐。
 *
 * 这里刻意复刻校验规则而不是重写一套：GUI 产出的卡片必须能通过
 * `palace add` 的校验，否则迁移链路就断了。字段名与语义逐项对应。
 */

const TYPES = {
  profile:     { label: '身份事实', ttl: 730, importance: 0.70, bodyLimit: 600 },
  preference:  { label: '偏好约定', ttl: 365, importance: 0.60, bodyLimit: 600 },
  environment: { label: '环境事实', ttl: 180, importance: 0.85, bodyLimit: 800 },
  project:     { label: '进行中工作', ttl: 120, importance: 0.85, bodyLimit: 1200 },
  procedure:   { label: '操作规程', ttl: 365, importance: 0.80, bodyLimit: 1400 },
  lesson:      { label: '经验教训', ttl: 540, importance: 0.75, bodyLimit: 1200 },
  decision:    { label: '决策记录', ttl: 365, importance: 0.90, bodyLimit: 1200 },
  episode:     { label: '事件记录', ttl: 90,  importance: 0.40, bodyLimit: 900 },
};

const TYPE_ORDER = Object.keys(TYPES);

const STATUSES = ['active', 'superseded', 'expired', 'disputed', 'archived'];

const LINK_RELATIONS = [
  'extends', 'supports', 'contradicts', 'refines',
  'supersedes', 'derived_from', 'example_of',
];

const KEY_ORDER = [
  'id', 'type', 'title', 'subject', 'predicate', 'value', 'status',
  'confidence', 'importance', 'valid_from', 'valid_to', 'recorded_at',
  'ended_at', 'source', 'links', 'tags', 'aliases', 'hits', 'last_hit',
  'supersedes', 'superseded_by', 'review_after', 'schema',
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function stamp() {
  return new Date().toISOString().slice(0, 16);
}

function slugify(text, limit = 40) {
  const s = String(text || '').trim().toLowerCase();
  const ascii = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, limit).replace(/-+$/, '') || 'note';
  // CJK 等非拉丁文字：用稳定的短哈希保证文件名可重复生成
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 8);
}

/**
 * 从 subject + value 生成内容摘要，用于识别重复。
 * 与 Python 侧 digest 逻辑一致（slot + 归一化 value）。
 */
function digestOf(card) {
  const slot = `${String(card.subject || '').trim().toLowerCase()}::${String(card.predicate || '').trim().toLowerCase()}`;
  const basis = `${slot}|${String(card.value || '').trim().toLowerCase()}|${String(card.body || '').trim()}`;
  let h1 = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h1 ^= basis.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0');
}

/**
 * 规范化 LLM 返回的卡片：补全字段、修正类型、裁剪越界值。
 * LLM 输出不可完全信任，但也不能因为小瑕疵就丢弃有效信息。
 */
function normalizeCard(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const type = TYPE_ORDER.includes(raw.type) ? raw.type : null;
  if (!type) return null;

  const subject = String(raw.subject || '').trim().replace(/\s+/g, '-').slice(0, 80);
  const predicate = String(raw.predicate || '').trim().replace(/\s+/g, '_').slice(0, 80);
  if (!subject || !predicate) return null;

  const value = String(raw.value || raw.title || '').trim().slice(0, 300);
  const title = String(raw.title || value).trim().slice(0, 120);
  if (!value) return null;

  const meta = TYPES[type];
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };

  let body = String(raw.body || '').trim();
  if (body.length > meta.bodyLimit) {
    body = body.slice(0, meta.bodyLimit - 20) + '\n[内容超长已截断]';
  }

  const arr = (v) =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];

  const links = arr(raw.links)
    .filter((l) => l.includes(':') && LINK_RELATIONS.includes(l.split(':')[0]))
    .slice(0, 8);

  const card = {
    type,
    title,
    subject,
    predicate,
    value,
    status: STATUSES.includes(raw.status) ? raw.status : 'active',
    confidence: clamp(raw.confidence, 0, 1, 0.8),
    importance: clamp(raw.importance, 0, 1, meta.importance),
    valid_from: /^\d{4}-\d{2}-\d{2}$/.test(raw.valid_from) ? raw.valid_from : today(),
    valid_to: /^\d{4}-\d{2}-\d{2}$/.test(raw.valid_to) ? raw.valid_to : '',
    recorded_at: stamp(),
    ended_at: '',
    source: String(raw.source || ctx.source || 'forge:import').slice(0, 120),
    links,
    tags: arr(raw.tags),
    aliases: arr(raw.aliases || raw.alias),
    hits: 0,
    last_hit: '',
    supersedes: arr(raw.supersedes),
    superseded_by: '',
    review_after: '',
    schema: 1,
    body,
    // 转换期元信息，不写入 frontmatter
    _digest: null,
    _provenance: ctx.provenance || [],
    _edited: false,
    _dropped: false,
  };

  card._digest = digestOf(card);
  return card;
}

/**
 * 与 palace card.py 的 validate() 对齐。
 */
function validateCard(card) {
  const problems = [];
  const required = ['type', 'title', 'subject', 'predicate', 'status'];
  for (const f of required) {
    if (!card[f] || !String(card[f]).trim()) problems.push(`缺少必填字段 ${f}`);
  }
  if (!TYPE_ORDER.includes(card.type)) problems.push(`未知类型 ${card.type}`);
  if (!STATUSES.includes(card.status)) problems.push(`未知状态 ${card.status}`);
  if (/\s/.test(card.subject || '')) problems.push('subject 不能含空格');
  if (/\s/.test(card.predicate || '')) problems.push('predicate 不能含空格');

  const limit = (TYPES[card.type] || TYPES.lesson).bodyLimit;
  if (String(card.body || '').length > limit) {
    problems.push(`正文超过 ${card.type} 上限 ${limit} 字符`);
  }
  if (!String(card.value || '').trim() && !String(card.body || '').trim()) {
    problems.push('value 与 body 不能同时为空');
  }
  if (card.confidence < 0 || card.confidence > 1) problems.push('confidence 需在 0..1');
  if (card.importance < 0 || card.importance > 1) problems.push('importance 需在 0..1');
  if (card.valid_from && card.valid_to && card.valid_to < card.valid_from) {
    problems.push('valid_to 早于 valid_from');
  }
  if (card.status === 'active' && card.valid_to) {
    problems.push('active 状态不应有 valid_to');
  }
  return problems;
}

/** 渲染为 palace 可直接读取的 Markdown 文件内容 */
function renderCard(card, id) {
  const order = KEY_ORDER;
  const data = { id, schema: 1 };
  for (const k of order) {
    if (k === 'id' || k === 'schema') continue;
    data[k] = card[k];
  }
  data.id = id;
  data.schema = 1;

  const lines = ['---'];
  for (const k of order) {
    const v = data[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => (typeof x === 'string' && /[,:[\]{}#]/.test(x) ? JSON.stringify(x) : x)).join(', ')}]`);
    } else if (typeof v === 'boolean') {
      lines.push(`${k}: ${v ? 'true' : 'false'}`);
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else {
      const s = String(v);
      if (s === '') { lines.push(`${k}: ""`); continue; }
      const needsQuote = /^[\s>|&*!%@`#-]|[:#]\s|[\n"]|^$|^(true|false|null|yes|no|on|off)$/i.test(s);
      lines.push(`${k}: ${needsQuote ? JSON.stringify(s) : s}`);
    }
  }
  lines.push('---', '');
  lines.push(String(card.body || '').trim() || card.value);
  lines.push('');
  return lines.join('\n');
}

/** 导出的文件名，与 store.card_path() 一致 */
function cardFileName(id, title) {
  return `${id}-${slugify(title)}.md`;
}

module.exports = {
  TYPES, TYPE_ORDER, STATUSES, LINK_RELATIONS, KEY_ORDER,
  normalizeCard, validateCard, renderCard, cardFileName,
  digestOf, slugify, today, stamp,
};
