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

  // YAML / TOML：顶层 key: 占比高 + 有缩进
  const ymlLines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (ymlLines.length >= 3) {
    const topKeys = ymlLines.filter((l) => /^[a-zA-Z_][\w.\-]*\s*:/.test(l)).length;
    const indented = ymlLines.filter((l) => /^\s{2,}/.test(l)).length;
    if (topKeys >= 2 && indented / ymlLines.length > 0.2) return 'yaml';
  }

  // CSV / TSV：分隔符数量在多行间稳定
  if (ymlLines.length >= 2) {
    const first = ymlLines[0];
    const delim = [',', '\t', ';'].map((d) => ({
      d, n: (first.match(new RegExp(`\\${d}`, 'g')) || []).length,
    })).sort((a, b) => b.n - a.n)[0];
    if (delim && delim.n >= 2) {
      const consistent = ymlLines.slice(0, 10)
        .every((l) => (l.match(new RegExp(`\\${delim.d}`, 'g')) || []).length === delim.n);
      if (consistent) return 'csv';
    }
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
/**
 * 递归收集嵌套结构里的字符串叶子。
 * @param {object} node       待遍历节点
 * @param {Set<string>} skip  顶层已取过的键，不重复收集
 * @param {number} depth
 */
function collectStrings(node, skip, depth, prefix = '') {
  if (depth > 5 || node === null || node === undefined) return '';
  if (Array.isArray(node)) {
    return node
      .map((item) => collectStrings(item, skip, depth + 1, prefix))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof node !== 'object') return '';

  const parts = [];
  Object.entries(node).forEach(([k, v]) => {
    if (!prefix && skip.has(k)) return;
    const label = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      if (v.trim()) parts.push(`${label}: ${v}`);
    } else if (v && typeof v === 'object') {
      const sub = collectStrings(v, skip, depth + 1, label);
      if (sub) parts.push(sub);
    }
  });
  return parts.join('\n');
}

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
        // 嵌套结构里的字符串同样不能丢（Codex 会话的 content[].text）
        const nested = collectStrings(node, new Set(strVals), 0);
        const others = keys.filter((k) => !(typeof node[k] === 'string' && node[k].trim()));
        const extra = others
          .map((k) => `${k}: ${fmt(node[k])}`)
          .filter((s) => !s.endsWith(': {}') && !s.endsWith(': []') && !s.endsWith(': null'))
          .join('\n');
        records.push(
          makeRecord(rendered + (nested ? `\n${nested}` : '') + (extra ? `\n${extra}` : ''), pointer, {
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
      // 递归收集所有字符串叶子，而不是只取顶层字段。
      // Codex/Claude 会话的内容常藏在 content[].text 这类嵌套结构里，
      // 只取顶层会把真正有意义的内容丢掉。
      const strVals = [];
      (function collect(node, prefix, depth) {
        if (depth > 6 || node === null || node === undefined) return;
        if (typeof node === 'string') {
          if (node.trim()) strVals.push(prefix ? `${prefix}: ${node}` : node);
          return;
        }
        if (typeof node === 'number' || typeof node === 'boolean') return;  // 噪音字段
        if (Array.isArray(node)) {
          node.forEach((item) => collect(item, prefix, depth + 1));
          return;
        }
        if (typeof node === 'object') {
          Object.entries(node).forEach(([k, v]) => {
            collect(v, prefix ? `${prefix}.${k}` : k, depth + 1);
          });
        }
      })(obj, '', 0);

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
      case 'yaml':
        // 兜底：按顶层键切。不做完整 YAML 解析（避免引入依赖），
        // 需要精确处理缩进层级时应走 forge probe 的配方切分。
        records = splitYamlFallback(text);
        break;
      case 'csv':
        records = splitCsvFallback(text);
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

// --- YAML / CSV 兜底 ---------------------------------------------------
// 这两个是「不探查时也别完全失效」的保底实现，能力弱于配方切分
// （配方能按 agent 声明的字段映射渲染）。需要精确处理时请用 forge probe。

function splitYamlFallback(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let buf = [];
  let key = '';
  let start = 1;
  const flush = (end) => {
    if (buf.join('\n').trim()) {
      records.push(makeRecord(buf.join('\n'), `L${start}-${end}`, {
        kind: 'yaml-section', section: key,
      }));
    }
    buf = [];
  };
  lines.forEach((l, i) => {
    const isTop = /^[a-zA-Z_][\w.\-]*\s*:/.test(l) || /^\[[^\]]+\]/.test(l);
    if (isTop) {
      if (buf.length) flush(i);
      key = l.replace(/[:\s]/g, ' ').trim().slice(0, 60);
      start = i + 1;
    }
    if (!buf.length && !isTop) start = i + 1;
    buf.push(l);
  });
  flush(lines.length);
  return records;
}

function splitCsvFallback(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const counts = [',', '\t', ';', '|'].map((d) => ({
    d, n: (lines[0].match(new RegExp(`\\${d}`, 'g')) || []).length,
  })).sort((a, b) => b.n - a.n)[0];
  if (!counts || counts.n < 1) return splitText(text);

  const parseLine = (line) => {
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === counts.d && !inQuote) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };

  const header = parseLine(lines[0]);
  const records = [];
  lines.slice(1).forEach((line, i) => {
    const cells = parseLine(line);
    const parts = [];
    header.forEach((h, j) => { if (h && cells[j]) parts.push(`${h}: ${cells[j]}`); });
    cells.slice(header.length).forEach((v, j) => { if (v) parts.push(`col${header.length + j + 1}: ${v}`); });
    records.push(makeRecord(parts.join('\n'), `row ${i + 2}`, { kind: 'csv-row' }));
  });
  return records;
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
