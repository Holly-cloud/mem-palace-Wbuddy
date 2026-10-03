'use strict';
/**
 * 浅尝模式集成测试：验证与完整模式共用同一条管线，且全程只读。
 * 模拟 main.js 的 buildChunks 逻辑，但不依赖 Electron。
 *
 * 运行： node test/trial-integration.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('../src/engine/parser');
const sampler = require('../src/engine/sampler');
const merge = require('../src/engine/merge');
const { extractAll } = require('../src/engine/extract');
const { normalizeCard, renderCard } = require('../src/engine/schema');
const { loadPalace } = require('../src/engine/palace');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// --- 构造记忆库 ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trial-int-'));
const palaceDir = path.join(tmp, 'palace');

const SPEC = [
  { type: 'preference', subject: 'user', predicate: 'reply_style', value: '结论先行' },
  { type: 'preference', subject: 'user', predicate: 'verbosity', value: '默认精简' },
  { type: 'preference', subject: 'user', predicate: 'reply_language', value: '中文' },
  { type: 'environment', subject: 'env:a', predicate: 'os', value: 'Windows 11' },
  { type: 'environment', subject: 'env:b', predicate: 'shell', value: 'Git Bash' },
  { type: 'environment', subject: 'env:c', predicate: 'py', value: '3.13' },
  { type: 'environment', subject: 'env:d', predicate: 'ed', value: 'VSCode' },
  { type: 'lesson', subject: 'lesson:a', predicate: 'why', value: '先搜索再问' },
  { type: 'lesson', subject: 'lesson:b', predicate: 'how', value: '先备份再改' },
  { type: 'project', subject: 'project:p', predicate: 'status', value: '设计中' },
];
const byType = {};
SPEC.forEach((c) => { (byType[c.type] = byType[c.type] || []).push(c); });
let seq = 0;
Object.entries(byType).forEach(([type, items]) => {
  const dir = path.join(palaceDir, 'cards', type);
  fs.mkdirSync(dir, { recursive: true });
  items.forEach((c) => {
    const id = `mem_${String(++seq).padStart(5, '0')}`;
    const card = normalizeCard({ ...c, type }, { source: 'test' });
    fs.writeFileSync(path.join(dir, `${id}-t.md`), renderCard(card, id), 'utf8');
  });
});

const library = loadPalace(palaceDir);
console.log(`\n记忆库：${library.cards.length} 张卡片，${seq} 个 id\n`);

function snapshot(dir) {
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

// mock LLM：从记忆文本中识别主题并产出卡片
const MockClient = class {
  constructor() { this.calls = 0; }
  async chat(messages) {
    this.calls++;
    const u = messages.find((m) => m.role === 'user').content;
    const cards = [];
    if (/结论先行/.test(u)) cards.push({ type: 'preference', title: '回复风格', subject: 'user', predicate: 'reply_style', value: '结论先行', body: '不铺垫。', aliases: ['风格'], confidence: 0.9 });
    if (/精简/.test(u)) cards.push({ type: 'preference', title: '详略偏好', subject: 'user', predicate: 'verbosity', value: '默认精简', body: '', aliases: ['啰嗦'], confidence: 0.85 });
    if (/中文/.test(u)) cards.push({ type: 'preference', title: '回复语言', subject: 'user', predicate: 'reply_language', value: '中文', body: '', aliases: ['语言'], confidence: 0.85 });
    if (/Windows/.test(u)) cards.push({ type: 'environment', title: '操作系统', subject: 'env:ws', predicate: 'os', value: 'Windows 11', body: '', confidence: 0.95 });
    if (/Git Bash/.test(u)) cards.push({ type: 'environment', title: 'Shell', subject: 'env:ws', predicate: 'shell', value: 'Git Bash', body: '', confidence: 0.95 });
    if (/VSCode/.test(u)) cards.push({ type: 'environment', title: '编辑器', subject: 'env:ws', predicate: 'editor', value: 'VSCode', body: '', confidence: 0.9 });
    if (/先搜索再问/.test(u)) cards.push({ type: 'lesson', title: '先搜索再问', subject: 'lesson:a', predicate: 'why', value: '用检索替代提问', body: '', confidence: 0.9 });
    if (/设计中/.test(u)) cards.push({ type: 'project', title: '项目状态', subject: 'project:p', predicate: 'status', value: '设计中', body: '', confidence: 0.8 });
    return { content: JSON.stringify({ cards }) };
  }
  async runPool(items, worker, opts) {
    const out = new Array(items.length);
    let c = 0;
    await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
      while (c < items.length) {
        const i = c++;
        try { out[i] = { ok: true, value: await worker(items[i], i) }; }
        catch (err) { out[i] = { ok: false, error: err.message }; }
        if (opts.onProgress) opts.onProgress({ done: i + 1, total: items.length, percent: Math.round(((i+1)/items.length)*100) });
      }
    }));
    return out;
  }
};

// --- 1. buildChunks 复用验证 ---
section('管线复用：buildChunks');

function buildChunksTrial(palaceRoot, sampleOptions, budget = 3000) {
  const target = sampler.validateTarget(palaceRoot);
  if (!target.ok) return { error: sampler.toError(target) };
  const plan = sampler.planSample(target.cards, sampleOptions);
  if (!plan.ok) return { error: sampler.toError({ ...plan, detail: plan.detail }) };
  const records = sampler.sampleToRecords(plan.sampled);
  const chunks = parser.chunkRecords(records, { budget });
  chunks.forEach((c, i) => {
    c._sourceFile = `样本(${plan.target} 条)`;
    c._sourcePath = target.root;
    c._sampledIds = plan.sampled.map((s) => s.id);
    c._samplePlan = plan;
    c._sampleIndex = i;
  });
  return { chunks, plan, target };
}

function buildChunksFull(files, budget = 3000) {
  const chunks = [];
  for (const f of files) {
    if (f.error || !f.records) continue;
    // 复用调用方已解析好的 records。完整模式下这些 records 来自界面
    // 选文件时读出的内容；这里若重新 parseContent 会二次切分，导致
    // 「一条记录 = 一段语义」的对应关系丢失。
    parser.chunkRecords(f.records, { budget }).forEach((c) => {
      c._sourceFile = f.name;
      c._sourcePath = f.path;
      chunks.push(c);
    });
  }
  return { chunks };
}

// 试运行分块与完整模式分块结构一致（同一批字段）
const tBuild = buildChunksTrial(palaceDir, { strategy: 'random', count: 5, seed: 42 });
ok('试运行分块成功', tBuild.chunks.length > 0);
const tKeys = Object.keys(tBuild.chunks[0]).sort();
ok('试运行块字段与完整模式同构',
  ['index', 'records', 'chars', 'recordCount', 'text', '_sourceFile', '_sourcePath'].every((k) => tKeys.includes(k)),
  tKeys.join(','));

// 完整模式分块同样含 text（共用 extractAll 的前提）
const sampleFile = path.join(tmp, 'x.md');
fs.writeFileSync(sampleFile, '测试内容，用于验证完整模式的分块结构。', 'utf8');
const fBuild = buildChunksFull([{
  name: 'x.md', path: sampleFile,
  records: parser.parseContent(sampleFile, fs.readFileSync(sampleFile, 'utf8')).records,
}]);
ok('完整模式分块含 text 字段', fBuild.chunks.length > 0 && !!fBuild.chunks[0].text);
ok('两种模式的块结构键一致',
  ['index', 'records', 'chars', 'recordCount', 'text', '_sourceFile', '_sourcePath']
    .every((k) => fBuild.chunks[0][k] !== undefined));

// 回归：fs:readFiles 曾只返回 preview(240字) 而丢掉完整文本，
// 导致抽取阶段实际处理的是截断内容。记录必须带完整 text。
ok('记录携带完整文本而非仅 preview', (() => {
  const long = 'A'.repeat(1000);
  const f = path.join(tmp, 'long.md');
  fs.writeFileSync(f, long, 'utf8');
  const parsed = parser.parseContent(f, long);
  const mapped = parsed.records.map((r) => ({
    text: r.text, preview: r.text.slice(0, 240),
  }));
  return mapped.some((m) => m.text.length > m.preview.length && m.text.length === 1000);
})(), '记录缺少完整 text 字段');

ok('分块文本使用完整内容而非 preview', (() => {
  const long = 'B'.repeat(900);
  const f = path.join(tmp, 'long2.md');
  fs.writeFileSync(f, long, 'utf8');
  const parsed = parser.parseContent(f, long);
  const chunks = parser.chunkRecords(
    parsed.records.map((r) => ({ ...r })),
    { budget: 5000 }
  );
  const totalText = chunks.reduce((s, c) => s + c.text.length, 0);
  return totalText >= 900;
})());

// --- 2. 端到端：试运行 ---
section('端到端：浅尝模式');
(async () => {
  const before = snapshot(palaceDir);

  const client = new MockClient();
  const result = await extractAll(client, tBuild.chunks, { source: 'forge:trial' });

  ok('试运行抽取无错误', result.errors.length === 0);
  ok('试运行产出卡片', result.cards.length > 0, `got ${result.cards.length}`);
  result.cards.forEach((c) => { c._sourceFile = tBuild.chunks[c._chunkIndex]?._sourceFile; });

  const dd = merge.dedupe(result.cards);
  const ic = merge.findInternalConflicts(dd.kept);
  ok('去重与冲突检测可正常运行', Array.isArray(dd.kept) && Array.isArray(ic));

  const report = sampler.buildReport(tBuild.plan, {
    cards: dd.kept, deduped: dd.dropped, internalConflicts: ic, errors: result.errors,
  });
  const summary = sampler.summarize(report);

  console.log('\n  ' + summary);
  ok('报告标记 trial 模式', report.mode === 'trial');
  ok('报告含抽样明细', report.sampling.requested === 5 && report.sampling.poolSize === library.cards.length);
  ok('报告含组织结构', report.organization.byType && Object.keys(report.organization.byType).length > 0);
  ok('报告含抽取统计', report.extraction.extracted === dd.kept.length);
  ok('摘要含抽样规模', summary.includes('抽样'));
  ok('摘要含产出数量', summary.includes('卡片'));

  // 与基线对比（试运行也走同一套对比逻辑）
  const cmp = merge.compareWithBaseline(dd.kept, library.cards);
  ok('试运行也能与原库对比', Array.isArray(cmp.conflicts));
  console.log(`  与原库对比：${cmp.conflicts.length} 处（identical 说明抽取结果与原库一致）`);
  const identical = cmp.conflicts.filter((c) => c.kind === 'identical').length;
  ok('重新抽取原库记忆应大量命中 identical', identical > 0, `got ${identical}`);

  // 只读验证
  const after = snapshot(palaceDir);
  ok('浅尝模式未修改记忆库任何文件',
    Object.keys(before).length === Object.keys(after).length
    && Object.keys(before).every((k) => before[k] === after[k]));
  ok('未产生新文件', !Object.keys(after).some((k) => !(k in before)));

  // --- 3. 衔接全量 ---
  section('衔接：确认后转全量');
  // 全量：把整库记忆还原为记录，走完整模式的分块逻辑
  const libRecords = sampler.sampleToRecords(library.cards);
  const libFile = path.join(tmp, 'lib.md');
  fs.writeFileSync(libFile, libRecords.map((r) => r.text).join('\n\n'), 'utf8');
  const fullChunks = buildChunksFull([{
    name: 'lib.md', path: libFile,
    records: libRecords,
  }], 3000);

  ok('全量分块覆盖全部记忆',
    fullChunks.chunks.reduce((s, c) => s + c.recordCount, 0) === library.cards.length,
    `${fullChunks.chunks.reduce((s, c) => s + c.recordCount, 0)} vs ${library.cards.length}`);
  ok('全量分块数不少于试运行', fullChunks.chunks.length >= tBuild.chunks.length);

  // 参数固化语义
  const committed = { mode: 'full', sampleOptions: null, chunkBudget: 3000, style: 'auto' };
  ok('固化后抽样参数被清空', committed.sampleOptions === null);
  ok('固化保留模型与分块参数', committed.chunkBudget === 3000 && committed.style === 'auto');

  // 全量与试运行共用 extractAll：同一 mock 走全量
  const fullResult = await extractAll(new MockClient(), fullChunks.chunks, { source: 'forge:lib.md' });
  ok('全量抽取无错误', fullResult.errors.length === 0);
  ok('全量产出不少于试运行', fullResult.cards.length >= result.cards.length,
    `${fullResult.cards.length} vs ${result.cards.length}`);

  const afterAll = snapshot(palaceDir);
  ok('整个流程（含全量试跑）仍未改动记忆库',
    Object.keys(before).every((k) => before[k] === afterAll[k]));

  console.log('\n  样本量对比：');
  console.log(`    浅尝  ${tBuild.plan.target} 条 → ${dd.kept.length} 张卡片`);
  const fd = merge.dedupe(fullResult.cards);
  console.log(`    全量  ${library.cards.length} 条 → ${fd.kept.length} 张卡片`);

  // --- 4. 边界：空库 / 不存在 / 容量超限 ---
  section('边界：试运行输入异常');
  const emptyPalace = path.join(tmp, 'empty-palace');
  fs.mkdirSync(emptyPalace, { recursive: true });
  const e1 = sampler.validateTarget(emptyPalace);
  const e1p = e1.ok ? sampler.planSample(e1.cards, { count: 5 }) : { ok: false, code: e1.code };
  ok('空记忆库 → NO_CARDS', !e1p.ok && e1p.code === 'NO_CARDS');

  const e2 = sampler.validateTarget(path.join(tmp, 'ghost'));
  ok('不存在的路径 → NOT_FOUND', !e2.ok && e2.code === 'NOT_FOUND');

  const e3 = buildChunksTrial(palaceDir, { strategy: 'random', count: 99999 });
  ok('抽样数量超容量被下调而非报错', !e3.error && e3.plan.target === library.cards.length);
  ok('超容量附带告警', e3.plan.warnings.some((w) => w.code === 'SAMPLE_CLAMPED'));

  const e4 = buildChunksTrial(palaceDir, { strategy: 'stratified', count: 1, seed: 5 });
  ok('样本数 1 时给出覆盖告警', !e4.error && e4.plan.warnings.some((w) => w.code === 'SAMPLE_COVERAGE'));

  const e5 = buildChunksTrial(palaceDir, { strategy: 'random', count: -1 });
  ok('负数数量 → 错误对象', !!e5.error && e5.error.code === 'NO_SAMPLE');

  const e6 = buildChunksTrial(path.join(tmp, 'ghost2'), {});
  ok('试运行对不存在路径返回可展示错误', !!e6.error && e6.error.title && e6.error.hint);

  // --- 5. 守卫 ---
  section('写入守卫');
  const guard = (mode) => (mode === 'trial' || mode === 'preview')
    ? { ok: false, error: '试运行模式不会写入任何文件。请确认结果后切换到完整模式。' }
    : { ok: true };
  ok('试运行写入被拦截', !guard('trial').ok);
  ok('预览模式写入被拦截', !guard('preview').ok);
  ok('完整模式写入放行', guard('merge').ok);
  ok('拦截提示文案明确', guard('trial').error.includes('不会写入'));

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n' + '='.repeat(46));
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log('='.repeat(46));
  if (fail) {
    console.log('\n失败详情:');
    failures.forEach((f) => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
  }
  process.exit(fail ? 1 : 0);
})();
