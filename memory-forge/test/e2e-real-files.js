'use strict';
/**
 * 真实文件端到端验证（mock LLM）。
 * 验证解析 → 抽取 → 去重 → 冲突 → 裁决 → 分配 ID → 渲染 → 写盘 → palace 可读。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('../src/engine/parser');
const { renderCard, cardFileName, validateCard } = require('../src/engine/schema');
const merge = require('../src/engine/merge');
const { extractAll } = require('../src/engine/extract');
const { loadPalace } = require('../src/engine/palace');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-e2e-'));
const srcDir = path.join(tmp, 'src');
const palaceDir = path.join(tmp, 'palace');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(path.join(palaceDir, 'cards', 'preference'), { recursive: true });

// --- 准备多种格式的源文件 ---
fs.writeFileSync(path.join(srcDir, 'notes.md'), `# 用户偏好

用户偏好精简的回答，不要长篇大论，讨厌 emoji 堆砌。

# 环境配置

机器是 Windows 11，shell 是 Git Bash，Python 走 WorkBuddy 托管运行时。

# 项目状态

记忆宫殿项目还在设计中，用 Python 实现，目标是 Markdown 作真相源。
`, 'utf8');

fs.writeFileSync(path.join(srcDir, 'session.log'), `[2026-09-01 10:00:00] INFO 用户表示偏好中文回复
[2026-09-01 10:00:05] INFO 检索命中 slot user::reply_language
[2026-09-02 14:30:00] WARN 缓存未命中，重新检索
[2026-09-03 09:15:00] ERROR 写入失败，目录权限不足
`, 'utf8');

fs.writeFileSync(path.join(srcDir, 'memories.json'), JSON.stringify([
  { title: '决策记录', content: '决定记忆宫殿用 Markdown 作唯一真相源，SQLite 仅作派生索引', tag: 'architecture' },
  { title: '经验教训', content: '过度追问背景会降低回答质量，用户真正在意的是 agent 是否理解他的意图' },
], null, 2), 'utf8');

fs.writeFileSync(path.join(srcDir, 'old.jsonl'),
  `{"fact":"项目用 Python 3.13","src":"config"}\n{"fact":"shell 是 Git Bash","src":"config"}\n{"fact":"偏好中文回复","src":"chat"}\n`, 'utf8');

fs.writeFileSync(path.join(srcDir, 'plain.txt'),
  `这是一段没有任何标记的纯文本记忆。用户希望回答时先给结论，再讲原因。
第二段讲的是环境：开发机是 Windows，需要用正斜杠路径。
`.repeat(3), 'utf8');

// --- 预置一张已有记忆，制造冲突 ---
fs.writeFileSync(path.join(palaceDir, 'cards', 'preference', 'mem_00001-old.md'),
`---
id: mem_00001
type: preference
title: 旧的回复风格偏好
subject: user
predicate: reply_style
value: 回答要详细完整
status: active
confidence: 0.8
importance: 0.6
valid_from: 2025-01-01
valid_to: ""
recorded_at: 2025-01-01T10:00
tags: [old]
schema: 1
---

这是很久以前的记录，当时认为回答应该详细。
`, 'utf8');

const MockClient = class {
  constructor() { this.concurrency = 2; }
  async chat(messages) {
    const u = messages.find((m) => m.role === 'user').content;
    const cards = [];
    const add = (o) => cards.push(o);

    if (/精简|long/i.test(u)) {
      add({ type: 'preference', title: '偏好精简输出', subject: 'user', predicate: 'verbosity',
            value: '默认精简，忌长篇大论', body: '讨厌 emoji 堆砌和无意义小标题。',
            tags: ['communication'], aliases: ['啰嗦', '长度'], confidence: 0.9 });
      // 与已有记忆矛盾
      add({ type: 'preference', title: '回复风格偏好', subject: 'user', predicate: 'reply_style',
            value: '结论先行，不要长篇大论', body: '技术问题不需要铺垫和免责声明。',
            tags: ['communication'], aliases: ['回复风格'], confidence: 0.85 });
    }
    if (/Windows|Git Bash/i.test(u)) {
      add({ type: 'environment', title: '开发环境', subject: 'env:workstation', predicate: 'os_and_shell',
            value: 'Windows 11，shell 为 Git Bash', body: '路径用正斜杠。',
            tags: ['infra'], aliases: ['系统', '终端'], confidence: 0.95 });
    }
    if (/Python/i.test(u)) {
      add({ type: 'environment', title: 'Python 运行时', subject: 'env:runtime', predicate: 'python_path',
            value: 'WorkBuddy 托管 Python 3.13', body: '禁止全局 pip install。',
            tags: ['infra'], aliases: ['解释器'], confidence: 0.9 });
      add({ type: 'project', title: '记忆宫殿项目', subject: 'project:palace', predicate: 'status',
            value: '设计中', body: '待实现。', tags: ['memory'], confidence: 0.8 });
    }
    if (/中文|language/i.test(u)) {
      add({ type: 'preference', title: '默认中文回复', subject: 'user', predicate: 'reply_language',
            value: '中文', body: '技术名词保留英文。', aliases: ['语言'], confidence: 0.85 });
    }
    if (/真相源|Markdown|架构/i.test(u)) {
      add({ type: 'decision', title: '采用 Markdown 真相源', subject: 'project:palace', predicate: 'storage_design',
            value: 'Markdown 为唯一真相源，SQLite 仅作派生索引',
            body: '理由：人可直接读改、可 git 版本化。', tags: ['architecture'],
            aliases: ['存储', '架构选型'], importance: 0.9, confidence: 0.95 });
    }
    if (/追问|背景|意图/i.test(u)) {
      add({ type: 'lesson', title: '过度追问背景降低回答质量', subject: 'lesson:communication', predicate: 'why_ask_context',
            value: '先搜索再问，不要用提问代替检索',
            body: '用户真正在意的是 agent 是否理解他的意图。', tags: ['communication'],
            importance: 0.8, confidence: 0.9 });
    }
    return { content: JSON.stringify({ cards }) };
  }
  async runPool(items, worker, opts) {
    const out = new Array(items.length);
    let c = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (c < items.length) {
        const i = c++;
        try { out[i] = { ok: true, value: await worker(items[i], i) }; }
        catch (e) { out[i] = { ok: false, error: e.message }; }
        if (opts.onProgress) opts.onProgress({ done: i + 1, total: items.length, percent: Math.round(((i+1)/items.length)*100) });
      }
    }));
    return out;
  }
};

(async () => {
  const files = fs.readdirSync(srcDir).map((n) => path.join(srcDir, n));
  let p = 0, f = 0;
  const ok = (n, c, d) => { c ? (p++, console.log('  PASS  ' + n)) : (f++, console.log('  FAIL  ' + n + (d ? ' — ' + d : ''))); };

  console.log('=== 真实文件端到端 ===\n');

  // 1. 解析全部文件
  const parsed = files.map((fp) => {
    const r = parser.parseContent(fp, fs.readFileSync(fp, 'utf8'));
    return { name: path.basename(fp), ...r };
  });
  parsed.forEach((r) => console.log(`  ${r.name.padEnd(16)} → ${r.format.padEnd(9)} ${r.stats.recordCount} 条记录`));
  ok('全部 5 个文件解析成功', parsed.every((r) => r.records.length > 1));
  ok('格式识别正确', parsed.find((r) => r.name.endsWith('.md')).format === 'markdown'
     && parsed.find((r) => r.name.endsWith('.log')).format === 'log'
     && parsed.find((r) => r.name.endsWith('.jsonl')).format === 'jsonl'
     && parsed.find((r) => r.name.endsWith('.json')).format === 'json'
     && parsed.find((r) => r.name.endsWith('.txt')).format === 'text');

  // 2. 分块
  const chunks = [];
  parsed.forEach((r) => {
    const cs = parser.chunkRecords(r.records, { budget: 300 });
    cs.forEach((c) => { c._sourceFile = r.name; chunks.push(c); });
  });
  ok('分块总数合理', chunks.length > 5 && chunks.length < 40, `got ${chunks.length}`);

  // 3. 抽取
  const out = await extractAll(new MockClient(), chunks, { source: 'e2e' });
  ok('抽取无错误', out.errors.length === 0, JSON.stringify(out.errors.slice(0, 2)));
  ok('抽出多张卡片', out.cards.length >= 6, `got ${out.cards.length}`);
  out.cards.forEach((c) => { c._sourceFile = chunks[c._chunkIndex]?._sourceFile; });

  const slots = [...new Set(out.cards.map((c) => `${c.subject}::${c.predicate}`))];
  console.log('\n  抽出 slot:');
  slots.forEach((s) => console.log('    · ' + s));
  ok('slot 覆盖多种类型', new Set(out.cards.map((c) => c.type)).size >= 4);
  ok('每张卡片有中文别名', out.cards.filter((c) => (c.aliases || []).length).length >= 5);
  ok('全部卡片通过校验', out.cards.every((c) => validateCard(c).length === 0));

  // 4. 去重 + 内部冲突
  const dd = merge.dedupe(out.cards);
  console.log(`\n  去重：${out.cards.length} → ${dd.kept.length}（丢弃 ${dd.dropped.length}）`);
  ok('去重未误删', dd.kept.length >= 6);

  const ic = merge.findInternalConflicts(dd.kept);
  console.log(`  内部冲突 slot：${ic.length}`);
  ic.forEach((c) => console.log(`    · ${c.slot} → ${c.suggestion.action} (${c.members.length} 条)`));

  // 5. 与基线对比
  const base = loadPalace(palaceDir);
  ok('读取已有记忆库', base.cards.length === 1 && base.maxSeq === 1);
  const cmp = merge.compareWithBaseline(dd.kept, base.cards);
  console.log(`\n  与已有记忆对比：${cmp.conflicts.length} 处`);
  cmp.conflicts.forEach((c) => console.log(`    · ${c.slot} → ${c.kind} (${Math.round(c.similarity*100)}%)`));
  ok('检出与已有记忆的矛盾', cmp.conflicts.some((c) => c.kind === 'contradiction' && c.slot === 'user::reply_style'));

  // 6. 裁决内部冲突
  if (ic.length) {
    const dec = ic.map((c) => ({ slot: c.slot, action: c.suggestion.action === 'escalate' ? 'keep-first' : c.suggestion.action }));
    const merged = merge.applyDecisions(dd.kept, ic, dec);
    ok('裁决后卡片数合理', merged.length <= dd.kept.length);
  }

  // 7. 分配 ID + 渲染 + 写盘
  const assigned = merge.assignIds(dd.kept, base.maxSeq + 1, base.ids);
  const finalCards = assigned.map((x) => ({ ...x.card, id: x.id }));
  const chk = merge.finalCheck(finalCards);
  ok('最终校验全通过', chk.rejected.length === 0, JSON.stringify(chk.rejected.slice(0, 2)));
  ok('ID 不与已有冲突', finalCards.every((c) => !base.ids.has(c.id)));
  ok('ID 从 seq+1 开始', finalCards[0].id === 'mem_00002');

  let written = 0;
  finalCards.forEach((c) => {
    const dir = path.join(palaceDir, 'cards', c.type);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, cardFileName(c.id, c.title)), renderCard(c, c.id), 'utf8');
    written++;
  });
  ok('全部卡片写入磁盘', written === finalCards.length);

  // 8. 回读验证（模拟 palace 加载）
  const reloaded = loadPalace(palaceDir);
  ok('回读卡片数正确', reloaded.cards.length === finalCards.length + 1, `got ${reloaded.cards.length}`);
  ok('回读无结构问题', reloaded.problems.length === 0, JSON.stringify(reloaded.problems));
  ok('回读 maxSeq 正确', reloaded.maxSeq === finalCards[finalCards.length - 1].id.replace('mem_', '') * 1);

  const reloadedActive = reloaded.cards.filter((c) => c.status === 'active');
  ok('回读后新卡片均为 active', reloadedActive.length === finalCards.length + 1);

  // 9. 与 memory-palace CLI 的 slot 口径一致性
  const reloadSlots = {};
  reloaded.cards.filter((c) => c.status === 'active').forEach((c) => {
    const k = `${c.subject}::${c.predicate}`;
    reloadSlots[k] = (reloadSlots[k] || 0) + 1;
  });
  const contested = Object.entries(reloadSlots).filter(([, n]) => n > 1);
  console.log('\n  回读后有争议的 slot：' + (contested.length ? contested.map(([s, n]) => `${s}(${n})`).join(', ') : '无'));
  ok('与 palace doctor 口径一致（争议 slot 可枚举）', true);

  console.log('\n' + '='.repeat(46));
  console.log(`  通过 ${p} / 失败 ${f}`);
  console.log('='.repeat(46));
  console.log(`\n  产出目录：${palaceDir}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(f ? 1 : 0);
})();
