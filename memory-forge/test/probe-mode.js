'use strict';
/**
 * 探查模式（Probe）测试。
 * 运行： node test/probe-mode.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const probe = require('../src/engine/probe');
const splitter = require('../src/engine/splitByRecipe');
const parser = require('../src/engine/parser');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-probe-'));

// --- 样本文件 -----------------------------------------------------------
const SAMPLES = {
  'codex.jsonl': [
    '{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我重构记忆模块"}]}',
    '{"type":"function_call","name":"read_file","arguments":{"path":"src/index.js"}}',
    '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已读取文件"}]}',
  ].join('\n'),

  'chat-export.json': JSON.stringify([
    { role: 'user', content: '我偏好结论先行', timestamp: '2026-09-01T10:00:00Z' },
    { role: 'assistant', content: '明白', timestamp: '2026-09-01T10:00:05Z' },
  ], null, 2),

  'memories.csv': [
    'type,subject,content',
    'preference,user.reply_style,结论先行',
    'environment,env.os,Windows 11',
  ].join('\n'),

  'settings.yaml': [
    'user:',
    '  name: Holly',
    '  prefs:',
    '    - 精简',
    'env:',
    '  os: Windows 11',
  ].join('\n'),

  'notes.md': '# 偏好\n\n用户偏好精简。\n\n# 环境\n\n机器是 Windows。',

  'app.log': [
    '[2026-09-01 10:00:00] INFO 用户登录',
    '[2026-09-01 10:00:05] ERROR 密码错误',
  ].join('\n'),

  'chat.txt': [
    'User: 我喜欢详细的回答',
    'Assistant: 好的',
    'User: 另外机器是 Mac',
  ].join('\n'),
};

const filePaths = {};
Object.entries(SAMPLES).forEach(([name, content]) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, 'utf8');
  filePaths[name] = p;
});

// --- 1. 结构探测 ---------------------------------------------------------
section('结构探测');

const codexStats = probe.analyzeStructure(SAMPLES['codex.jsonl']);
ok('识别 JSONL（逐行合法 JSON）', codexStats.jsonLineRate > 0.8, `rate=${codexStats.jsonLineRate}`);
ok('检测到嵌套内容数组', codexStats.nestedContentLines === 2, `got ${codexStats.nestedContentLines}`);
ok('识别对话角色', codexStats.roleMarkers.role_user === 1 && codexStats.roleMarkers.role_assistant === 1);

const chatStats = probe.analyzeStructure(SAMPLES['chat-export.json']);
ok('识别 ChatGPT 的 mapping 结构', chatStats.roleMarkers.chatgpt_mapping > 0
  || chatStats.roleMarkers.role_user > 0);

const csvStats = probe.analyzeStructure(SAMPLES['memories.csv']);
ok('识别 CSV', csvStats.csvLike === true, JSON.stringify({csv:csvStats.csvLike, cols:csvStats.csvColumns}));

const yamlStats = probe.analyzeStructure(SAMPLES['settings.yaml']);
ok('识别 YAML 顶层键', yamlStats.yamlLikeKeys >= 2, `got ${yamlStats.yamlLikeKeys}`);
ok('识别缩进结构', yamlStats.indentedRatio > 0.2);

const logStats = probe.analyzeStructure(SAMPLES['app.log']);
ok('识别日志时间戳', logStats.timestampRatio > 0.8, `got ${logStats.timestampRatio}`);

const mdStats = probe.analyzeStructure(SAMPLES['notes.md']);
ok('识别 Markdown 标题', mdStats.headingCount === 2);

const s = probe.sampleFile(filePaths['codex.jsonl']);
ok('采样含头部内容', s.head.includes('帮我重构'));
ok('采样含结构统计', typeof s.jsonLineRate === 'number');
ok('采样给出规则猜测', s.ruleGuess === 'jsonl');

// --- 2. 路径取值 ---------------------------------------------------------
section('JSON 路径取值');

const obj = { role: 'user', content: [{ type: 'input_text', text: '内容A' }], tags: ['x', 'y'], meta: { k: 'v' } };
eq('顶层字符串', probe.pickPath(obj, 'role'), 'user');
eq('显式展开数组取 text', probe.pickPath(obj, 'content[].text'), '内容A');
eq('数组整体取（拼接）', probe.pickPath(obj, 'tags'), 'x\ny');
eq('嵌套对象', probe.pickPath(obj, 'meta.k'), 'v');
eq('不存在返回 null', probe.pickPath(obj, 'a.b.c'), null);

const multi = { content: [{ text: '一' }, { text: '二' }, { text: '三' }] };
eq('多元素合并', probe.pickPath(multi, 'content[].text'), '一\n二\n三');
eq('content 是字符串时也能取', probe.pickPath({ content: '纯文本' }, 'content'), '纯文本');
eq('数组元素无 text 时退化为 JSON',
  probe.pickPath({ c: [{ x: 1 }] }, 'c[].text'), '{"x":1}');

// --- 3. 配方切分 ---------------------------------------------------------
section('配方驱动切分');

// Codex JSONL —— 核心用例：内容藏在 content[].text
const codexRecipe = {
  strategy: 'jsonl',
  fields: { 角色: 'role', 内容: 'content[].text' },
  includeMeta: ['type'],
};
const codexRes = splitter.splitByRecipe(filePaths['codex.jsonl'], codexRecipe);
ok('切出 3 条记录', codexRes.records.length === 3, `got ${codexRes.records.length}`);
const codexText = codexRes.records.map((r) => r.text).join('\n');
ok('★ 保留嵌套内容（规则解析会丢）', codexText.includes('帮我重构记忆模块'));
ok('保留角色', codexText.includes('user'));
ok('无切分告警', codexRes.warnings.length === 0, JSON.stringify(codexRes.warnings));

// 与规则解析对比 —— 这是探查存在的理由
const ruleCodex = parser.parseContent('codex.jsonl', SAMPLES['codex.jsonl'])
  .records.filter((r) => r.kind !== 'file-meta').map((r) => r.text).join('\n');
const ruleHasContent = ruleCodex.includes('帮我重构记忆模块');
ok('对比：规则解析能取到嵌套内容（本轮已增强）', ruleHasContent === true,
  `规则解析取到=${ruleHasContent}`);

// 对话导出
const chatRes = splitter.splitByRecipe(filePaths['chat-export.json'], {
  strategy: 'json_array', fields: { 角色: 'role', 内容: 'content' }, includeMeta: ['timestamp'],
});
ok('对话导出切出 2 条', chatRes.records.length === 2);
ok('保留角色标签', chatRes.records[0].text.includes('user'));
ok('保留时间戳', chatRes.records[0].text.includes('timestamp'));

// CSV —— 表头只作字段名来源，不产出记录
const csvRes = splitter.splitByRecipe(filePaths['memories.csv'], { strategy: 'csv', fields: {} });
ok('CSV 切出 2 行数据（不含表头）', csvRes.records.length === 2, `got ${csvRes.records.length}`);
ok('CSV 用表头做字段名', csvRes.records[0].text.includes('subject: user.reply_style'));
ok('CSV 不产出表头记录', !csvRes.records.some((r) => r.text.startsWith('表头:')));

// CSV 带引号与内嵌逗号
fs.writeFileSync(path.join(tmp, 'quoted.csv'), 'a,b\n"含,逗号","含""引号"', 'utf8');
const qRes = splitter.splitByRecipe(path.join(tmp, 'quoted.csv'), { strategy: 'csv', fields: {} });
ok('CSV 处理引号内逗号', qRes.records[0].text.includes('含,逗号'), qRes.records[0].text);
ok('CSV 处理转义引号', qRes.records[0].text.includes('含"引号'));

// TSV
fs.writeFileSync(path.join(tmp, 't.tsv'), 'x\ty\n1\t2', 'utf8');
const tRes = splitter.splitByRecipe(path.join(tmp, 't.tsv'), { strategy: 'csv', fields: {} });
ok('CSV 策略兼容 TSV', tRes.records.length === 1 && tRes.records[0].text.includes('x: 1'));

// YAML
const yamlRes = splitter.splitByRecipe(filePaths['settings.yaml'], { strategy: 'yaml', fields: {} });
ok('YAML 切出 2 段', yamlRes.records.length === 2, `got ${yamlRes.records.length}`);
ok('YAML 标注顶层键', yamlRes.records[0].section === 'user');
ok('YAML 保留嵌套内容', yamlRes.records[0].text.includes('Holly'));

// Markdown / 日志 / 空行 / 整文件
ok('Markdown 按标题切', splitter.splitByRecipe(filePaths['notes.md'], { strategy: 'markdown' }).records.length === 2);
ok('日志按时间戳切', splitter.splitByRecipe(filePaths['app.log'], { strategy: 'log' }).records.length === 2);
ok('空行分段', splitter.splitByRecipe(filePaths['notes.md'], { strategy: 'blank_line' }).records.length >= 2);
const whole = splitter.splitByRecipe(filePaths['notes.md'], { strategy: 'whole' });
ok('整文件作为一条', whole.records.length === 1 && whole.records[0].text.includes('偏好精简'));

// 对话（纯文本角色前缀）
const convRes = splitter.splitByRecipe(filePaths['chat.txt'], {
  strategy: 'conversation', separator: 'User:|Assistant:',
});
ok('对话按角色切分', convRes.records.length === 3, `got ${convRes.records.length}`);
ok('对话保留角色名', convRes.records[0].text.includes('User:'));
ok('对话合并同角色连续内容', convRes.records[0].text.includes('喜欢详细的回答'));

// 自定义分隔符
fs.writeFileSync(path.join(tmp, 'sep.txt'), 'A部分\n---\nB部分\n---\nC部分', 'utf8');
const sepRes = splitter.splitByRecipe(path.join(tmp, 'sep.txt'), { strategy: 'record_separator', separator: '\n---\n' });
ok('自定义分隔符切分', sepRes.records.length === 3, `got ${sepRes.records.length}`);

// 逐行
const linesRes = splitter.splitByRecipe(filePaths['notes.md'], { strategy: 'lines' });
ok('逐行切分', linesRes.records.length > 3);

// 容错：非法配方策略
const badRes = splitter.splitByRecipe(filePaths['notes.md'], { strategy: 'nonexistent' });
ok('未知策略退回整文件', badRes.records.length === 1 && badRes.warnings.length > 0);

// 容错：JSONL 中混入非法行
fs.writeFileSync(path.join(tmp, 'mixed.jsonl'), '{"a":"1"}\n这不是JSON\n{"a":"2"}', 'utf8');
const mixedRes = splitter.splitByRecipe(path.join(tmp, 'mixed.jsonl'), { strategy: 'jsonl', fields: { a: 'a' } });
ok('JSONL 混入非法行仍能切', mixedRes.records.length === 3, `got ${mixedRes.records.length}`);

// 容错：非法 JSON 数组
fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json', 'utf8');
const brokenRes = splitter.splitByRecipe(path.join(tmp, 'broken.json'), { strategy: 'json_array' });
ok('非法 JSON 有告警但不崩溃', brokenRes.warnings.length > 0 || brokenRes.records.length === 1);

// 空文件
fs.writeFileSync(path.join(tmp, 'empty.txt'), '', 'utf8');
const emptyRes = splitter.splitByRecipe(path.join(tmp, 'empty.txt'), { strategy: 'blank_line' });
ok('空文件不崩溃', Array.isArray(emptyRes.records));

// --- 4. 配方校验 ---------------------------------------------------------
section('配方校验');

eq('合法配方无问题', probe.validateRecipe({ strategy: 'jsonl', fields: { a: 'a.b' } }).length, 0);
ok('缺 strategy 被拒', probe.validateRecipe({}).length > 0);
ok('未知 strategy 被拒', probe.validateRecipe({ strategy: 'nope' }).some((p) => p.includes('未知策略')));
ok('非法字段路径被拒',
  probe.validateRecipe({ strategy: 'jsonl', fields: { x: 'a..b' } }).some((p) => p.includes('不合法')));
ok('fields 非对象被拒', probe.validateRecipe({ strategy: 'jsonl', fields: 'x' }).length > 0);
ok('includeMeta 非数组被拒',
  probe.validateRecipe({ strategy: 'jsonl', includeMeta: 'x' }).some((p) => p.includes('includeMeta')));
ok('合法数组路径通过', probe.validateRecipe({ strategy: 'jsonl', fields: { c: 'a[].text' } }).length === 0);
ok('合法嵌套路径通过', probe.validateRecipe({ strategy: 'jsonl', fields: { c: 'a.b.c' } }).length === 0);

// --- 5. 探查任务包 -------------------------------------------------------
section('探查任务包');

const entries = Object.keys(filePaths).map((n) => ({ path: filePaths[n], name: n }));
const probeDir = path.join(tmp, 'probe1');
const pkg = probe.writeProbeTask(probeDir, { files: entries, meta: {} });

ok('探查包已生成', fs.existsSync(probeDir));
ok('manifest 标记 kind=probe', pkg.manifest.kind === 'probe');
ok('manifest 列出全部文件', pkg.manifest.fileCount === entries.length);
ok('样本文件已写出', fs.existsSync(path.join(probeDir, pkg.manifest.files[0].samplePath)));
ok('recipes 目录已建', fs.existsSync(path.join(probeDir, 'recipes')));

const instr = fs.readFileSync(path.join(probeDir, 'INSTRUCTIONS.md'), 'utf8');
ok('指令说明为什么需要探查', /帮我重构|被完全丢弃/.test(instr));
ok('指令列出全部策略', /jsonl/.test(instr) && /conversation/.test(instr) && /csv/.test(instr));
ok('指令给出配方示例', /"strategy"/.test(instr) && /fields/.test(instr));
ok('指令强调宁可不切', /宁可不切/.test(instr));
ok('指令提醒保留角色信息', /角色/.test(instr));

// 配方加载
const load0 = probe.loadRecipes(probeDir);
ok('未提交配方时 ok=true', load0.ok === true);
ok('全部文件标记为 missing', load0.missing.length === entries.length);
ok('recipes 为空', load0.recipes.length === 0);

const probeStatus0 = probe.probeStatus(probeDir);
ok('进度为 0', probeStatus0.done === 0);

// 写入配方
pkg.manifest.files.forEach((f) => {
  const strategy = f.name.endsWith('.jsonl') ? 'jsonl'
    : f.name.endsWith('.csv') ? 'csv'
    : f.name.endsWith('.yaml') ? 'yaml'
    : f.name.endsWith('.md') ? 'markdown'
    : f.name.endsWith('.log') ? 'log'
    : f.name.endsWith('.txt') ? 'conversation'
    : 'json_array';
  const recipe = { file: f.name, strategy, fields: {}, note: '测试配方' };
  if (strategy === 'jsonl') recipe.fields = { 角色: 'role', 内容: 'content[].text' };
  if (strategy === 'json_array') recipe.fields = { 角色: 'role', 内容: 'content' };
  if (strategy === 'conversation') recipe.separator = 'User:|Assistant:';
  fs.writeFileSync(path.join(probeDir, f.recipePath), JSON.stringify(recipe, null, 2), 'utf8');
});

const load1 = probe.loadRecipes(probeDir);
ok('全部配方加载成功', load1.recipes.length === entries.length,
  `${load1.recipes.length}/${entries.length}`);
ok('无非法配方', load1.invalid.length === 0, JSON.stringify(load1.invalid));
ok('进度 100%', probe.probeStatus(probeDir).done === entries.length);

// 非法配方被识别
fs.writeFileSync(path.join(probeDir, pkg.manifest.files[0].recipePath), '{"strategy":"不存在"}', 'utf8');
const load2 = probe.loadRecipes(probeDir);
ok('非法配方被排除并报原因', load2.invalid.length === 1, `got ${load2.invalid.length}`);
ok('探查状态标记 invalid', probe.probeStatus(probeDir).files[0].state === 'invalid');
ok('非法配方不影响其他文件', load2.recipes.length === entries.length - 1);

// 恢复
fs.writeFileSync(path.join(probeDir, pkg.manifest.files[0].recipePath),
  JSON.stringify({ file: 'codex.jsonl', strategy: 'jsonl', fields: { 角色: 'role', 内容: 'content[].text' } }), 'utf8');

// --- 6. 配方 → 分块 → 抽取任务包 ----------------------------------------
section('配方到抽取任务包');

const load3 = probe.loadRecipes(probeDir);
const built = splitter.buildChunksFromRecipes(load3.manifest.files, load3, { budget: 2000 });

ok('生成了分块', built.chunks.length > 0, `got ${built.chunks.length}`);
ok('每个文件都有记录', built.perFile.length === entries.length);
ok('分块带策略标记', built.chunks.every((c) => !!c._strategy));
ok('分块带来源文件', built.chunks.every((c) => !!c._sourceFile));
ok('perFile 字段完整',
  built.perFile.every((f) => f.name && f.strategy && typeof f.recordCount === 'number'));

// 回归：多文件时 chunkRecords 对每个文件独立调用，index 都从 0 开始。
// 若不重编，两个文件的 chunk 0 会撞车 —— agent 写 index=0 覆盖掉
// 另一个文件的 chunk 0，数据静默丢失。
ok('★ 多文件分块索引全局唯一', (() => {
  const idx = built.chunks.map((c) => c.index);
  return new Set(idx).size === idx.length;
})(), `索引为 ${built.chunks.map((c) => c.index).join(',')}`);
ok('★ 分块索引连续递增',
  built.chunks.every((c, i) => c.index === i),
  built.chunks.map((c) => c.index).join(','));

// 部分提交 → 兜底
const partialDir = path.join(tmp, 'probe-partial');
const pPkg = probe.writeProbeTask(partialDir, { files: entries, meta: {} });
fs.writeFileSync(path.join(partialDir, pPkg.manifest.files[0].recipePath),
  JSON.stringify({ strategy: 'lines' }), 'utf8');
const pLoad = probe.loadRecipes(partialDir);
ok('部分提交：1 配方 + 其余 missing', pLoad.recipes.length === 1 && pLoad.missing.length === entries.length - 1);
const pBuilt = splitter.buildChunksFromRecipes(pLoad.manifest.files, pLoad, { budget: 2000 });
const fallbackFiles = pBuilt.perFile.filter((f) => f.strategy.startsWith('fallback:'));
ok('未提交配方走兜底', fallbackFiles.length === entries.length - 1,
  `got ${fallbackFiles.length}`);
ok('兜底文件带告警', fallbackFiles.every((f) => f.warnings.length > 0));
ok('兜底后内容不丢', pBuilt.chunks.length > 0);

// --- 7. 只读保证 ---------------------------------------------------------
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

const srcBefore = Object.fromEntries(
  Object.keys(filePaths).map((n) => [n, fs.readFileSync(filePaths[n], 'utf8')])
);

// 全套探查流程 —— 绝不应改动任何源文件
probe.writeProbeTask(path.join(tmp, 'probe-ro'), { files: entries, meta: {} });
probe.sampleFile(filePaths['codex.jsonl']);
probe.analyzeStructure(SAMPLES['codex.jsonl']);
probe.probeStatus(probeDir);
probe.loadRecipes(probeDir);
const roLoad = probe.loadRecipes(probeDir);
splitter.buildChunksFromRecipes(roLoad.manifest.files, roLoad, { budget: 3000 });
entries.forEach((e) => splitter.splitByRecipe(e.path, { strategy: 'whole' }));

let unchanged = true;
const changedFiles = [];
Object.keys(filePaths).forEach((n) => {
  const now = fs.readFileSync(filePaths[n], 'utf8');
  if (now !== srcBefore[n]) { unchanged = false; changedFiles.push(n); }
});
ok('探查全流程未改动任何源文件', unchanged, changedFiles.join(', '));

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));
if (fail) {
  console.log('\n失败详情:');
  failures.forEach((f) => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
}
process.exit(fail ? 1 : 0);
