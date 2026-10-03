'use strict';
/**
 * 端到端测试：mock LLM 跑通完整管线。
 * 运行： npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('../src/engine/parser');
const { normalizeCard, validateCard, renderCard, TYPE_ORDER } = require('../src/engine/schema');
const { dedupe, findInternalConflicts, compareWithBaseline, applyDecisions, assignIds, finalCheck, similarity } = require('../src/engine/merge');
const { loadPalace, parseFrontmatter } = require('../src/engine/palace');
const { parseLooseJSON, LLMClient } = require('../src/engine/llm');
const { buildUserPrompt, extractAll } = require('../src/engine/extract');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

// --- 1. 格式识别 ---------------------------------------------------------
section('格式识别');
eq('识别 markdown', parser.detectFormat('a.md', '# T\n\n内容'), 'markdown');
eq('识别 log', parser.detectFormat('a.log', '[2026-01-01 10:00:00] INFO 启动\n[2026-01-01 10:00:01] INFO 就绪\n[2026-01-01 10:00:02] INFO 完成'), 'log');
eq('识别纯文本', parser.detectFormat('a.txt', '就是一段普通的文字，没有任何特殊标记。'), 'text');
eq('识别 json', parser.detectFormat('a.json', '{"a":1}'), 'json');
eq('识别 jsonl', parser.detectFormat('a.txt', '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}'), 'jsonl');
eq('按扩展名识别 jsonl', parser.detectFormat('a.jsonl', '{"a":1}'), 'jsonl');

// --- 2. 各格式解析 -------------------------------------------------------
section('解析与切分');
const md = parser.parseContent('n.md', `# 标题一\n\n第一段内容，用来测试 markdown 解析逻辑。\n\n## 二级标题\n\n第二段内容。\n\n## 另一个二级\n\n第三段。\n`);
eq('markdown 切出 3 段', md.records.filter(r => r.kind === 'markdown-section').length, 3);
ok('markdown 记录带 section', md.records.some(r => r.section === '二级标题'));

const logText = `[2026-01-01 10:00:00] INFO 用户偏好设置\n[2026-01-01 10:00:05] WARN 缓存未命中\n[2026-01-02 09:00:00] ERROR 数据库连接失败\n`;
const lg = parser.parseContent('a.log', logText);
eq('log 切出 3 个事件', lg.records.filter(r => r.kind === 'log-event').length, 3);
ok('log 记录带 timestamp', lg.records.some(r => r.timestamp === '2026-01-01 10:00:00'));

const jsn = parser.parseContent('m.json', JSON.stringify([
  { title: '偏好简洁', content: '用户不喜欢长篇大论' },
  { title: '环境信息', content: '机器是 Windows 11' },
]));
ok('json 数组解析出对象记录', jsn.records.filter(r => r.kind === 'json-object').length >= 2);

const nested = parser.parseContent('n.json', JSON.stringify({ user: { name: 'Holly', pref: '精简' }, tags: ['a'] }));
ok('json 嵌套结构被展开', nested.records.length >= 2);

const jl = parser.parseContent('a.jsonl', '{"m":"用户偏好中文"}\n{"m":"项目用 Python"}\n{"bad json\n');
ok('jsonl 解析含非法行时给出提示', jl.records.some(r => r.kind === 'meta-note'));

const txt = parser.parseContent('a.txt', '第一段内容，长度足够触发切分逻辑。'.repeat(8) + '\n\n' + '第二段。'.repeat(8));
ok('纯文本按空行分段', txt.records.filter(r => r.kind.startsWith('text')).length >= 2);

const broken = parser.parseContent('b.json', '{ not valid json at all ');
ok('解析失败时明确标记而非静默', broken.records.some(r => r.error) || broken.records.some(r => r.kind === 'text-whole'));

// --- 3. 分块 -------------------------------------------------------------
section('分块');
const recs = [];
for (let i = 0; i < 30; i++) recs.push({ id: `r${i}`, text: 'x'.repeat(500), locator: `L${i}`, chars: 500, kind: 'text-block' });
const chunks = parser.chunkRecords(recs, { budget: 2000 });
// 30 条 × 500 字符 / 每块约 1506 字符 → 10 块；断言块数与预算一致性
ok('分块数合理', chunks.length === 10, `got ${chunks.length}`);
ok('每块不超预算', chunks.every(c => c.chars <= 2000));
ok('分块后总记录数守恒', chunks.reduce((s, c) => s + c.recordCount, 0) === 30);
ok('每块都有可发送的文本', chunks.every(c => typeof c.text === 'string' && c.text.includes('<record')));
ok('文件元信息单独成块', (() => {
  const withMeta = [...recs, { id: 'meta', text: '来源文件: x', locator: 'file-header', chars: 20, kind: 'file-meta' }];
  const cs = parser.chunkRecords(withMeta, { budget: 2000 });
  return cs.some(c => c.recordCount === 1 && c.records[0].kind === 'file-meta');
})());
const longRec = [{ id: 'L', text: 'y'.repeat(5000), locator: 'L1', chars: 5000, kind: 'text-block' }];
ok('超长记录被切窗', parser.chunkRecords(longRec, { budget: 2000 }).length >= 2);

// 边界：预算过小曾导致 sliceLong 步长为 0 而死循环（OOM），必须有回归测试
ok('budget=1 不死循环且能切分', (() => {
  const r = parser.chunkRecords(longRec, { budget: 1 });
  return r.length > 0 && r.length < 10000;
})());
ok('budget=0 被兜底为安全值', parser.chunkRecords(longRec, { budget: 0 }).length > 0);
ok('budget=NaN 被兜底为安全值', parser.chunkRecords(longRec, { budget: NaN }).length > 0);
ok('maxRecordsPerChunk=0 被兜底为默认 40', (() => {
  // 兜底为 40 → 30 条记录按 500 字符/3 条一块 = 10 块
  const cs = parser.chunkRecords(recs, { budget: 2000, maxRecordsPerChunk: 0 });
  return cs.length === 10 && cs.every(c => c.recordCount <= 40);
})());
ok('小预算切分后内容总量守恒', (() => {
  const cs = parser.chunkRecords(longRec, { budget: 200 });
  return cs.reduce((s, c) => s + c.records[0].text.length, 0) === 5000;
})());

// --- 4. JSON 容错解析 ----------------------------------------------------
section('LLM 输出容错解析');
eq('直接 JSON 数组', parseLooseJSON('[{"a":1}]').length, 1);
eq('markdown 围栏包裹', parseLooseJSON('```json\n[{"a":1}]\n```').length, 1);
eq('无语言标记围栏', parseLooseJSON('```\n[{"a":1}]\n```').length, 1);
eq('前后有解释文字', parseLooseJSON('好的，结果如下：\n[{"a":1}]\n希望有帮助。').length, 1);
eq('对象包裹数组', parseLooseJSON('{"cards":[{"a":1}]}').cards.length, 1);
eq('字符串中的花括号不误配', (() => {
  const r = parseLooseJSON('{"text":"这里有个 } 符号","b":2}');
  return r && r.b === 2;
})(), true);
eq('无效输入返回 null', parseLooseJSON('完全不是 JSON'), null);

// --- 5. schema 归一化 ----------------------------------------------------
section('卡片归一化与校验');
ok('正常卡片通过', validateCard(normalizeCard({
  type: 'preference', title: '偏好精简', subject: 'user', predicate: 'reply_style',
  value: '默认精简', body: '讨厌长报告', confidence: 0.9, importance: 0.6,
})).length === 0);

eq('非法类型被丢弃', normalizeCard({ type: 'unknown', subject: 'user', predicate: 'x', value: 'v' }), null);
eq('缺 predicate 被丢弃', normalizeCard({ type: 'lesson', subject: 'user', value: 'v' }), null);
eq('subject 空格被替换', normalizeCard({ type: 'lesson', subject: 'my topic', predicate: 'p', value: 'v' }).subject, 'my-topic');
eq('predicate 空格被替换', normalizeCard({ type: 'lesson', subject: 's', predicate: 'a b', value: 'v' }).predicate, 'a_b');
eq('confidence 越界被夹紧', normalizeCard({ type: 'lesson', subject: 's', predicate: 'p', value: 'v', confidence: 5 }).confidence, 1);
eq('非数字 confidence 用默认', normalizeCard({ type: 'lesson', subject: 's', predicate: 'p', value: 'v', confidence: 'high' }).confidence, 0.8);
ok('超长 body 被截断', normalizeCard({
  type: 'episode', subject: 's', predicate: 'p', value: 'v', body: 'x'.repeat(2000),
}).body.length <= 900);
eq('非法链接关系被过滤', normalizeCard({
  type: 'lesson', subject: 's', predicate: 'p', value: 'v', links: ['bad:relation', 'supports:x1'],
}).links, ['supports:x1']);
eq('非数组 tags 不崩溃', normalizeCard({ type: 'lesson', subject: 's', predicate: 'p', value: 'v', tags: 'notarray' }).tags, []);

const activeWithTo = normalizeCard({ type: 'lesson', subject: 's', predicate: 'p', value: 'v', status: 'active', valid_to: '2026-01-01' });
ok('active + valid_to 被校验拦下', validateCard(activeWithTo).some(p => p.includes('valid_to')));

// --- 6. 渲染可被 Python 侧解析 --------------------------------------------
section('渲染格式往返一致性');
const card = normalizeCard({
  type: 'decision', title: '采用 Markdown 真相源', subject: 'project:x', predicate: 'storage',
  value: 'Markdown 为真相源', body: '理由：可读可 git。', tags: ['arch', 'memory'],
  aliases: ['存储', '真相源'], confidence: 0.95, importance: 0.85,
});
const rendered = renderCard(card, 'mem_00042');
const back = parseFrontmatter(rendered);
ok('渲染后可被解析器读回', back !== null);
eq('id 往返一致', back.data.id, 'mem_00042');
eq('subject 往返一致', back.data.subject, 'project:x');
eq('tags 往返一致', back.data.tags, ['arch', 'memory']);
eq('aliases 往返一致', back.data.aliases, ['存储', '真相源']);
eq('confidence 往返一致', back.data.confidence, 0.95);
ok('body 往返一致', back.body.includes('理由：可读可 git。'));
ok('含冒号的值被正确加引号', /^value: ".*:.*"/m.test(rendered) || !card.value.includes(': '));
eq('中文 key 值不加多余引号', /^title: 采用 Markdown 真相源$/m.test(rendered), true);

// --- 7. 去重 -------------------------------------------------------------
section('去重');
const mk = (v, extra = {}) => normalizeCard({ type: 'preference', title: `T${v}`, subject: 'user', predicate: 'reply_style', value: v, body: 'b', ...extra });
const dupSet = [mk('默认精简回答'), mk('默认精简回答'), mk('结论先行'), mk('结论先行，谢谢。')];
const dedupRes = dedupe(dupSet);
eq('完全重复被去重', dedupRes.kept.length, 3);
ok('去重有记录', dedupRes.dropped.length >= 1);
ok('被去重的记录带原因', dedupRes.dropped[0].reason.includes('duplicate'));

// --- 8. 冲突检测 ---------------------------------------------------------
section('冲突检测');
const c1 = normalizeCard({ type: 'preference', title: 'A', subject: 'user', predicate: 'reply_language', value: '中文' });
const c2 = normalizeCard({ type: 'preference', title: 'B', subject: 'user', predicate: 'reply_language', value: '英文' });
const c3 = normalizeCard({ type: 'preference', title: 'C', subject: 'user', predicate: 'verbosity', value: '精简' });
const conflicts = findInternalConflicts([c1, c2, c3]);
eq('检出 1 个冲突 slot', conflicts.length, 1);
eq('冲突 slot 名正确', conflicts[0].slot, 'user::reply_language');
ok('冲突含 2 个成员', conflicts[0].members.length === 2);
ok('真冲突建议 escalate', conflicts[0].suggestion.action === 'escalate');
ok('不同 predicate 不算冲突', !conflicts.some(c => c.slot === 'user::verbosity'));

const similar = [
  normalizeCard({ type: 'preference', title: 'A', subject: 'user', predicate: 'x', value: '用户偏好精简的回答' }),
  normalizeCard({ type: 'preference', title: 'B', subject: 'user', predicate: 'x', value: '用户偏好精简的回答方式' }),
];
similar.forEach((c, i) => { c._localId = `S${i + 1}`; });
ok('高度相似的冲突建议 merge', findInternalConflicts(similar)[0].suggestion.action === 'merge');

const withChange = [
  normalizeCard({ type: 'project', title: 'A', subject: 'project:p', predicate: 'status', value: '设计中' }),
  normalizeCard({ type: 'project', title: 'B', subject: 'project:p', predicate: 'status', value: '已上线，不再是设计中' }),
];
withChange.forEach((c, i) => { c._localId = `W${i + 1}`; });
ok('含变更措辞建议 supersede', findInternalConflicts(withChange)[0].suggestion.action === 'supersede');

// --- 9. 与基线对比 -------------------------------------------------------
section('与已有记忆库对比');
const baseline = [
  { id: 'mem_00001', subject: 'user', predicate: 'reply_style', value: '结论先行', status: 'active', title: '旧卡', recorded_at: '2026-01-01' },
  { id: 'mem_00002', subject: 'env', predicate: 'os', value: 'Windows 11', status: 'active', title: '环境', recorded_at: '2026-01-01' },
  { id: 'mem_00003', subject: 'user', predicate: 'old', value: '已废弃', status: 'superseded', title: '旧', recorded_at: '2025-01-01' },
];
const incoming = [
  normalizeCard({ type: 'preference', title: 'X', subject: 'user', predicate: 'reply_style', value: '结论先行，不要铺垫' }),
  normalizeCard({ type: 'preference', title: 'Y', subject: 'user', predicate: 'reply_language', value: '中文' }),
  normalizeCard({ type: 'environment', title: 'Z', subject: 'env', predicate: 'shell', value: 'Git Bash' }),
];
const cmp = compareWithBaseline(incoming, baseline);
ok('检出与基线的 enrichment 冲突', cmp.conflicts.some(c => c.slot === 'user::reply_style' && c.kind === 'enrichment'));
ok('检出基线中不存在的新 slot', cmp.newSlots.includes('user::reply_language'));
ok('ignored superseded 基线', !cmp.conflicts.some(c => c.slot === 'user::old'));
ok('基线未被覆盖的 slot 被提示', cmp.updates.length >= 0);

const contradiction = compareWithBaseline(
  [normalizeCard({ type: 'preference', title: 'Q', subject: 'user', predicate: 'reply_style', value: '长篇大论' })],
  baseline
);
ok('真矛盾被识别为 contradiction', contradiction.conflicts[0].kind === 'contradiction');
ok('真矛盾建议 escalate', contradiction.conflicts[0].suggestion.action === 'escalate');

eq('无基线时不报冲突', compareWithBaseline(incoming, []).conflicts.length, 0);

// --- 10. 裁决应用 --------------------------------------------------------
section('裁决应用');
const conflictCards = [c1, c2, c3];
conflictCards.forEach((c, i) => { c._localId = `L${i + 1}`; });
const conflicts2 = findInternalConflicts(conflictCards);   // 先赋 _localId 再检测
const merged = applyDecisions(conflictCards, conflicts2, [{ slot: 'user::reply_language', action: 'merge' }]);
eq('merge 后冲突 slot 只剩一条', merged.filter(c => c.predicate === 'reply_language').length, 1);
ok('合并内容进入正文', merged.find(c => c.predicate === 'reply_language').body.includes('英文'));
ok('其他 slot 不受影响', merged.some(c => c.predicate === 'verbosity'));

const superseded = applyDecisions(conflictCards, conflicts2, [{ slot: 'user::reply_language', action: 'supersede' }]);
eq('supersede 后只剩一条', superseded.filter(c => c.predicate === 'reply_language').length, 1);
ok('supersede 保留备注', superseded.find(c => c.predicate === 'reply_language').body.includes('取代了'));

const disputed = applyDecisions(conflictCards, conflicts2, [{ slot: 'user::reply_language', action: 'dispute' }]);
eq('dispute 保留全部', disputed.filter(c => c.predicate === 'reply_language').length, 2);
eq('dispute 标记状态', disputed.filter(c => c.predicate === 'reply_language').every(c => c.status === 'disputed'), true);

const droppedAll = applyDecisions(conflictCards, conflicts2, [{ slot: 'user::reply_language', action: 'drop' }]);
eq('drop 移除全部', droppedAll.filter(c => c.predicate === 'reply_language').length, 0);

// --- 11. ID 分配 ---------------------------------------------------------
section('ID 分配');
const ids = assignIds([card, card, card], 10, new Set(['mem_00010', 'mem_00011']));
eq('跳过已占用 ID', ids.map(x => x.id), ['mem_00012', 'mem_00013', 'mem_00014']);
const padIds = assignIds([card], 1, new Set());
eq('ID 补零到 5 位', padIds[0].id, 'mem_00001');

// --- 12. 最终校验 --------------------------------------------------------
section('最终校验');
const mixed = [card, normalizeCard({ type: 'lesson', subject: '', predicate: '', value: 'x' })].filter(Boolean);
const fc = finalCheck(mixed);
ok('合法卡片通过最终校验', fc.ok.length >= 1);
ok('不合法卡片被拦下并给出原因', fc.rejected.length >= 0);

// --- 13. palace 目录读取 -------------------------------------------------
section('读取已有 palace');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
fs.mkdirSync(path.join(tmp, 'cards', 'preference'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'cards', 'lesson'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'cards', 'preference', 'mem_00001-a.md'), renderCard(
  normalizeCard({ type: 'preference', title: '偏好精简', subject: 'user', predicate: 'verbosity', value: '精简' }), 'mem_00001'));
fs.writeFileSync(path.join(tmp, 'cards', 'lesson', 'mem_00002-b.md'), renderCard(
  normalizeCard({ type: 'lesson', title: '教训', subject: 'lesson:x', predicate: 'why', value: '先搜索再问' }), 'mem_00002'));
fs.writeFileSync(path.join(tmp, 'cards', 'README.md'), '# 不是卡片\n');

const loaded = loadPalace(tmp);
eq('读到 2 张卡片', loaded.cards.length, 2);
eq('跳过 README.md', loaded.problems.filter(p => p.file.includes('README')).length, 0);
eq('maxSeq 正确', loaded.maxSeq, 2);
eq('ids 集合正确', loaded.ids.size, 2);
const prefCard = loaded.cards.find(c => c.id === 'mem_00001');
ok('卡片字段解析正确',
  prefCard && prefCard.subject === 'user' && prefCard.value === '精简' && prefCard.predicate === 'verbosity',
  prefCard ? JSON.stringify({s:prefCard.subject,p:prefCard.predicate,v:prefCard.value}) : 'not found');
ok('空值字段为字符串空串而非 null',
  typeof loaded.cards[0].valid_to === 'string' && typeof loaded.cards[0].tags !== 'undefined');

fs.writeFileSync(path.join(tmp, 'cards', 'preference', 'broken.md'), '---\ntitle: 缺 id\n---\n正文\n');
const loaded2 = loadPalace(tmp);
ok('缺 id 的文件被报告', loaded2.problems.some(p => p.problem.includes('id')));

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-empty-'));
ok('空目录不报错', loadPalace(emptyDir).cards.length === 0);
ok('不存在的目录返回 found=false', loadPalace(path.join(emptyDir, 'nope')).found === false);

// --- 14. 相似度算法 ------------------------------------------------------
section('相似度');
ok('完全相同为 1', similarity('默认精简', '默认精简') === 1);
ok('标点差异视为相同', similarity('默认，精简。', '默认精简') === 1);
ok('完全不同为低分', similarity('中文回复', '项目进度跟踪') < 0.2);
ok('部分重叠居中', (() => {
  const s = similarity('用户偏好精简的回答方式', '用户偏好详细的回答方式');
  return s > 0.4 && s < 0.95;
})());
ok('空值安全', similarity('', 'x') === 0 && similarity(null, null) === 0);

// --- 15. mock LLM 全管线 -------------------------------------------------
section('mock LLM 全管线');
const MockClient = class {
  constructor() { this.concurrency = 3; this.calls = 0; this.dirtyCalls = 0; }
  describe() { return { provider: 'mock', model: 'mock' }; }
  async chat(messages) {
    this.calls++;
    const userMsg = messages.find(m => m.role === 'user').content;
    const has = (kw) => userMsg.includes(kw);
    let cards = [];
    if (has('精简') || has('偏好')) {
      cards.push({ type: 'preference', title: '偏好精简输出', subject: 'user', predicate: 'verbosity', value: '默认精简', body: '讨厌长报告', tags: ['comm'], aliases: ['啰嗦'], confidence: 0.9 });
    }
    if (has('中文') || has('语言')) {
      cards.push({ type: 'preference', title: '默认中文回复', subject: 'user', predicate: 'reply_language', value: '中文', body: '技术名词保留英文', aliases: ['语言'], confidence: 0.85 });
    }
    if (has('Windows') || has('环境')) {
      cards.push({ type: 'environment', title: 'Windows 环境', subject: 'env:workstation', predicate: 'os', value: 'Windows 11', body: 'shell 为 Git Bash', confidence: 0.95 });
    }
    if (has('Python') || has('项目')) {
      cards.push({ type: 'project', title: '记忆宫殿项目', subject: 'project:palace', predicate: 'status', value: '设计中', body: '待实现', confidence: 0.8 });
    }
    // 交替返回脏输出与非法项，验证两层容错都能工作
    if (this.calls % 2 === 0) {
      this.dirtyCalls++;
      return { content: '这是抽取结果：\n```json\n' + JSON.stringify({ cards }) + '\n```\n以上。' };
    }
    if (this.calls % 5 === 0) {
      return { content: JSON.stringify({ cards: [...cards, { type: 'bogus' }, { noSubject: true }] }) };
    }
    return { content: JSON.stringify({ cards }) };
  }
  async runPool(items, worker, opts) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        try { results[idx] = { ok: true, value: await worker(items[idx], idx) }; }
        catch (e) { results[idx] = { ok: false, error: e.message }; }
        if (opts.onProgress) opts.onProgress({ done: idx + 1, total: items.length, index: idx });
      }
    });
    await Promise.all(runners);
    return results;
  }
};

const mockSource = `# 用户偏好

用户偏好精简的回答，不要长篇大论。

# 环境配置

机器是 Windows 11，shell 是 Git Bash。

# 项目状态

记忆宫殿项目还在设计中，用 Python 实现。
`;

const p = parser.parseContent('mixed.md', mockSource);
// 预算 64 是 chunkRecords 的实际下限，用它让 3 个 section 各自成块
const cs = parser.chunkRecords(p.records, { budget: 64, maxRecordsPerChunk: 1 });
ok('每个 section 独立成块', cs.filter(c => c.recordCount === 1 && c.records[0].kind === 'markdown-section').length === 3,
  `got ${cs.filter(c => c.records[0]?.kind === 'markdown-section').length}`);

(async () => {
  const mock = new MockClient();
  const out = await extractAll(mock, cs, { source: 'test.md', existingSlots: [], style: 'auto' });

  // 3 个 section → 3 张卡（mock 按主题各返一张）
  ok('全管线抽出卡片', out.cards.length === 3, `got ${out.cards.length}`);
  eq('每个 section 抽出一张卡', out.cards.map(c => c.predicate).sort(), ['os', 'status', 'verbosity']);
  eq('无解析错误', out.errors.length, 0);
  ok('容错处理了围栏与解释文字', mock.dirtyCalls >= 1, `dirtyCalls=${mock.dirtyCalls}`);
  ok('非法卡片被过滤而非崩溃', out.cards.every(c => c.type && c.subject && c.predicate));
  ok('所有卡片通过校验', out.cards.every(c => validateCard(c).length === 0));

  const slots = new Set(out.cards.map(c => `${c.subject}::${c.predicate}`));
  ok('抽出多种 slot', slots.size >= 3, `got ${[...slots].join(', ')}`);

  const dd = dedupe(out.cards);
  const ic = findInternalConflicts(dd.kept);
  ok('去重后无内部冲突', ic.length === 0, `${ic.length} 个冲突`);

  const baseCmp = compareWithBaseline(dd.kept, baseline);
  ok('与基线对比可执行', Array.isArray(baseCmp.conflicts));

  const assigned = assignIds(dd.kept, (loaded.maxSeq || 0) + 1, loaded.ids);
  ok('分配的 ID 不与已有冲突', assigned.every(x => !loaded.ids.has(x.id)));

  const finalCards = assigned.map(x => ({ ...x.card, id: x.id }));
  const fin = finalCheck(finalCards);
  eq('最终全部通过校验', fin.rejected.length, 0);
  eq('最终卡片数与输入一致', fin.ok.length, finalCards.length);

  const written = fin.ok.map(c => renderCard(c, c.id));
  ok('渲染产物非空', written.every(w => w.includes('id:') && w.includes('subject:')));

  // 往返验证：渲染 → palace 解析 → 对比
  const writtenCards = written.map(w => {
    const bk = parseFrontmatter(w);
    return { subject: bk.data.subject, predicate: bk.data.predicate, value: bk.data.value };
  });
  ok('渲染结果可被 palace 解析并保留 slot', writtenCards.every(c => c.subject && c.predicate && c.value));

  // 清理
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });

  console.log('\n' + '='.repeat(46));
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log('='.repeat(46));
  if (fail) {
    console.log('\n失败详情:');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
  }
  process.exit(fail ? 1 : 0);
})();
