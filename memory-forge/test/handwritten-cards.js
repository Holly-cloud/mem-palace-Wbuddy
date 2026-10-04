'use strict';
/**
 * 手写卡片的容错读取测试。
 *
 * 背景：真实试用产物里有 6 张卡因为 frontmatter 分隔符被写成 \---
 * 而完全读不出来 —— 数据完好，却因一个字符失效。这类失败最坏，
 * 因为它静默：体检只说「缺少 frontmatter」，看不出原因。
 *
 * 这里锁住两层防护：
 *   1. parseFrontmatter 容错（读取端能救回来）
 *   2. import_results 的描述明确要求 agent 不要手写（写入端不给机会）
 *
 * 运行： node test/handwritten-cards.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPalace } = require('../src/engine/palace');
const { normalizeCard, renderCard, cardFileName } = require('../src/engine/schema');

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, d) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, failures.push({n,d}), console.log(`  FAIL  ${n}${d?' — '+d:''}`)); };
const section = (t) => console.log(`\n=== ${t} ===`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hand-'));

function makeCard(dir, id, title, subject, predicate, value) {
  const card = normalizeCard({ type: 'preference', title, subject, predicate, value }, {});
  const d = path.join(dir, 'cards', card.type);
  fs.mkdirSync(d, { recursive: true });
  return { card, file: path.join(d, cardFileName(id, title)) };
}

// --- 1. renderCard 自身必须产出合规格式 ---------------------------------
section('renderCard 产出合规');

{
  const { card, file } = makeCard(tmp, 'mem_00001', '偏好精简', 'user', 'verbosity', '默认精简');
  fs.writeFileSync(file, renderCard(card, 'mem_00001'), 'utf8');
  const txt = fs.readFileSync(file, 'utf8');
  ok('起始符是裸 ---', txt.split('\n')[0] === '---', JSON.stringify(txt.split('\n')[0]));
  ok('不含转义分隔符', !txt.includes('\\---'));
  const l = loadPalace(tmp);
  ok('能被读回', l.cards.length === 1);
  ok('无结构问题', l.problems.length === 0, JSON.stringify(l.problems));
}

// --- 2. 手写卡的各种偏差都要能救 -----------------------------------------
section('手写偏差容错');

const VARIANTS = [
  {
    name: '分隔符被转义（\\---）',
    mangle: (t) => t.replace(/^---$/gm, '\\---'),
    why: 'Agent 把 YAML 分隔符当 Markdown 转义',
  },
  {
    name: '分隔符带尾随空格',
    mangle: (t) => t.replace(/^---$/gm, '---  '),
    why: '某些编辑器会加尾随空白',
  },
  {
    name: '分隔符带前导缩进',
    mangle: (t) => t.replace(/^---$/gm, '  ---'),
    why: '整体缩进的写法',
  },
  {
    name: 'CRLF 行尾',
    mangle: (t) => t.replace(/\n/g, '\r\n'),
    why: 'Windows 上手写文件常见',
  },
  {
    name: '字段值有尾随空格',
    mangle: (t) => t.replace(/^(id|type|title): (.+)$/gm, '$1: $2  '),
    why: 'agent 生成的字段常带尾随空格',
  },
];

VARIANTS.forEach((v, i) => {
  const d = path.join(tmp, 'v' + i);
  const { card, file } = makeCard(d, 'mem_00001', '测试卡', 'user', 'test_' + i, '值' + i);
  const good = renderCard(card, 'mem_00001');
  fs.writeFileSync(file, v.mangle(good), 'utf8');

  const l = loadPalace(d);
  ok(`容错：${v.name}`, l.cards.length === 1, `读出 ${l.cards.length} 张（${v.why}）`);
  if (l.cards.length === 1) {
    ok(`  → 内容正确`, l.cards[0].value === '值' + i, l.cards[0].value);
  }
});

// --- 3. 真的坏掉时仍要报错（不能无限宽容） -------------------------------
section('不该被接受的输入');

{
  const d = path.join(tmp, 'bad1');
  const { file } = makeCard(d, 'mem_00001', '测试', 'user', 'p', 'v');
  fs.writeFileSync(file, '这里没有 frontmatter\n就是普通文本\n', 'utf8');
  ok('无 frontmatter 被拒', loadPalace(d).cards.length === 0);
}

{
  const d = path.join(tmp, 'bad2');
  const { file } = makeCard(d, 'mem_00001', '测试', 'user', 'p', 'v');
  // 有起始符但无闭合符
  fs.writeFileSync(file, '---\nid: mem_00001\ntype: preference\n\n正文\n', 'utf8');
  ok('无闭合分隔符被拒', loadPalace(d).cards.length === 0);
}

{
  const d = path.join(tmp, 'bad3');
  const { file } = makeCard(d, 'mem_00001', '测试', 'user', 'p', 'v');
  const txt = renderCard(normalizeCard({ type: 'preference', title: 'x', subject: 'u', predicate: 'p', value: 'v' }, {}), 'mem_00001');
  // 删掉 id 行
  fs.writeFileSync(file, txt.replace(/^id: .+\n/m, ''), 'utf8');
  const l = loadPalace(d);
  ok('缺 id 被标记为问题', l.cards.length === 0 && l.problems.length === 1,
    `cards=${l.cards.length} problems=${l.problems.length}`);
}

// --- 4. 结构问题的信息要够定位 -------------------------------------------
section('诊断信息质量');

{
  const d = path.join(tmp, 'diag');
  const { file } = makeCard(d, 'mem_00001', '测试', 'user', 'p', 'v');
  // 复现真实事故：分隔符转义
  fs.writeFileSync(file, renderCard(
    normalizeCard({ type: 'preference', title: 'x', subject: 'u', predicate: 'p', value: 'v' }, {}), 'mem_00001'
  ).replace(/^---$/gm, '\\---'), 'utf8');
  const l = loadPalace(d);
  // 修复后不该报问题
  ok('转义分隔符不再报结构问题', l.problems.length === 0, JSON.stringify(l.problems));
}

// --- 5. 工具描述里必须写明「不要手写」 ------------------------------------
section('MCP 工具描述');

{
  const { TOOL_DEFS } = require('../bin/forge-mcp.js');
  const imp = TOOL_DEFS.find((t) => t.name === 'forge_import_results');
  ok('import_results 存在', !!imp);
  ok('描述含「不要自己往 cards/ 目录手写」', /不要.*手写/.test(imp.description), imp.description.slice(0, 60));
  ok('描述点明手写的具体危害', /frontmatter/.test(imp.description));
  ok('描述说明工具用 renderCard 渲染', /renderCard/.test(imp.description));
  ok('说明手写不计入 ID 序列', /ID 序列/.test(imp.description));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(46));
if (fail) {
  console.log('\n失败:');
  failures.forEach((f) => console.log(`  - ${f.n}${f.d ? ': ' + f.d : ''}`));
}
process.exit(fail ? 1 : 0);
