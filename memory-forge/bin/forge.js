#!/usr/bin/env node
'use strict';
/**
 * forge — 命令行入口。
 *
 * 存在的主要理由：agent 驱动 shell 比驱动 GUI 可靠得多。
 * agent 可以一次跑完「生成任务包 → 逐块读取 → 写出结果 → 导入 → 校验」，
 * 中途失败也能精确重跑某一步，而 GUI 只能靠人点。
 *
 * 子命令：
 *   task <files...>        生成 agent 抽取任务包
 *   status <taskDir>       查看任务进度（不改任何文件）
 *   import <taskDir>       导入结果并跑下游管线
 *   validate <file>        校验单个结果文件的 JSON 是否合规
 *   types                  列出记忆类型
 */

const fs = require('fs');
const path = require('path');

// CLI 在 bin/ 下，引擎在 ../src/engine/ —— 路径需相对本文件解析，
// 不能依赖调用者的 cwd（agent 可能从任意目录调用本脚本）。
const ENGINE = path.join(__dirname, '..', 'src', 'engine');
const parser = require(path.join(ENGINE, 'parser'));
const merge = require(path.join(ENGINE, 'merge'));
const agentmode = require(path.join(ENGINE, 'agentmode'));
const sampler = require(path.join(ENGINE, 'sampler'));
const probe = require(path.join(ENGINE, 'probe'));
const splitByRecipe = require(path.join(ENGINE, 'splitByRecipe'));
const { loadPalace, slotList } = require(path.join(ENGINE, 'palace'));
const { TYPES, renderCard, cardFileName } = require(path.join(ENGINE, 'schema'));

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function usage() {
  console.log(`${C.bold('forge')} — 记忆铸造厂 CLI

${C.bold('Agent 驱动模式')}（无需配置任何模型）

  ${C.cyan('task')} <文件...> [选项]      生成抽取任务包
  ${C.cyan('probe')} <文件...> [选项]     生成格式探查任务包（格式不统一时先做这步）
  ${C.cyan('probe-status')} <探查目录>    查看探查进度
  ${C.cyan('split')} <探查目录> [选项]    按配方切分并生成抽取任务包
  ${C.cyan('status')} <任务目录>          查看抽取进度
  ${C.cyan('import')} <任务目录> [选项]   导入结果并跑下游管线
  ${C.cyan('validate')} <结果文件>        校验单个结果 JSON

${C.bold('task 选项')}
  --out <目录>          任务包输出位置（默认 ./forge-task-<时间戳>）
  --budget <字符数>     每块字符预算（默认 6000）
  --palace <记忆库目录>  已有记忆库，用于提示已有 slot 减少重复
  --style <侧重>        auto | preference | technical | lesson
  --trial               浅尝模式：从记忆库抽样而非读文件
  --count <n>           浅尝模式的抽样数量
  --ratio <0-1>         浅尝模式的抽样比例（与 --count 二选一）
  --strategy <策略>     抽样策略：random | stratified | slot

${C.bold('split 选项')}
  --out <目录>          抽取任务包输出位置
  --budget <字符数>     每块字符预算

${C.bold('import 选项')}
  --write <记忆库目录>  直接写入目标记忆库（默认只做校验与统计，不写盘）
  --json                以 JSON 输出结果，便于程序处理

${C.bold('典型流程')}
  ${C.dim('# 格式不统一时：先探查 → agent 写配方 → 按配方切分 → agent 抽取 → 导入')}
  forge probe notes.md chat-export.json codex.jsonl
  forge probe-status ./forge-probe-xxx
  forge split ./forge-probe-xxx --out ./task1
  forge import ./task1 --write ~/memory-palace

  ${C.dim('# 格式已知（常见 md/log）时可跳过探查')}
  forge task notes.md chat.log --out ./task1
  forge import ./task1 --write ~/memory-palace

${C.bold('示例')}
  ${C.dim('# 浅尝模式：先抽样 20 条试运行')}
  forge task --trial --palace ~/memory-palace --count 20 --out /tmp/trial
`);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

// --- task ---------------------------------------------------------------

function cmdTask(opts) {
  const isTrial = !!opts.trial;
  let chunks = [];
  let meta = {};
  let baselineCards = [];

  if (isTrial) {
    if (!opts.palace) {
      console.error(C.red('浅尝模式需要 --palace <记忆库目录>'));
      process.exit(1);
    }
    const target = sampler.validateTarget(opts.palace);
    if (!target.ok) {
      const e = sampler.toError(target);
      console.error(C.red(`${e.title}：${e.detail}`));
      console.error(C.dim(`  ${e.hint}`));
      process.exit(1);
    }
    const plan = sampler.planSample(target.cards, {
      strategy: opts.strategy || 'random',
      count: opts.count ? Number(opts.count) : null,
      ratio: opts.ratio ? Number(opts.ratio) : null,
      statusScope: opts.scope || 'active',
      seed: opts.seed ? Number(opts.seed) : null,
    });
    if (!plan.ok) {
      const e = sampler.toError(plan);
      console.error(C.red(`${e.title}：${e.detail || ''}`));
      console.error(C.dim(`  ${e.hint}`));
      process.exit(1);
    }
    plan.warnings.forEach((w) => console.log(C.yellow(`⚠ ${w.message}`)));

    const records = sampler.sampleToRecords(plan.sampled);
    chunks = parser.chunkRecords(records, { budget: Number(opts.budget) || 6000 });
    chunks.forEach((c) => { c._sourceFile = `样本(${plan.target} 条)`; });
    baselineCards = target.cards;
    meta = {
      sourceDesc: `记忆库样本（${plan.strategy} 抽取 ${plan.target} / ${plan.poolSize} 条）`,
      style: opts.style || 'auto',
      existingSlots: slotList(target.cards, 60),
    };
    meta._plan = plan;
  } else {
    const files = opts._;
    if (!files.length) {
      console.error(C.red('请指定至少一个文件，或使用 --trial 走浅尝模式'));
      process.exit(1);
    }
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      console.error(C.red(`文件不存在：${missing.join(', ')}`));
      process.exit(1);
    }
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const parsed = parser.parseContent(f, text);
      const cs = parser.chunkRecords(parsed.records, { budget: Number(opts.budget) || 6000 });
      cs.forEach((c) => { c._sourceFile = path.basename(f); });
      chunks.push(...cs);
      console.log(C.dim(`  ${path.basename(f)} → ${parsed.format}，${parsed.stats.recordCount} 条记录，${cs.length} 块`));
    }
    if (opts.palace) {
      const base = loadPalace(opts.palace);
      baselineCards = base.cards;
      meta.existingSlots = slotList(base.cards, 60);
    }
    meta.sourceDesc = `${files.length} 个文件`;
    meta.style = opts.style || 'auto';
  }

  if (!chunks.length) {
    console.error(C.red('没有产生任何分块，请检查输入文件'));
    process.exit(1);
  }

  const out = opts.out || path.join(process.cwd(), `forge-task-${Date.now()}`);
  const pkg = agentmode.writeTaskPackage(out, { chunks, meta });

  // 展示用绝对路径最不容易出错：agent 之后可能在任意 cwd 下执行后续命令
  const show = (p) => path.resolve(p);

  console.log('');
  console.log(C.green('✓ 任务包已生成'));
  console.log(`  目录      ${show(pkg.root)}`);
  console.log(`  分块      ${pkg.manifest.chunkCount} 块`);
  console.log('');
  console.log(C.bold('接下来：'));
  console.log(`  1. 读 ${C.cyan(show(path.join(pkg.root, agentmode.INSTRUCTIONS)))}，按里面的规范处理`);
  console.log(`  2. 逐块读取 ${C.cyan(path.join(pkg.root, agentmode.CHUNKS_DIR) + '/*.md')}`);
  console.log(`     结果写入 ${C.cyan(path.join(pkg.root, agentmode.RESULTS_DIR) + '/*.result.json')}`);
  console.log(`  3. 跑 ${C.cyan(`forge import ${show(pkg.root)}`)} 导入`);
  console.log('');
  console.log(C.dim(`  进度查询：forge status ${show(pkg.root)}`));
  console.log('');
}

function cmdImport(opts) {
  const dir = opts._[0];
  if (!dir) {
    console.error(C.red('请指定任务包目录'));
    process.exit(1);
  }

  const res = agentmode.importResults(dir);
  if (!res.ok) {
    console.error(C.red(res.error));
    process.exit(1);
  }

  const { manifest, progress } = res;
  const cards = res.cards;

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      progress,
      cardCount: cards.length,
      rejected: res.rejected,
      cards: cards.map((c) => ({
        id: c.id, type: c.type, title: c.title,
        slot: `${c.subject}::${c.predicate}`, value: c.value,
        confidence: c.confidence, importance: c.importance,
        source: c.source,
      })),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(C.bold('=== 导入结果 ==='));
  console.log(`进度      ${progress.done}/${progress.total} 块${progress.missing ? C.yellow(`（${progress.missing} 块未提交结果）`) : ''}`);
  console.log(`卡片      ${cards.length} 张`);

  // 下游管线：与直连模型模式完全一致
  const dd = merge.dedupe(cards);
  const conflicts = merge.findInternalConflicts(dd.kept);

  let baselineCards = [];
  if (opts.palace || opts.write) {
    const root = opts.write || opts.palace;
    baselineCards = loadPalace(root).cards;
  }
  const cmp = merge.compareWithBaseline(dd.kept, baselineCards);

  console.log(`去重      ${dd.kept.length} 张（丢弃 ${dd.dropped.length} 条重复）`);
  console.log(`冲突      ${conflicts.length} 个 slot${conflicts.length ? C.yellow('  ⚠ 需人工裁决') : ''}`);
  console.log(`与已有记忆 ${cmp.conflicts.length} 处关联`);

  if (res.rejected.length) {
    console.log('');
    console.log(C.yellow(`被过滤的卡片 ${res.rejected.length} 张：`));
    res.rejected.slice(0, 8).forEach((r) => console.log(`  [${r.chunk || '?'}] ${r.item} — ${r.reason}`));
  }

  const warnCards = cards.filter((c) => c._warnings && c._warnings.length);
  if (warnCards.length) {
    console.log('');
    console.log(C.yellow(`${warnCards.length} 张卡片有 schema 警告：`));
    warnCards.slice(0, 5).forEach((c) => {
      console.log(`  [${c.id}] ${c.title} — ${c._warnings.join('；')}`);
    });
  }

  if (conflicts.length) {
    console.log('');
    console.log(C.bold('冲突明细：'));
    conflicts.slice(0, 10).forEach((cf) => {
      console.log(`  ${C.cyan(cf.slot)}`);
      cf.members.forEach((m) => console.log(`    ${C.dim(m.value)}`));
      console.log(`    ${C.dim('→ ' + cf.suggestion.rationale)}`);
    });
  }

  // 写盘
  if (opts.write) {
    const root = opts.write;
    const base = loadPalace(root);
    const assigned = merge.assignIds(dd.kept, (base.maxSeq || 0) + 1, base.ids);
    let written = 0;
    const failed = [];
    for (const { id, card } of assigned) {
      const dir = path.join(root, 'cards', card.type);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, cardFileName(id, card.title)), renderCard(card, id), 'utf8');
        written++;
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }
    // 同步 seq.txt
    if (written) {
      const seqPath = path.join(root, '.palace', 'seq.txt');
      fs.mkdirSync(path.dirname(seqPath), { recursive: true });
      const next = parseInt(assigned[assigned.length - 1].id.replace('mem_', ''), 10) + 1;
      fs.writeFileSync(seqPath, `${next}\n`, 'utf8');
      // 重建索引（若 palace 可用）
      try {
        const { execSync } = require('child_process');
        execSync(`python "${path.join(root, 'bin', 'palace.py')}" reindex`, { stdio: 'ignore' });
      } catch (_) { /* 索引重建可选 */ }
    }
    console.log('');
    console.log(C.green(`✓ 已写入 ${written} 张卡片到 ${root}`));
    if (failed.length) console.log(C.red(`  ${failed.length} 张写入失败`));
    console.log(C.dim(`  ID 范围 ${assigned[0] ? assigned[0].id : '—'} … ${assigned[assigned.length - 1] ? assigned[assigned.length - 1].id : '—'}`));
    console.log(C.dim(`  校验：cd ${root} && python bin/palace.py doctor`));
  } else {
    console.log('');
    console.log(C.dim('未指定 --write，仅做校验与统计，未写入任何文件。'));
    console.log(C.dim(`确认无误后：forge import ${path.resolve(dir)} --write <记忆库目录>`));
  }
  console.log('');
}

function cmdStatus(opts) {
  const dir = opts._[0];
  if (!dir) {
    console.error(C.red('请指定任务包目录'));
    process.exit(1);
  }
  const st = agentmode.taskStatus(dir);
  if (!st.ok) {
    console.error(C.red(st.error));
    process.exit(1);
  }
  console.log('');
  console.log(C.bold('=== 任务进度 ==='));
  console.log(`任务 ID   ${st.taskId}`);
  console.log(`创建时间  ${st.createdAt}`);
  console.log(`进度      ${C.cyan(`${st.done}/${st.total}`)} (${st.percent}%)`);
  console.log('');
  st.chunks.forEach((c) => {
    const mark = c.state === 'ok' ? C.green('✓') : c.state === 'error' ? C.red('✗') : C.dim('○');
    const detail = c.state === 'ok' ? `${c.cardCount} 张卡片`
      : c.state === 'error' ? '结果解析失败'
      : '未提交';
    console.log(`  ${mark} ${c.id}  ${String(c.sourceFile).padEnd(24)} ${C.dim(detail)}`);
  });
  console.log('');
}

// --- validate -----------------------------------------------------------

function cmdValidate(opts) {
  const file = opts._[0];
  if (!file) {
    console.error(C.red('请指定结果文件'));
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(C.red(`文件不存在：${file}`));
    process.exit(1);
  }
  const res = agentmode.readResultFile(file, { index: 0, sourceFile: path.basename(file), baseName: 'adhoc' });
  if (res.error) {
    console.error(C.red(`✗ ${res.error}`));
    if (res.raw) console.error(C.dim(`  内容片段：${res.raw}`));
    process.exit(1);
  }
  console.log(C.green(`✓ 解析成功，${res.cards.length} 张卡片`));
  if (res.cards.length) {
    console.log('');
    res.cards.forEach((c) => {
      const warn = c._warnings && c._warnings.length ? C.yellow(` ⚠ ${c._warnings.join('；')}`) : '';
      // slot 是 Card 上的 getter 属性，agent 产出的裸对象没有它，
      // 所以这里用 subject/predicate 现算，避免显示成「(无 slot)」。
      const slot = (c.subject || '') + '::' + (c.predicate || '');
      console.log(`  ${C.cyan(slot === '::' ? '(无 slot)' : slot)}`);
      console.log(`    ${c.title} → ${c.value}${warn}`);
    });
  }
  if (res.rejected && res.rejected.length) {
    console.log('');
    console.log(C.yellow(`${res.rejected.length} 张被过滤：`));
    res.rejected.forEach((r) => console.log(`  ${r.item} — ${r.reason}`));
  }
}

function cmdTypes() {
  console.log('');
  console.log(C.bold('记忆类型'));
  Object.entries(TYPES).forEach(([k, v]) => {
    console.log(`  ${C.cyan(k.padEnd(12))} ${v.label}　TTL ${v.ttl}天　正文上限 ${v.bodyLimit}　重要性 ${v.importance}`);
  });
  console.log('');
  console.log(C.bold('字段要求'));
  console.log('  subject + predicate 构成 slot（冲突检测的键）');
  console.log('  predicate 用英文 snake_case，不能含空格');
  console.log('  aliases 放中文触发词，用于跨语言检索');
  console.log('');
}

// --- probe / split -------------------------------------------------------

/**
 * 探查：生成「这个文件该怎么切」的配方任务包。
 *
 * 这是抽取的前置步骤。规则解析器只认识几种常见格式，遇到
 * Codex 会话那种 `content[].text` 的嵌套结构会静默丢掉真实内容，
 * 所以先让 agent 看一眼。
 */
function cmdProbe(opts) {
  const files = opts._;
  if (!files.length) {
    console.error(C.red('请指定至少一个要探查的文件'));
    process.exit(1);
  }
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(C.red(`文件不存在：${missing.join(', ')}`));
    process.exit(1);
  }

  const entries = files.map((p) => ({ path: p, name: path.basename(p) }));
  const out = opts.out || path.join(process.cwd(), `forge-probe-${Date.now()}`);
  const pkg = probe.writeProbeTask(out, { files: entries, meta: {} });

  // 打印结构统计摘要 —— 用户/agent 想快速了解文件性质时看这里
  console.log('');
  console.log(C.bold('文件结构速览'));
  pkg.manifest.files.forEach((f) => {
    const s = probe.sampleFile(f.path);
    const marks = [];
    if (s.jsonLineRate > 0.7) marks.push('JSONL');
    if (s.roleMarkers.role_user || s.roleMarkers.chatgpt_mapping) marks.push('对话');
    if (s.nestedContentLines > 0) marks.push(C.yellow('嵌套内容'));
    if (s.csvLike) marks.push(`CSV(${(s.csvColumns - 1)}列)`);
    if (s.yamlLikeKeys > 0 && s.indentedRatio > 0.2) marks.push('YAML');
    if (s.timestampRatio > 0.4) marks.push('时间戳');
    if (s.headingCount > 2) marks.push('Markdown');
    console.log(`  ${f.name.padEnd(26)} ${String(s.chars).padStart(8)} 字符  `
      + `${marks.length ? marks.join(' ') : C.dim('结构不明显')}`);
    console.log(`  ${''.padEnd(26)} 规则猜测: ${C.cyan(f.ruleGuess)}`
      + (s.nestedContentLines > 0
        ? C.yellow(`  ⚠ 检测到 ${s.nestedContentLines} 行含嵌套内容数组，规则解析会丢失`)
        : ''));
  });

  console.log('');
  console.log(C.green('✓ 探查任务包已生成'));
  console.log(`  目录  ${pkg.root}`);
  console.log(`  文件  ${pkg.manifest.fileCount} 个`);
  console.log('');
  console.log(C.bold('接下来：'));
  console.log(`  1. 读 ${C.cyan(path.join(pkg.root, 'INSTRUCTIONS.md'))}`);
  console.log(`  2. 读 ${C.cyan(path.join(pkg.root, 'samples') + '/*.json')}，为每个文件写一份切分配方`);
  console.log(`     结果写入 ${C.cyan(path.join(pkg.root, 'recipes') + '/*.recipe.json')}`);
  console.log(`  3. 跑 ${C.cyan(`forge split ${pkg.root} --out <任务目录>`)} 生成抽取任务包`);
  console.log('');
  console.log(C.dim(`  进度：forge probe-status ${pkg.root}`));
  console.log('');
}

function cmdProbeStatus(opts) {
  const dir = opts._[0];
  if (!dir) { console.error(C.red('请指定探查任务目录')); process.exit(1); }
  const st = probe.probeStatus(dir);
  if (!st.ok) { console.error(C.red(st.error)); process.exit(1); }
  console.log('');
  console.log(C.bold('=== 探查进度 ==='));
  console.log(`进度  ${C.cyan(`${st.done}/${st.total}`)} (${st.percent}%)`);
  console.log('');
  st.files.forEach((f) => {
    const mark = f.state === 'ok' ? C.green('✓') : f.state === 'invalid' ? C.red('✗') : C.dim('○');
    const detail = f.state === 'ok' ? C.cyan(f.strategy)
      : f.state === 'invalid' ? f.error
      : '未提交';
    console.log(`  ${mark} ${f.id}  ${f.name.padEnd(26)} ${detail}`);
  });
  console.log('');
}

/**
 * 切分：按配方生成抽取任务包。
 *
 * 配方里没给的文件退回规则解析器兜底，不丢数据。
 */
function cmdSplit(opts) {
  const dir = opts._[0];
  if (!dir) { console.error(C.red('请指定探查任务目录')); process.exit(1); }

  const loaded = probe.loadRecipes(dir);
  if (!loaded.ok) { console.error(C.red(loaded.error)); process.exit(1); }

  if (loaded.missing.length) {
    console.log(C.yellow(`⚠ ${loaded.missing.length} 个文件未提交配方，将用规则解析器兜底：`
      + loaded.missing.map((m) => m.name).join('、')));
  }
  if (loaded.invalid.length) {
    console.log(C.red(`✗ ${loaded.invalid.length} 个配方不合法，将被跳过：`));
    loaded.invalid.forEach((iv) => console.log(`    ${iv.file.name}: ${iv.error}`));
  }
  if (!loaded.recipes.length) {
    console.error(C.red('没有可用配方。请让 agent 先完成探查。'));
    process.exit(1);
  }

  const { chunks, perFile } = splitByRecipe.buildChunksFromRecipes(
    loaded.manifest.files, loaded,
    { budget: Number(opts.budget) || 6000 }
  );

  if (!chunks.length) {
    console.error(C.red('切分后没有内容，请检查配方'));
    process.exit(1);
  }

  const out = opts.out || path.join(process.cwd(), `forge-task-${Date.now()}`);
  const pkg = agentmode.writeTaskPackage(out, {
    chunks,
    meta: {
      sourceDesc: `${loaded.recipes.length} 个按配方切分的文件`,
      style: opts.style || 'auto',
      existingSlots: [],
    },
  });

  console.log('');
  console.log(C.bold('=== 切分结果 ==='));
  perFile.forEach((f) => {
    const mark = f.strategy.startsWith('fallback:') ? C.yellow('兜底') : C.green('配方');
    console.log(`  [${mark}] ${f.name.padEnd(24)} ${C.cyan(f.strategy.padEnd(16))} `
      + `${f.recordCount} 条 → ${f.chunkCount} 块`);
    f.warnings.forEach((w) => console.log(`         ${C.yellow('⚠ ' + w)}`));
  });

  console.log('');
  console.log(C.green(`✓ 抽取任务包已生成：${pkg.root}`));
  console.log(`  共 ${pkg.manifest.chunkCount} 块`);
  console.log('');
  console.log(C.dim('  下一步：让 agent 按 INSTRUCTIONS.md 处理 chunks/，结果写入 results/'));
  console.log(C.dim(`  导入：forge import ${pkg.root}`));
  console.log('');
  console.log(C.bold('各文件结构（agent 可参考）'));
  perFile.forEach((f) => {
    console.log(`- ${f.name}：${f.strategy}（${f.recordCount} 条记录）`);
    if (f.note) console.log(`  ${f.note}`);
  });
  console.log('');
}

// --- main ---------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const opts = parseArgs(argv.slice(1));

  try {
    switch (cmd) {
      case 'task': cmdTask(opts); break;
      case 'probe': cmdProbe(opts); break;
      case 'probe-status': cmdProbeStatus(opts); break;
      case 'split': cmdSplit(opts); break;
      case 'import': cmdImport(opts); break;
      case 'status': cmdStatus(opts); break;
      case 'validate': cmdValidate(opts); break;
      case 'types': cmdTypes(); break;
      default:
        console.error(C.red(`未知命令：${cmd}`));
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(C.red(`执行失败：${err.message}`));
    if (process.env.FORGE_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
