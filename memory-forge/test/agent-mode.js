'use strict';
/**
 * Agent 驱动模式测试。
 * 运行： node test/agent-mode.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const agentmode = require('../src/engine/agentmode');
const parser = require('../src/engine/parser');
const merge = require('../src/engine/merge');
const { normalizeCard, renderCard } = require('../src/engine/schema');
const { loadPalace } = require('../src/engine/palace');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-'));

// --- 1. 容错解析 ---------------------------------------------------------
section('agent 输出容错解析');

function mk(chunks) {
  const recs = parser.parseContent('notes.md',
    '# 用户偏好\n\n用户偏好结论先行，不要铺垫。\n\n# 环境\n\n机器是 Windows 11。\n')
    .records;
  return parser.chunkRecords(recs, { budget: 400 });
}

const chunks = mk();
const taskDir = path.join(tmp, 'task1');
const pkg = agentmode.writeTaskPackage(taskDir, {
  chunks,
  meta: { sourceDesc: '测试文件', style: 'auto', existingSlots: ['user::reply_style — 旧偏好'] },
});

ok('任务包目录已生成', fs.existsSync(taskDir));
ok('manifest 存在', fs.existsSync(path.join(taskDir, agentmode.MANIFEST)));
ok('INSTRUCTIONS 存在', fs.existsSync(path.join(taskDir, agentmode.INSTRUCTIONS)));
ok('chunks 目录存在', fs.existsSync(path.join(taskDir, agentmode.CHUNKS_DIR)));
ok('results 目录存在', fs.existsSync(path.join(taskDir, agentmode.RESULTS_DIR)));
ok('ALL.md 存在（便于一次读完）', fs.existsSync(path.join(taskDir, agentmode.ALL_MD)));

const manifest = JSON.parse(fs.readFileSync(path.join(taskDir, agentmode.MANIFEST), 'utf8'));
ok('manifest 标记为 agent 模式', manifest.mode === 'agent');
ok('manifest 记录分块数', manifest.chunks.length === chunks.length);
ok('manifest 携带已有 slot 提示', manifest.existingSlots.length === 1);

// 纯元信息分块应被标记 skippable
const metaOnly = chunks.find((c) => c.records.every((r) => r.kind === 'file-meta'));
if (metaOnly) {
  const idx = chunks.indexOf(metaOnly);
  ok('纯元信息分块标记为可跳过', manifest.chunks[idx].skippable === true);
}

const instr = fs.readFileSync(path.join(taskDir, agentmode.INSTRUCTIONS), 'utf8');
ok('指令说明无需配置模型', /不需要配置任何模型/.test(instr));
ok('指令包含 predicate 规则', /predicate/.test(instr) && /snake_case/.test(instr));
ok('指令包含正例', /## 正例/.test(instr));
ok('指令包含反例', /## 反例/.test(instr));
ok('指令包含中文触发词要求', /aliases/.test(instr) && /中文触发词/.test(instr));
ok('指令列出了分块清单', /待处理分块/.test(instr));
ok('指令含已有 slot 提示', /user::reply_style/.test(instr));
ok('指令要求只输出 JSON', /只输出 JSON/.test(instr));

// --- 2. 结果容错 ---------------------------------------------------------
section('结果文件容错解析');

function writeResult(baseName, content) {
  fs.writeFileSync(path.join(taskDir, agentmode.RESULTS_DIR, `${baseName}.result.json`), content, 'utf8');
}

const first = manifest.chunks[0].baseName;

// 围栏 + 前后解释文字
writeResult(first, `这是抽取结果：\n\`\`\`json\n{"cards":[{"type":"preference","title":"偏好结论先行","subject":"user","predicate":"reply_style","value":"结论先行","body":"","confidence":0.9,"importance":0.6,"tags":["comm"],"aliases":["风格"]}]}\n\`\`\`\n以上。`);
let r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('围栏+解释文字可解析', !r.error && r.cards.length === 1);
ok('卡片字段正确', r.cards[0] && r.cards[0].predicate === 'reply_style');

// 直接输出数组
writeResult(first, `[{"type":"lesson","title":"先搜索再问","subject":"lesson:a","predicate":"why","value":"用检索替代提问","body":"","confidence":0.9,"importance":0.8}]`);
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('纯数组格式可解析', !r.error && r.cards.length === 1);

// 空结果
writeResult(first, '{"cards": []}');
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('空数组是合法结果', !r.error && r.cards.length === 0);

// 完全非法
writeResult(first, '这不是 JSON');
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('非法内容被明确报错', !!r.error);

// 字段别名
writeResult(first, JSON.stringify({ cards: [{
  category: 'preference', name: '偏好精简', content: '内容放 body',
  slot: 'user::verbosity', value: '精简',
}] }));
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('category→type 别名生效', r.cards[0] && r.cards[0].type === 'preference', r.cards[0] && r.cards[0].type);
ok('name→title 别名生效', r.cards[0] && r.cards[0].title === '偏好精简');
ok('content→body 别名生效', r.cards[0] && r.cards[0].body === '内容放 body');
ok('slot 拆回 subject/predicate', r.cards[0] && r.cards[0].subject === 'user' && r.cards[0].predicate === 'verbosity');

// 中文类型标签
writeResult(first, JSON.stringify({ cards: [{
  type: '偏好', title: '中文类型', subject: 'user', predicate: 'lang', value: '中文',
}] }));
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('中文类型标签被归一', r.cards[0] && r.cards[0].type === 'preference', r.cards[0] && r.cards[0].type);

// 逗号分隔的字符串 tags
writeResult(first, JSON.stringify({ cards: [{
  type: 'lesson', title: '标签测试', subject: 'lesson:a', predicate: 'p', value: 'v',
  tags: 'a, b、c', aliases: '中文一, 中文二',
}] }));
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('字符串 tags 被拆成数组', Array.isArray(r.cards[0].tags) && r.cards[0].tags.length === 3);
ok('字符串 aliases 被拆成数组', Array.isArray(r.cards[0].aliases) && r.cards[0].aliases.length === 2);

// 缺必填字段
writeResult(first, JSON.stringify({ cards: [{ type: 'lesson', body: '没有 subject' }] }));
r = agentmode.readResultFile(path.join(taskDir, agentmode.RESULTS_DIR, `${first}.result.json`), manifest.chunks[0]);
ok('缺必填字段被过滤', r.cards.length === 0 && r.rejected.length === 1);

// --- 3. 进度与导入 -------------------------------------------------------
section('进度追踪与导入');

// 用一个全新的任务包测"未提交"状态 —— 前面已向 task1 写过结果
const taskDir0 = path.join(tmp, 'task0');
agentmode.writeTaskPackage(taskDir0, { chunks, meta: { sourceDesc: '进度测试' } });
const st0 = agentmode.taskStatus(taskDir0);
ok('未提交时进度为 0', st0.ok && st0.done === 0, `got ${st0 && st0.done}`);
ok('未提交块标记为 missing', st0.chunks.every((c) => c.state === 'missing'));
ok('未提交时能拿到总块数', st0.total === chunks.length);

manifest.chunks.forEach((c, i) => {
  writeResult(c.baseName, JSON.stringify({ cards: [
    { type: 'preference', title: `卡${i}-A`, subject: 'user', predicate: `p${i}`, value: `值${i}`, body: '' },
    { type: 'lesson', title: `卡${i}-B`, subject: 'lesson:x', predicate: `q${i}`, value: `值${i}B`, body: '' },
  ] }));
});

const st1 = agentmode.taskStatus(taskDir);
ok('全部提交后进度 100%', st1.ok && st1.done === st1.total && st1.percent === 100);

const imp = agentmode.importResults(taskDir);
ok('导入成功', imp.ok);
ok('卡片总数正确', imp.cards.length === manifest.chunks.length * 2, `got ${imp.cards.length}`);
ok('进度信息完整', imp.progress.total === manifest.chunks.length);

// 部分提交
const taskDir2 = path.join(tmp, 'task2');
const pkg2 = agentmode.writeTaskPackage(taskDir2, { chunks, meta: { sourceDesc: '部分' } });
const m2 = JSON.parse(fs.readFileSync(path.join(taskDir2, agentmode.MANIFEST), 'utf8'));
fs.writeFileSync(path.join(taskDir2, agentmode.RESULTS_DIR, `${m2.chunks[0].baseName}.result.json`),
  '{"cards":[{"type":"lesson","title":"唯一","subject":"lesson:a","predicate":"p","value":"v"}]}');

const imp2 = agentmode.importResults(taskDir2);
ok('部分提交也能导入', imp2.ok);
ok('进度显示未完成', imp2.progress.done === 1 && imp2.progress.missing === m2.chunks.length - 1);
ok('未完成分块不影响已完成的导入', imp2.cards.length === 1);

// 无效任务包
const bad = agentmode.importResults(tmp);
ok('非任务包目录被拒绝', !bad.ok && /未找到/.test(bad.error));

// 版本不匹配
const taskDir3 = path.join(tmp, 'task3');
agentmode.writeTaskPackage(taskDir3, { chunks, meta: {} });
const mf3 = path.join(taskDir3, agentmode.MANIFEST);
const j3 = JSON.parse(fs.readFileSync(mf3, 'utf8'));
j3.specVersion = 999;
fs.writeFileSync(mf3, JSON.stringify(j3, null, 2));
const imp3 = agentmode.importResults(taskDir3);
ok('版本不匹配被拒绝并提示重建', !imp3.ok && /版本/.test(imp3.error));

// --- 4. 与既有管线一致 ---------------------------------------------------
section('下游管线一致性');

const cards = imp.cards;
const dd = merge.dedupe(cards);
const conflicts = merge.findInternalConflicts(dd.kept);
ok('去重可运行', Array.isArray(dd.kept));
ok('冲突检测可运行', Array.isArray(conflicts));

// 制造冲突：同 slot 两个不同 value
const conflictDir = path.join(tmp, 'task4');
agentmode.writeTaskPackage(conflictDir, { chunks, meta: {} });
const m4 = JSON.parse(fs.readFileSync(path.join(conflictDir, agentmode.MANIFEST), 'utf8'));
m4.chunks.forEach((c, i) => {
  fs.writeFileSync(path.join(conflictDir, agentmode.RESULTS_DIR, `${c.baseName}.result.json`),
    JSON.stringify({ cards: [
      { type: 'preference', title: `冲突${i}`, subject: 'user', predicate: 'reply_language',
        value: i % 2 === 0 ? '中文' : '英文', body: '' },
    ] }));
});
const imp4 = agentmode.importResults(conflictDir);
const cf4 = merge.findInternalConflicts(imp4.cards);
ok('检出 agent 产出中的 slot 冲突', cf4.length === 1 && cf4[0].slot === 'user::reply_language');
ok('真冲突不自动裁决', cf4[0].suggestion.action === 'escalate');

// 与已有记忆库对比
const palaceDir = path.join(tmp, 'palace');
fs.mkdirSync(path.join(palaceDir, 'cards', 'preference'), { recursive: true });
fs.writeFileSync(path.join(palaceDir, 'cards', 'preference', 'mem_00001-old.md'),
  renderCard(normalizeCard({ type: 'preference', title: '旧偏好', subject: 'user',
    predicate: 'reply_style', value: '结论先行' }, {}), 'mem_00001'), 'utf8');

const baseline = loadPalace(palaceDir).cards;
// 用与基线相同 slot 的卡片验证「识别一致」
const aligned = imp.cards.map((c) => ({
  ...c,
  subject: 'user',
  predicate: 'reply_style',
  value: '结论先行',
}));
const cmp = merge.compareWithBaseline(aligned, baseline);
ok('agent 产出也能与基线对比', Array.isArray(cmp.conflicts));
ok('识别出与基线一致的记忆', cmp.conflicts.some((c) => c.kind === 'identical'),
  JSON.stringify(cmp.conflicts.map((c) => c.kind)));

// --- 5. ID 分配与写盘 ---------------------------------------------------
section('ID 分配与写盘');

const base = loadPalace(palaceDir);
const assigned = merge.assignIds(dd.kept, (base.maxSeq || 0) + 1, base.ids);
ok('分配的 ID 不与已有冲突', assigned.every((x) => !base.ids.has(x.id)));
ok('ID 从 seq+1 开始', assigned[0].id === 'mem_00002');

const finalCards = assigned.map((x) => ({ ...x.card, id: x.id }));
const check = merge.finalCheck(finalCards);
ok('agent 产出通过最终校验', check.rejected.length === 0,
  JSON.stringify(check.rejected.slice(0, 2)));

let written = 0;
finalCards.forEach((c) => {
  const dir = path.join(palaceDir, 'cards', c.type);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${c.id}-${'x'}.md`), renderCard(c, c.id), 'utf8');
  written++;
});
ok('全部写入成功', written === finalCards.length);

const reloaded = loadPalace(palaceDir);
ok('palace 可读回', reloaded.cards.length === finalCards.length + 1);
ok('无结构问题', reloaded.problems.length === 0, JSON.stringify(reloaded.problems));

// --- 6. 只读保证 ---------------------------------------------------------
section('只读保证');

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    });
  };
  walk(dir);
  return out;
}

const beforePalace = snapshot(palaceDir);
// 生成任务包、查进度、导入 —— 都不该动记忆库
agentmode.writeTaskPackage(path.join(tmp, 'readonly-task'), { chunks, meta: {} });
agentmode.taskStatus(taskDir);
agentmode.taskStatus(taskDir2);
agentmode.importResults(taskDir);
agentmode.importResults(taskDir2);
const afterPalace = snapshot(palaceDir);

ok('任务包流程未改动记忆库',
  Object.keys(beforePalace).length === Object.keys(afterPalace).length
  && Object.keys(beforePalace).every((k) => beforePalace[k] === afterPalace[k]));

// --- 7. 指令质量 ---------------------------------------------------------
section('指令内容质量');

const instr2 = agentmode.buildInstructions({ sourceDesc: 'X', style: 'technical' });
ok('按侧重调整指令', /本次重点关注：.*环境配置.*技术栈/.test(instr2));
const instrPref = agentmode.buildInstructions({ sourceDesc: 'X', style: 'preference' });
ok('preference 侧重生效', /本次重点关注：.*用户偏好.*身份/.test(instrPref));
const instrNone = agentmode.buildInstructions({});
ok('无参数时不报错', typeof instrNone === 'string' && instrNone.length > 500);
ok('无已有 slot 时不出现该段落', !/已有记忆的 slot（除非/.test(instrNone.split('## 正例')[0]));

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));
if (fail) {
  console.log('\n失败详情:');
  failures.forEach((f) => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
}
process.exit(fail ? 1 : 0);
