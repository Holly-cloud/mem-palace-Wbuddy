'use strict';
/**
 * 配方驱动的切分执行器。
 *
 * agent 给出声明式配方，这里负责**执行**。
 * 分开的原因很实际：agent 不该直接产文本（会有幻觉、不可复现），
 * 只该产「怎么切」的声明；真正的字符串操作交给确定性代码。
 *
 * 这样切分结果可复现、可审计，agent 判断错时也能靠改配方纠正，
 * 而不用重跑任何模型。
 */

const fs = require('fs');
const path = require('path');

const { pickPath } = require('./probe');

function makeRecord(text, locator, extra = {}) {
  const body = (text || '').trim();
  return {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    text: body,
    locator,
    chars: body.length,
    ...extra,
  };
}

/**
 * 按字段映射把一个对象渲染成可读文本。
 *
 * 例如配方 { role: 'role', content: 'content[].text' } 作用于
 * { role:'user', content:[{text:'你好'}] } 会渲染成：
 *
 *     角色: user
 *     内容: 你好
 *
 * 保留标签名是为了让抽取阶段的 agent 知道每句话是谁说的 ——
 * 这在对话记录里是判断「哪句是用户真实意图」的关键。
 */
function renderObject(obj, recipe) {
  const parts = [];
  const fields = recipe.fields || defaultFieldsFor(recipe.strategy);

  Object.entries(fields).forEach(([label, jsonPath]) => {
    const val = pickPath(obj, jsonPath);
    if (val === null || val === undefined || val === '') return;
    parts.push(`${label}: ${val}`);
  });

  (recipe.includeMeta || []).forEach((key) => {
    const val = pickPath(obj, key);
    if (val !== null && val !== undefined && val !== '') {
      parts.push(`${key}: ${val}`);
    }
  });

  return parts.join('\n');
}

/** 各策略的默认字段映射 */
function defaultFieldsFor(strategy) {
  const M = {
    jsonl: { 角色: 'role', 内容: 'content[].text' },
    json_array: { 角色: 'role', 内容: 'content' },
    conversation: { 内容: 'content' },
    csv: {},
  };
  return M[strategy] || {};
}

// --- 各策略的切分实现 ---------------------------------------------------

function splitByLines(text) {
  return text.split(/\r?\n/)
    .map((l, i) => ({ l, n: i + 1 }))
    .filter((x) => x.l.trim())
    .map((x) => makeRecord(x.l, `L${x.n}`, { kind: 'probe-lines' }));
}

function splitJsonl(text, recipe) {
  const records = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const obj = JSON.parse(t);
      const rendered = renderObject(obj, recipe);
      if (rendered) {
        records.push(makeRecord(rendered, `L${i + 1}`, {
          kind: 'probe-jsonl', _raw: obj,
        }));
      }
    } catch (_) {
      // 不是合法 JSON 行，原样保留（可能本来就是混排的日志）
      records.push(makeRecord(t, `L${i + 1}`, { kind: 'probe-jsonl-invalid' }));
    }
  });
  return records;
}

function splitJsonArray(text, recipe) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return [makeRecord(text.slice(0, 4000), 'whole-file', {
      kind: 'probe-whole', error: `JSON 解析失败：${err.message}`,
    })];
  }
  if (!Array.isArray(data)) {
    // 顶层不是数组 —— 按对象处理
    return [makeRecord(renderObject(data, recipe), 'root', { kind: 'probe-object', _raw: data })];
  }
  const records = [];
  data.forEach((item, i) => {
    if (item === null || typeof item !== 'object') {
      if (item !== undefined && item !== null) {
        records.push(makeRecord(String(item), `[${i}]`, { kind: 'probe-scalar' }));
      }
      return;
    }
    const rendered = renderObject(item, recipe);
    if (rendered) {
      records.push(makeRecord(rendered, `[${i}]`, { kind: 'probe-json-array', _raw: item }));
    }
  });
  return records;
}

/** 对话记录：把连续同角色的内容合并，保留角色边界 */
function splitConversation(text, recipe) {
  const markers = (recipe.separator || 'User:|Assistant:|用户:|助手:|Human:|AI:')
    .split('|').map((s) => s.trim()).filter(Boolean);
  const re = new RegExp(`^(${markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[:：]?\\s*`, 'i');

  const lines = text.split(/\r?\n/);
  const records = [];
  let cur = null;
  let startLine = 1;

  const flush = (endLine) => {
    if (cur && cur.parts.join(' ').trim()) {
      const body = cur.parts.join('\n').trim();
      if (body) {
        records.push(makeRecord(`${cur.speaker}:\n${body}`, `L${startLine}-${endLine}`, {
          kind: 'probe-conversation', speaker: cur.speaker,
        }));
      }
    }
    cur = null;
  };

  lines.forEach((line, i) => {
    const m = re.exec(line.trim());
    if (m) {
      if (cur) flush(i);
      cur = { speaker: m[1], parts: [line.trim().slice(m[0].length)] };
      startLine = i + 1;
    } else if (cur) {
      cur.parts.push(line);
    } else if (line.trim()) {
      // 角色标记之前的内容 —— 作为独立记录
      cur = { speaker: '(未标注)', parts: [line] };
      startLine = i + 1;
    }
  });
  flush(lines.length);
  return records;
}

function splitBySeparator(text, recipe) {
  const sep = recipe.separator || '\n---\n';
  const parts = text.split(sep);
  return parts
    .map((p, i) => makeRecord(p, `seg ${i + 1}`, { kind: 'probe-segment' }))
    .filter((r) => r.text);
}

function splitMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let buf = [];
  let heading = '';
  let start = 1;
  const flush = (end) => {
    if (buf.join('\n').trim()) {
      records.push(makeRecord(buf.join('\n'), `L${start}-${end}`, {
        kind: 'probe-markdown', section: heading,
      }));
    }
    buf = [];
  };
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m && m[1].length <= 3) {
      if (buf.length) flush(i);
      heading = m[2].trim();
      start = i + 1;
      buf.push(l);
      return;
    }
    if (!buf.length) start = i + 1;
    buf.push(l);
  });
  flush(lines.length);
  return records;
}

/**
 * YAML / TOML：按顶层键切分。
 * 不做完整 YAML 解析（那需要依赖），但顶层键的切分对配置文件足够。
 */
function splitYaml(text) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let buf = [];
  let key = '';
  let start = 1;

  const flush = (end) => {
    if (buf.join('\n').trim()) {
      records.push(makeRecord(buf.join('\n'), `L${start}-${end}`, {
        kind: 'probe-yaml', section: key,
      }));
    }
    buf = [];
  };

  lines.forEach((l, i) => {
    // 顶层键：非缩进、非注释、形如 key: 或 [section]
    const isTopKey = /^[a-zA-Z_][\w.\-]*\s*:/.test(l) || /^\[[^\]]+\]/.test(l);
    if (isTopKey) {
      if (buf.length) flush(i);
      key = l.replace(/[:\s]/g, ' ').trim().slice(0, 60);
      start = i + 1;
    }
    if (!buf.length && !isTopKey) start = i + 1;
    buf.push(l);
  });
  flush(lines.length);
  return records;
}

/** CSV / TSV：首行做表头，每行一条记录 */
function splitCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const delim = pickDelimiter(lines[0]);
  const parseLine = (line) => {
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === delim && !inQuote) {
        cells.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  };

  // 表头只作字段名来源，不产出记录 —— 它不是数据，
  // 让抽取阶段看到反而会多抽出一条「表头是 xxx」的无用记忆。
  const header = parseLine(lines[0]);
  const records = [];

  lines.slice(1).forEach((line, i) => {
    const cells = parseLine(line);
    const parts = [];
    header.forEach((h, j) => {
      if (h && cells[j]) parts.push(`${h}: ${cells[j]}`);
    });
    // 未映射到表头的额外列也带上，避免丢信息
    cells.slice(header.length).forEach((v, j) => {
      if (v) parts.push(`col${header.length + j + 1}: ${v}`);
    });
    records.push(makeRecord(parts.join('\n'), `row ${i + 2}`, { kind: 'probe-csv-row' }));
  });

  return records;
}

function pickDelimiter(line) {
  const counts = {
    ',': (line.match(/,/g) || []).length,
    '\t': (line.match(/\t/g) || []).length,
    ';': (line.match(/;/g) || []).length,
    '|': (line.match(/\|/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function splitLog(text) {
  const stampRe = /^\s*[\[\(]?(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}|\d{4}[-/]\d{2}[-/]\d{2}|\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/;
  const lines = text.split(/\r?\n/);
  const records = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      const body = cur.lines.join('\n').trim();
      if (body) {
        records.push(makeRecord(body, `L${cur.start}-${cur.start + cur.lines.length - 1}`, {
          kind: 'probe-log', timestamp: cur.time,
        }));
      }
      cur = null;
    }
  };
  lines.forEach((l, i) => {
    const m = stampRe.exec(l);
    if (m) {
      flush();
      cur = { time: m[1], lines: [l], start: i + 1 };
    } else if (cur) {
      cur.lines.push(l);
    } else if (l.trim()) {
      cur = { time: '', lines: [l], start: i + 1 };
    }
  });
  flush();
  return records;
}

function splitBlankLine(text) {
  const blocks = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return blocks.map((b, i) => makeRecord(b, `block ${i + 1}`, { kind: 'probe-block' }));
}

// --- 主入口 -------------------------------------------------------------

/**
 * 按配方切分文件。
 *
 * @param {string} filePath  文件路径
 * @param {object} recipe    配方（来自 probe.js 的校验）
 * @returns {{records: Array, strategy: string, warnings: string[]}}
 */
function splitByRecipe(filePath, recipe) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      records: [], strategy: recipe.strategy,
      warnings: [`读取失败：${err.message}`],
    };
  }

  const warnings = [];
  let records = [];

  try {
    switch (recipe.strategy) {
      case 'lines':
        records = splitByLines(text);
        break;
      case 'jsonl':
        records = splitJsonl(text, recipe);
        break;
      case 'json_array':
        records = splitJsonArray(text, recipe);
        break;
      case 'conversation':
        records = splitConversation(text, recipe);
        break;
      case 'record_separator':
        records = splitBySeparator(text, recipe);
        break;
      case 'markdown':
        records = splitMarkdown(text);
        break;
      case 'yaml':
        records = splitYaml(text);
        break;
      case 'csv':
        records = splitCsv(text);
        break;
      case 'log':
        records = splitLog(text);
        break;
      case 'blank_line':
        records = splitBlankLine(text);
        break;
      case 'whole':
        records = [makeRecord(text, 'whole-file', { kind: 'probe-whole' })];
        break;
      default:
        warnings.push(`未知策略 ${recipe.strategy}，退回整文件处理`);
        records = [makeRecord(text, 'whole-file', { kind: 'probe-whole' })];
    }
  } catch (err) {
    warnings.push(`切分异常（${err.message}），已退回整文件处理`);
    records = [makeRecord(text.slice(0, 8000), 'whole-file', { kind: 'probe-whole' })];
  }

  // 清理空记录
  records = records.filter((r) => r.text && r.text.length > 0);

  if (records.length === 0) {
    warnings.push('配方切出 0 条记录，请检查配方是否合适');
  }

  // 抽掉明显是噪音的记录（纯时间戳、纯标点）
  const before = records.length;
  records = records.filter((r) => {
    const t = r.text.replace(/[\s\p{P}]/gu, '');
    return t.length > 0;
  });
  if (records.length < before) {
    warnings.push(`过滤了 ${before - records.length} 条空白/纯标点记录`);
  }

  return { records, strategy: recipe.strategy, warnings };
}

/**
 * 批量：探查配方 + 切分 + 分块，一步到位。
 *
 * @param {Array<{path:string,name:string}>} fileEntries  manifest.files
 * @param {object} loadResult  loadRecipes() 的返回值
 */
function buildChunksFromRecipes(fileEntries, loadResult, { budget = 6000 } = {}) {
  const parser = require('./parser');
  const chunks = [];
  const perFile = [];

  loadResult.recipes.forEach((entry) => {
    const res = splitByRecipe(entry.path, entry.recipe);
    const fileChunks = parser.chunkRecords(res.records, { budget });
    fileChunks.forEach((c) => {
      // ★ 必须重编全局索引：chunkRecords 对每个文件独立调用，
      // 产生的 index 都从 0 开始。若不重编，两个文件的 chunk 0 会撞车 ——
      // agent 写 index=0 的结果会覆盖掉另一个文件的 chunk 0，数据静默丢失。
      c.index = chunks.length;
      c._sourceFile = entry.name;
      c._sourcePath = entry.path;
      c._strategy = entry.recipe.strategy;
      chunks.push(c);
    });
    perFile.push({
      name: entry.name,
      strategy: entry.recipe.strategy,
      recordCount: res.records.length,
      chunkCount: fileChunks.length,
      warnings: res.warnings,
      note: entry.recipe.note || '',
    });
  });

  // 未提交配方的文件 —— 退回规则解析，避免丢数据
  const missingPaths = loadResult.missing.map((m) => m.path);
  const fallbackFiles = [];
  missingPaths.forEach((p) => {
    const entry = fileEntries.find((f) => f.path === p);
    if (entry) fallbackFiles.push(entry);
  });
  if (fallbackFiles.length) {
    const chunksFallback = buildFallbackChunks(fallbackFiles, budget);
    chunks.push(...chunksFallback.chunks);
    perFile.push(...chunksFallback.perFile);
  }

  return { chunks, perFile };
}

/** 未探查文件的兜底：走规则解析器 */
function buildFallbackChunks(fileEntries, budget) {
  const parser = require('./parser');
  const chunks = [];
  const perFile = [];
  fileEntries.forEach((entry) => {
    try {
      const text = fs.readFileSync(entry.path, 'utf8');
      const parsed = parser.parseContent(entry.path, text);
      const cs = parser.chunkRecords(parsed.records, { budget });
      cs.forEach((c) => {
        c.index = chunks.length;   // 全局重编，理由同上
        c._sourceFile = entry.name;
        c._sourcePath = entry.path;
        c._strategy = `fallback:${parsed.format}`;
        chunks.push(c);
      });
      perFile.push({
        name: entry.name,
        strategy: `fallback:${parsed.format}`,
        recordCount: parsed.stats.recordCount,
        chunkCount: cs.length,
        warnings: ['未提交探查配方，已用规则解析器兜底'],
        note: '',
      });
    } catch (err) {
      perFile.push({
        name: entry.name,
        strategy: 'failed',
        recordCount: 0,
        chunkCount: 0,
        warnings: [`读取失败：${err.message}`],
        note: '',
      });
    }
  });
  return { chunks, perFile };
}

module.exports = {
  splitByRecipe,
  splitJsonl,
  splitJsonArray,
  splitConversation,
  splitCsv,
  splitYaml,
  splitLog,
  renderObject,
  buildChunksFromRecipes,
  buildFallbackChunks,
  pickDelimiter,
};
