'use strict';
/**
 * 浅尝模式测试：抽样、边界情况、只读保证。
 * 运行： node test/trial-mode.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sampler = require('../src/engine/sampler');
const parser = require('../src/engine/parser');
const merge = require('../src/engine/merge');
const { renderCard, normalizeCard } = require('../src/engine/schema');
const { loadPalace } = require('../src/engine/palace');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function section(t) { console.log(`\n=== ${t} ===`); }

// --- 构造测试用记忆库 ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trial-'));
const palaceDir = path.join(tmp, 'palace');

function buildPalace(root, spec) {
  const byType = {};
  spec.cards.forEach((c) => { (byType[c.type] = byType[c.type] || []).push(c); });
  Object.entries(byType).forEach(([type, cards]) => {
    const dir = path.join(root, 'cards', type);
    fs.mkdirSync(dir, { recursive: true });
    cards.forEach((c, i) => {
      const id = c.id || `mem_${String(++buildPalace.seq).padStart(5, '0')}`;
      const card = normalizeCard({ ...c, type }, { source: 'test' });
      fs.writeFileSync(path.join(dir, `${id}-t.md`), renderCard(card, id), 'utf8');
    });
  });
}
buildPalace.seq = 0;

const SPEC = [
  // preference 6 张，2 个 slot（制造潜在冲突）
  { type: 'preference', subject: 'user', predicate: 'reply_style', value: '结论先行' },
  { type: 'preference', subject: 'user', predicate: 'reply_style', value: '先给结论再讲原因' },
  { type: 'preference', subject: 'user', predicate: 'verbosity', value: '默认精简' },
  { type: 'preference', subject: 'user', predicate: 'verbosity', value: '不要太啰嗦' },
  { type: 'preference', subject: 'user', predicate: 'reply_language', value: '中文' },
  { type: 'preference', subject: 'user', predicate: 'reply_language', value: '中文为主' },
  // environment 4 张，4 个 slot
  { type: 'environment', subject: 'env:a', predicate: 'os', value: 'Windows 11' },
  { type: 'environment', subject: 'env:b', predicate: 'shell', value: 'Git Bash' },
  { type: 'environment', subject: 'env:c', predicate: 'python', value: '3.13' },
  { type: 'environment', subject: 'env:d', predicate: 'editor', value: 'VSCode' },
  // lesson 3 张
  { type: 'lesson', subject: 'lesson:x', predicate: 'why', value: '先搜索再问' },
  { type: 'lesson', subject: 'lesson:y', predicate: 'how', value: '先备份再改' },
  { type: 'lesson', subject: 'lesson:z', predicate: 'when', value: '小步快跑' },
  // project 2 张
  { type: 'project', subject: 'project:p', predicate: 'status', value: '设计中' },
  { type: 'project', subject: 'project:q', predicate: 'status', value: '已上线' },
];
buildPalace(palaceDir, { cards: SPEC });

const cards = loadPalace(palaceDir).cards;
console.log(`\n测试记忆库：${cards.length} 张卡片\n`);

// --- 1. 路径校验 ---
section('目标路径校验');
const okCheck = sampler.validateTarget(palaceDir);
ok('有效路径通过', okCheck.ok && okCheck.cards.length === SPEC.length);

const notFound = sampler.validateTarget(path.join(tmp, 'nope'));
ok('不存在路径 → NOT_FOUND', !notFound.ok && notFound.code === 'NOT_FOUND');
const notDir = sampler.validateTarget(path.join(palaceDir, 'cards'));
ok('指向子目录仍可作为库（是目录）', notDir.ok);

const filePath = path.join(palaceDir, 'cards', 'preference');
const firstFile = fs.readdirSync(filePath)[0];
const fileAsRoot = sampler.validateTarget(path.join(filePath, firstFile));
ok('传入文件 → NOT_A_DIRECTORY', !fileAsRoot.ok && fileAsRoot.code === 'NOT_A_DIRECTORY');

const emptyDir = path.join(tmp, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });
const emptyRes = sampler.validateTarget(emptyDir);
ok('空目录通过校验但抽样时报 NO_CARDS',
  emptyRes.ok && !sampler.planSample(emptyRes.cards, {}).ok
  && sampler.planSample(emptyRes.cards, {}).code === 'NO_CARDS');

const e = sampler.toError(notFound);
ok('错误对象含标题与提示', !!e.title && !!e.hint && e.code === 'NOT_FOUND');

// --- 2. 抽样策略 ---
section('抽样策略');
const rnd = sampler.planSample(cards, { strategy: 'random', count: 5, seed: 42 });
ok('随机抽样返回 5 条', rnd.ok && rnd.sampled.length === 5);
ok('随机抽样不重复', new Set(rnd.sampled.map((c) => c.id)).size === 5);

const strat = sampler.planSample(cards, { strategy: 'stratified', count: 6, seed: 7 });
ok('分层抽样返回 6 条', strat.ok && strat.sampled.length === 6, `got ${strat.sampled.length}`);
const stratTypes = new Set(strat.sampled.map((c) => c.type));
ok('分层覆盖多种类型', stratTypes.size >= 3, `got ${[...stratTypes].join(',')}`);

const slotS = sampler.planSample(cards, { strategy: 'slot', count: 5, seed: 1 });
ok('slot 扩散返回 5 条', slotS.ok && slotS.sampled.length === 5);
const slotKeys = new Set(slotS.sampled.map((c) => `${c.subject}::${c.predicate}`));
ok('slot 扩散每 slot 至多 1 条', slotKeys.size === slotS.sampled.length);
ok('slot 覆盖率高', slotKeys.size >= 5);

// --- 3. 可复现性 ---
section('可复现性');
const a1 = sampler.planSample(cards, { strategy: 'random', count: 6, seed: 999 });
const a2 = sampler.planSample(cards, { strategy: 'random', count: 6, seed: 999 });
eq('相同 seed 抽到相同样本', a1.sampled.map((c) => c.id), a2.sampled.map((c) => c.id));

const a3 = sampler.planSample(cards, { strategy: 'random', count: 6, seed: 1000 });
ok('不同 seed 结果不同', a1.sampled.map((c) => c.id).join() !== a3.sampled.map((c) => c.id).join());

const stratA = sampler.planSample(cards, { strategy: 'stratified', count: 6, seed: 5 });
const stratB = sampler.planSample(cards, { strategy: 'stratified', count: 6, seed: 5 });
eq('分层抽样同样可复现', stratA.sampled.map((c) => c.id), stratB.sampled.map((c) => c.id));

const noSeed = sampler.planSample(cards, { strategy: 'random', count: 3 });
ok('未指定 seed 时自动生成', noSeed.ok && Number.isInteger(noSeed.seed) && noSeed.seed > 0);

// --- 4. 数量与比例 ---
section('数量与比例');
const byRatio = sampler.planSample(cards, { strategy: 'random', ratio: 0.2, seed: 1 });
ok('比例抽样按候选池计算', byRatio.ok && byRatio.target === Math.ceil(cards.length * 0.2),
  `got ${byRatio && byRatio.target}`);

const byCount = sampler.planSample(cards, { strategy: 'random', count: 4, seed: 1 });
ok('数量抽样按指定条数', byCount.ok && byCount.target === 4);

const bothGiven = sampler.planSample(cards, { strategy: 'random', count: 3, ratio: 0.5, seed: 1 });
ok('同时给数量与比例时比例优先', bothGiven.ok && bothGiven.target === Math.ceil(cards.length * 0.5));

const fullRatio = sampler.planSample(cards, { strategy: 'random', ratio: 1, seed: 1 });
ok('比例 1 等于全量', fullRatio.ok && fullRatio.target === cards.length);

// --- 5. 边界情况 ---
section('边界情况');
const over = sampler.planSample(cards, { strategy: 'random', count: 9999, seed: 1 });
ok('数量超出容量 → 下调到池大小', over.ok && over.target === cards.length);
ok('超出容量给出告警', over.warnings.some((w) => w.code === 'SAMPLE_CLAMPED'));
ok('告警信息可读', over.warnings[0].message.includes(String(cards.length)));

const tinyRatio = sampler.planSample(cards, { strategy: 'random', ratio: 0.001, seed: 1 });
ok('极小比例仍至少 1 条', tinyRatio.ok && tinyRatio.target === 1, `got ${tinyRatio && tinyRatio.target}`);

const badRatio = sampler.planSample(cards, { strategy: 'random', ratio: 2 });
ok('比例 > 1 报错', !badRatio.ok && badRatio.code === 'BAD_RATIO');
const badRatio0 = sampler.planSample(cards, { strategy: 'random', ratio: 0 });
ok('比例 = 0 报错', !badRatio0.ok && badRatio0.code === 'BAD_RATIO');
const badCount = sampler.planSample(cards, { strategy: 'random', count: 0 });
ok('数量 0 报错（不被静默当成默认值）', !badCount.ok && badCount.code === 'NO_SAMPLE',
  `got ${badCount.code || 'ok'}`);
const badCountFloat = sampler.planSample(cards, { strategy: 'random', count: 3.7 });
ok('小数数量向下取整而非报错', badCountFloat.ok && badCountFloat.target === 3);
const badCountStr = sampler.planSample(cards, { strategy: 'random', count: 'abc' });
ok('非数字数量明确报错', !badCountStr.ok && badCountStr.code === 'BAD_COUNT');
const badSeed = sampler.planSample(cards, { strategy: 'random', count: 3, seed: 'xyz' });
ok('非数字 seed 明确报错', !badSeed.ok && badSeed.code === 'BAD_SEED');
const badCountNeg = sampler.planSample(cards, { strategy: 'random', count: -5 });
ok('负数数量报错', !badCountNeg.ok && badCountNeg.code === 'NO_SAMPLE');
const badStrategy = sampler.planSample(cards, { strategy: 'unknown' });
ok('未知策略报错', !badStrategy.ok && badStrategy.code === 'BAD_STRATEGY');
const badScope = sampler.planSample(cards, { strategy: 'random', statusScope: 'weird' });
ok('未知筛选范围报错', !badScope.ok && badScope.code === 'BAD_SCOPE');

// 只抽 active
const supersededCard = normalizeCard({ type: 'lesson', subject: 'lesson:d', predicate: 'k', value: 'v' }, {});
const withSuperseded = [...cards, { ...supersededCard, id: 'mem_09999', status: 'superseded', subject: 'lesson:d', predicate: 'k' }];
const activeOnly = sampler.planSample(withSuperseded, { strategy: 'random', count: 3, seed: 1 });
ok('默认只抽 active', activeOnly.sampled.every((c) => c.status === 'active'));
const allStatus = sampler.planSample(withSuperseded, { strategy: 'random', count: 3, statusScope: 'all', seed: 1 });
ok('可选全部状态', allStatus.ok && allStatus.poolSize === withSuperseded.length);

const onlyNonActive = [{ ...supersededCard, id: 'x1', status: 'superseded' }];
const noMatch = sampler.planSample(onlyNonActive, { strategy: 'random', count: 3 });
ok('无非 active 时报 NO_MATCHING', !noMatch.ok && noMatch.code === 'NO_MATCHING');

const tinyStrat = sampler.planSample(cards, { strategy: 'stratified', count: 2, seed: 1 });
ok('分层样本少于类型数时给出覆盖告警',
  tinyStrat.ok && tinyStrat.warnings.some((w) => w.code === 'SAMPLE_COVERAGE'));

// --- 6. 还原为记录并复用既有管线 ---
section('还原为记录（管线复用）');
const plan = sampler.planSample(cards, { strategy: 'random', count: 6, seed: 3 });
const records = sampler.sampleToRecords(plan.sampled);
ok('记录数与样本数一致', records.length === 6);
ok('记录含来源定位', records.every((r) => !!r.locator));
ok('记录标记为 palace-card', records.every((r) => r.kind === 'palace-card'));
ok('记录保留原始 id 供回溯', records.every((r) => /^mem_\d{5}$/.test(r._cardId)));

const chunks = parser.chunkRecords(records, { budget: 4000 });
ok('抽样记录可直接分块', chunks.length > 0);
ok('分块带可发送的文本', chunks.every((c) => !!c.text));

// 模拟主进程 buildChunks 的标记逻辑，确认样本与产出可关联
chunks.forEach((c, i) => {
  c._samplePlan = plan;
  c._sampleIndex = i;
  c._sampledIds = plan.sampled.map((s) => s.id);
});
ok('分块记录样本来源', chunks.every((c) => c._sampledIds && c._sampledIds.length === 6));
ok('分块保留抽样计划用于报告', chunks[0]._samplePlan && chunks[0]._samplePlan.strategy === 'random');

// 抽样出的记录能被真实解析器重新解析（管线复用的前提）
const reParsed = parser.parseContent('sample.md', records.map((r) => r.text).join('\n\n'));
ok('抽样文本可被真实解析器处理', reParsed.records.length >= 2);
// 关键：直接构造的记录保持一卡一条，不经 parseContent 二次合并
ok('一卡一条对应关系不被破坏',
  records.length === plan.sampled.length
  && new Set(records.map((r) => r._cardId)).size === plan.sampled.length);
ok('每条记录都带原始卡片 id 可溯源',
  records.every((r) => plan.sampled.some((s) => s.id === r._cardId)));

// 单条还原的内容检查
const oneRec = sampler.cardToRecord(cards[0], 0);
ok('还原含类型标签', oneRec.text.includes('类型:'));
ok('还原含 slot', oneRec.text.includes('::'));
ok('还原含主张', oneRec.text.includes('主张:'));

// --- 7. 报告生成 ---
section('试运行报告');
const mockResult = {
  cards: [
    normalizeCard({ type: 'preference', subject: 'user', predicate: 'a', value: 'v1' }, {}),
    normalizeCard({ type: 'lesson', subject: 'lesson:x', predicate: 'b', value: 'v2' }, {}),
  ],
  deduped: [{ card: {}, reason: 'exact-duplicate' }],
  internalConflicts: [{ slot: 'user::a', members: [1, 2], suggestion: { action: 'escalate' } }],
  errors: [],
};
const report = sampler.buildReport(plan, mockResult);
eq('报告标记为试运行', report.mode, 'trial');
eq('报告含抽样信息', report.sampling.strategy, 'random');
ok('报告含组织结构', !!report.organization.byType && report.organization.typeOrder.length > 0);
ok('报告统计唯一 slot 数', report.organization.uniqueSlots > 0);
eq('报告含抽取统计', report.extraction.extracted, 2);
eq('报告含去重统计', report.extraction.deduped, 1);
eq('报告含冲突统计', report.extraction.conflicts, 1);
ok('报告含样本预览', report.sampleCards.length > 0 && report.sampleCards.length <= 20);
ok('报告保留抽样告警', Array.isArray(report.warnings));

const summary = sampler.summarize(report);
ok('摘要非空', typeof summary === 'string' && summary.length > 20);
ok('摘要含抽样描述', summary.includes('抽样'));
ok('摘要含产出描述', summary.includes('卡片'));

// --- 8. 只读保证 ---
section('只读保证');
function snapshotDir(dir) {
  const out = {};
  const walk = (d) => {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    });
  };
  walk(dir);
  return out;
}
const before = snapshotDir(palaceDir);

// 完整走一遍试运行的所有只读操作
sampler.validateTarget(palaceDir);
const p1 = sampler.planSample(cards, { strategy: 'stratified', count: 5, seed: 11 });
sampler.sampleToRecords(p1.sampled);
parser.chunkRecords(sampler.sampleToRecords(p1.sampled), { budget: 3000 });
const p2 = sampler.planSample(cards, { strategy: 'slot', count: 8, seed: 11 });
sampler.buildReport(p2, mockResult);
sampler.summarize(report);
loadPalace(palaceDir);

const after = snapshotDir(palaceDir);
eq('试运行全程未修改记忆库', Object.keys(after).length, Object.keys(before).length);
const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
eq('试运行全程未改动任何文件内容', changed, []);
ok('未产生任何新文件', !Object.keys(after).some((k) => !(k in before)));

// 模拟主进程守卫：试运行模式禁止写入
function simulateGuard(mode) {
  return mode === 'trial' || mode === 'preview'
    ? { ok: false, error: '试运行模式不会写入任何文件。请确认结果后切换到完整模式。' }
    : { ok: true };
}
ok('守卫拦截 trial 写入', !simulateGuard('trial').ok);
ok('守卫拦截 preview 写入', !simulateGuard('preview').ok);
ok('守卫放行 merge 写入', simulateGuard('merge').ok);
ok('守卫放行 archive 写入', simulateGuard('archive').ok);

const third = snapshotDir(palaceDir);
eq('守卫测试后记忆库仍未变', Object.keys(third).length, Object.keys(before).length);

// --- 9. 样本规模合理性 ---
section('样本规模建议');
const suggest = sampler.planSample(cards, { strategy: 'random', count: 20, seed: 1 });
ok('小库抽 20 条即全量', suggest.target === cards.length);
const bigPalacePlan = sampler.planSample(cards, { strategy: 'stratified', ratio: 0.1, seed: 1 });
ok('大库按比例抽样合理', bigPalacePlan.target === Math.ceil(cards.length * 0.1));

// --- 清理 ---
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));
if (fail) {
  console.log('\n失败详情:');
  failures.forEach((f) => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
}
process.exit(fail ? 1 : 0);
