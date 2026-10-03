'use strict';
/**
 * 格式解析与分块。
 *
 * 设计要点：任何来源格式最终都归一为 Record[]，每条记录保留
 * `locator`（文件+行号/路径）与 `context`（前后文），使抽取结果可追溯
 * 回原始文本。分块按字符预算切分，尽量不跨语义边界。
 */

const path = require('path');

const MAX_FILE_BYTES = 8 * 1024 * 1024;

// --- 格式识别 -----------------------------------------------------------

/**
 * 先按内容嗅探，再退回扩展名。日志与纯文本仅靠扩展名不可靠。
 */
function detectFormat(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  const head = text.slice(0, 4000).trim();

  // 扩展名最可信，优先采信明确的 JSON 系扩展名。
  // 注意：必须在日志嗅探之前 —— 否则 `[2026-01-01 ...]` 这类日志行首的方括号
  // 会被误当成 JSON 数组的开头。
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.json') {
    try {
      JSON.parse(text);
      return 'json';
    } catch (_) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const jsonish = lines.filter((l) => /^\s*[{]/.test(l)).length;
      if (lines.length >= 3 && jsonish / lines.length > 0.8) return 'jsonl';
      return 'json';
    }
  }
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.log') return 'log';

  // 日志特征：时间戳开头的行占比。放在 JSON 嗅探之前，
  // 因为日志行首的 `[` 会被 JSON 检测误判。
  const lines = text.split(/\r?\n/).slice(0, 40);
  const stamped = lines.filter((l) =>
    /^\s*[\[\(]?\d{4}[-/]\d{2}[-/]\d{2}[ T]/.test(l) ||
    /^\s*\d{2}:\d{2}:\d{2}/.test(l) ||
    /^\[(?:INFO|WARN|ERROR|DEBUG|TRACE)\]/i.test(l)
  ).length;
  if (lines.length >= 3 && stamped / lines.length > 0.4) return 'log';

  // 内容嗅探 JSON
  if (/^[{]/.test(head)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch (_) { /* 继续尝试 JSONL */ }
    const jl = text.split(/\r?\n/).filter((l) => l.trim());
    const jsonish = jl.filter((l) => /^\s*[{]/.test(l)).length;
    if (jl.length >= 3 && jsonish / jl.length > 0.8) return 'jsonl';
  }
  if (/^[[]/.test(head)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch (_) { /* 非 JSON 数组 */ }
  }

  return 'text';
}

// --- 记录切分 -----------------------------------------------------------

function makeRecord(text, locator, extra = {}) {
  const body = (text || '').trim();
  return {
    id: `r_${Math.random().toString(36).slice(2, 10)}`,
    text: body,
    locator,
    chars: body.length,
    ...extra,
  };
}

/**
 * Markdown：按标题层级切成块。优先用 h2/h3，缺失时退回 h1。
 */
function splitMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let buf = [];
  let startLine = 1;
  let heading = '';
  let headingLine = 0;

  const flush = (endLine) => {
    if (buf.join('\n').trim()) {
      records.push(
        makeRecord(buf.join('\n'), `L${startLine}-${endLine}`, {
          section: heading,
          headingLine,
          kind: 'markdown-section',
        })
      );
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    // h1/h2/h3 都作为切分点；更深层级留在块内
    const isSplit = m && m[1].length <= 3;
    if (isSplit) {
      if (buf.length) flush(i);
      heading = m[2].trim();
      headingLine = i + 1;
      startLine = i + 1;
      // 标题本身并入块内容，保留语义
      buf.push(lines[i]);
      continue;
    }
    if (buf.length === 0) startLine = i + 1;
    buf.push(lines[i]);
  }
  flush(lines.length);
  return records;
}

/**
 * 纯文本：空行分段。过短的段落与相邻段落合并，避免碎片化。
 */
function splitText(text, minChars = 120) {
  const blocks = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const records = [];
  let buf = [];

  // 超过上限的段落按句读切分，避免单个巨型块喂爆 LLM 上下文。
  // 没有空行分隔的长文件（如导出的会话记录）依赖这一步。
  const MAX_BLOCK = 4000;
  const expand = (block) => {
    if (block.length <= MAX_BLOCK) return [block];
    const parts = [];
    const sentences = block.split(/(?<=[。！？.!?;；\n])/);
    let cur = '';
    for (const s of sentences) {
      if ((cur + s).length > MAX_BLOCK && cur) {
        parts.push(cur.trim());
        cur = s;
      } else {
        cur += s;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  };

  const queue = blocks.flatMap(expand);

  for (const block of queue) {
    // 每段独立成记录：expand 已经保证了块大小可控，
    // 再按 minChars 累积会把语义无关的段落黏在一起。
    records.push(makeRecord(block, `block ${records.length + 1}`, { kind: 'text-block' }));
  }
  return records;
}

/**
 * 日志：按时间戳切分事件，同一事件的多行合并。
 */
function splitLog(text) {
  const lines = text.split(/\r?\n/);
  const stampRe =
    /^\s*[\[\(]?(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}|\d{4}[-/]\d{2}[-/]\d{2}|\d{2}:\d{2}:\d{2})/;
  const events = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    if (stampRe.test(lines[i])) {
      if (cur) { events.push(cur); cur = null; }
      cur = { time: stampRe.exec(lines[i])[1], lines: [lines[i]], start: i + 1 };
    } else if (cur) {
      cur.lines.push(lines[i]);
    } else if (lines[i].trim()) {
      // 首个时间戳之前的内容作为 preamble
      cur = { time: '', lines: [lines[i]], start: i + 1 };
    }
  }
  if (cur) events.push(cur);

  return events
    .map((e, idx) =>
      makeRecord(e.lines.join('\n').trim(), `L${e.start}-${e.start + e.lines.length - 1}`, {
        kind: 'log-event',
        timestamp: e.time,
        seq: idx,
      })
    )
    .filter((r) => r.text);
}

/**
 * 把任意 JSON 值转为可读文本，并保留结构线索。
 * 不会盲目 stringify —— 那会让 LLM 读到一大坨无结构的字符。
 */
function jsonToRecords(data, filePath) {
  const records = [];
  const base = path.basename(filePath);

  const walk = (node, pointer, depth) => {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${pointer}[${i}]`, depth));
      return;
    }

    if (typeof node === 'object') {
      const keys = Object.keys(node);

      // 叶子型记录判断：含至少一个非空字符串值，且字符串占多数字段。
      // depth 不作限制 —— 数组元素的顶层对象同样应作为一条记录，
      // 否则 {title, content} 这种会被拆成两个孤立字符串。
      const strVals = keys.filter((k) => typeof node[k] === 'string' && node[k].trim());
      if (strVals.length >= 1 && strVals.length >= keys.length * 0.5) {
        const rendered = strVals.map((k) => `${k}: ${node[k]}`).join('\n');
        const others = keys.filter((k) => !(typeof node[k] === 'string' && node[k].trim()));
        const extra = others
          .map((k) => `${k}: ${fmt(node[k])}`)
          .filter((s) => !s.endsWith(': {}') && !s.endsWith(': []') && !s.endsWith(': null'))
          .join('\n');
        records.push(
          makeRecord(rendered + (extra ? `\n${extra}` : ''), pointer, {
            kind: 'json-object',
            keys: strVals,
          })
        );
        return;
      }
      // 容器型：继续下探
      keys.forEach((k) => walk(node[k], `${pointer}.${k}`, depth + 1));
      return;
    }

    if (typeof node === 'string' && node.trim()) {
      records.push(makeRecord(node, pointer, { kind: 'json-string' }));
    }
  };

  const fmt = (v) => {
    if (Array.isArray(v)) return `[${v.length} items]`;
    if (v && typeof v === 'object') return '{...}';
    return String(v);
  };

  walk(data, base, 0);
  return records;
}

function parseJsonl(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  let ok = 0;
  let bad = 0;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const obj = JSON.parse(t);
      ok++;
      const strVals = Object.entries(obj)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => `${k}: ${v}`);
      records.push(
        makeRecord(
          strVals.length ? strVals.join('\n') : JSON.stringify(obj),
          `line ${i + 1}`,
          { kind: 'jsonl-line' }
        )
      );
    } catch (_) {
      bad++;
      if (bad <= 3) {
        records.push(makeRecord(line, `line ${i + 1}`, { kind: 'jsonl-invalid' }));
      }
    }
  });
  if (bad > 0) {
    records.push(
      makeRecord(`[提示] 共 ${ok} 条解析成功，${bad} 条 JSON 非法（仅保留前 3 条原文）`, 'summary', {
        kind: 'meta-note',
      })
    );
  }
  return records;
}

// --- 统一入口 -----------------------------------------------------------

function parseContent(filePath, text) {
  if (text.length > MAX_FILE_BYTES) {
    text = text.slice(0, MAX_FILE_BYTES);
  }
  const format = detectFormat(filePath, text);
  let records = [];

  try {
    switch (format) {
      case 'markdown':
        records = splitMarkdown(text);
        break;
      case 'log':
        records = splitLog(text);
        break;
      case 'json':
        records = jsonToRecords(JSON.parse(text), filePath);
        break;
      case 'jsonl':
        records = parseJsonl(text);
        break;
      default:
        records = splitText(text);
    }
  } catch (err) {
    // 解析失败不静默降级为纯文本，明确记录原因后回退
    records = [
      makeRecord(`[解析失败：${err.message}]\n\n${text.slice(0, 2000)}`, 'fallback', {
        kind: 'parse-error',
      }),
    ];
    records[0].error = err.message;
  }

  if (records.length === 0 && text.trim()) {
    records = [makeRecord(text.slice(0, 4000), 'whole-file', { kind: 'text-whole' })];
  }

  // 每个文件加一个头部记录，帮助 LLM 理解文件的整体性质
  const header = makeRecord(
    `来源文件: ${path.basename(filePath)}\n格式: ${format}\n共切分 ${records.length} 个片段`,
    'file-header',
    { kind: 'file-meta' }
  );

  return {
    format,
    records: [header, ...records],
    stats: {
      chars: text.length,
      lines: text.split(/\r?\n/).length,
      recordCount: records.length,
      avgRecordChars: records.length
        ? Math.round(records.reduce((s, r) => s + r.chars, 0) / records.length)
        : 0,
    },
  };
}

// --- 分块 ---------------------------------------------------------------

/**
 * 按字符预算把记录打包成块。预算用于控制单次 LLM 调用的输入规模。
 * 尽量整块打包（保留语义完整性），单条超预算则独立成块并切窗。
 *
 * 防御性约束：budget 至少为 1，否则切窗步长为 0 会导致死循环。
 */
function chunkRecords(records, { budget = 6000, maxRecordsPerChunk = 40 } = {}) {
  const safeBudget = Math.max(64, Number(budget) || 6000);
  const safeMaxRecords = Math.max(1, Number(maxRecordsPerChunk) || 40);
  const chunks = [];
  let cur = [];
  let curChars = 0;

  const pushChunk = (recs, chars) => {
    chunks.push({
      index: chunks.length,
      records: recs,
      chars,
      recordCount: recs.length,
      text: renderRecords(recs),
    });
  };

  const flush = () => {
    if (cur.length) {
      pushChunk(cur, curChars);
      cur = [];
      curChars = 0;
    }
  };

  for (const rec of records) {
    // 文件元信息单独成块，避免污染抽取上下文
    if (rec.kind === 'file-meta') {
      flush();
      pushChunk([rec], rec.chars);
      continue;
    }

    const would = curChars + rec.chars + 2;
    if (cur.length && (would > safeBudget || cur.length >= safeMaxRecords)) flush();

    if (rec.chars > safeBudget) {
      // 超长记录：切窗，保留前后标识
      flush();
      sliceLong(rec, safeBudget).forEach((s) => pushChunk([s], s.chars));
      continue;
    }

    cur.push(rec);
    curChars += rec.chars + 2;
  }
  flush();
  return chunks;
}

/** 渲染记录为带定位标签的文本 */
function renderRecords(records) {
  return records
    .map((r) => `<record id="${r.id}" loc="${r.locator}">\n${r.text}\n</record>`)
    .join('\n\n');
}

function sliceLong(rec, budget) {
  const out = [];
  // 下限保护：步长必须为正，否则 while 永不推进。budget 已在
  // chunkRecords 中保证 >= 64，这里的 1 是最后一道防线。
  const step = Math.max(1, Math.floor(budget * 0.85));
  const total = rec.text.length;
  const totalParts = Math.ceil(total / step);
  for (let i = 0; i < total; i += step) {
    const piece = rec.text.slice(i, i + step);
    out.push(
      makeRecord(piece, `${rec.locator} (part ${Math.floor(i / step) + 1}/${totalParts})`, {
        kind: `${rec.kind}-part`,
        section: rec.section,
        truncated: true,
      })
    );
  }
  return out.length ? out : [rec];
}

/**
 * 把一块渲染成送给 LLM 的文本，保留定位信息以便回溯。
 */
function renderChunk(chunk, { maxChars = 60000 } = {}) {
  const lines = chunk.records.map(
    (r) => `<record id="${r.id}" loc="${r.locator}">\n${r.text}\n</record>`
  );
  let text = lines.join('\n\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n\n[内容超长，已截断]';
  }
  return text;
}

module.exports = {
  detectFormat,
  parseContent,
  chunkRecords,
  renderChunk,
  splitMarkdown,
  splitText,
  splitLog,
  jsonToRecords,
  parseJsonl,
  MAX_FILE_BYTES,
};
