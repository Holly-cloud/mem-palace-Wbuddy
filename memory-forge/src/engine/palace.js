'use strict';
/**
 * 读取已有的 memory-palace 卡片目录，用于导入前的冲突对比。
 *
 * 刻意不依赖 Python 版代码：这个解析器只需识别固定的 frontmatter 结构，
 * 保持 Node 侧零依赖，且万一字段有偏差也能给出明确告警而不是静默出错。
 */

const fs = require('fs');
const path = require('path');

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '') return null;
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  const low = s.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (low === 'null' || low === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => parseScalar(p)).filter((x) => x !== null && x !== '');
  }
  return s;
}

function parseFrontmatter(text) {
  if (!text) return null;
  // 容错：Agent 手写时偶尔会把分隔符转义成 \---（Markdown 渲染习惯），
  // 或者用全角/带空格的形式。严格匹配会让整张卡读不出来 ——
  // 数据明明完好，却因为首行一个字符读不出来，这是最坏的一类失败。
  // 这里只要求「一行里只有分隔符（可带转义反斜杠与空白）」。
  if (!/^[ \t]*\\?---[ \t]*$/.test(text.split(/\r?\n/, 1)[0])) return null;

  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^[ \t]*\\?---[ \t]*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return null;

  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    data[key] = parseScalar(val);
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() };
}

/**
 * 扫描目录，返回卡片数组与问题清单。
 */
function loadPalace(rootDir) {
  const cards = [];
  const problems = [];
  const ids = new Set();
  let maxSeq = 0;

  if (!fs.existsSync(rootDir)) {
    return { cards, ids, maxSeq, problems: [{ file: rootDir, problem: '目录不存在' }], found: false };
  }

  const walk = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      problems.push({ file: dir, problem: `读取失败: ${err.message}` });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.palace', '.git', 'node_modules', '__pycache__'].includes(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'README.md') continue;
      // 只检查 cards/ 下的 .md。库根目录里 agent 常放收录清单、
      // 报告之类的辅助文档 —— 它们不是记忆卡，缺 frontmatter 是正常的，
      // 报进 problems 只会淹没真正的问题。
      if (depth === 0) continue;

      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (err) {
        problems.push({ file: full, problem: `读取失败: ${err.message}` });
        continue;
      }

      const parsed = parseFrontmatter(text);
      if (!parsed || !parsed.data.id) {
        problems.push({ file: path.relative(rootDir, full), problem: '缺少 frontmatter 或 id 字段' });
        continue;
      }

      const d = parsed.data;
      if (ids.has(d.id)) {
        problems.push({ file: path.relative(rootDir, full), problem: `ID 重复: ${d.id}` });
      }
      ids.add(d.id);

      const m = /^mem_(\d+)/.exec(String(d.id));
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));

      cards.push({
        id: String(d.id),
        type: String(d.type || ''),
        title: String(d.title || ''),
        subject: String(d.subject || ''),
        predicate: String(d.predicate || ''),
        value: String(d.value || ''),
        status: String(d.status || 'active'),
        confidence: Number(d.confidence ?? 0.8),
        importance: Number(d.importance ?? 0.6),
        valid_from: String(d.valid_from ?? ''),
        valid_to: String(d.valid_to ?? ''),
        recorded_at: String(d.recorded_at || ''),
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
        aliases: Array.isArray(d.aliases) ? d.aliases.map(String) : [],
        hits: Number(d.hits ?? 0),
        path: path.relative(rootDir, full),
        body: parsed.body,
      });
    }
  };

  walk(rootDir);
  return { cards, ids, maxSeq, problems, found: true };
}

/** 已有记忆的 slot 清单，用于提示 LLM 避免重复抽取 */
function slotList(cards, limit = 80) {
  const seen = new Map();
  for (const c of cards) {
    if (c.status !== 'active') continue;
    const slot = `${c.subject}::${c.predicate}`;
    if (!seen.has(slot)) seen.set(slot, `${slot} — ${c.title}`.slice(0, 100));
  }
  return [...seen.values()].slice(0, limit);
}

module.exports = { loadPalace, parseFrontmatter, slotList };
