'use strict';
/**
 * 渲染进程逻辑。
 *
 * 只通过 window.forge（preload 暴露）与主进程通信。
 * 所有状态集中在 S，避免多步之间的数据不一致。
 */

const S = {
  step: 1,
  mode: 'full',         // 'full' | 'trial'
  execMode: 'agent',    // 'agent' | 'llm' —— 抽取执行方式
  files: [],            // 已解析文件（含 records 摘要）
  palaceRoot: null,
  palaceInfo: null,
  trialLibrary: null,   // 试运行目标库概况
  trialPlan: null,      // 抽样计划
  trialReport: null,    // 试运行报告
  agentTask: null,      // agent 抽取任务包信息
  agentStatus: null,    // 抽取进度
  probeTask: null,      // 探查任务包信息
  agentDetect: null,    // Agent 连接检测结果
  jobId: null,
  extracting: false,
  // 抽取结果
  cards: [],
  deduped: [],
  internalConflicts: [],
  baselineConflicts: [],
  newSlots: [],
  uncoveredSlots: [],
  errors: [],
  rejected: [],
  // UI
  activeFile: 0,
  activeTab: 'cards',
  targetDir: null,
  decisions: new Map(),  // slot -> action
  typeKeys: [],
};

// --- 工具 ---------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function log(msg, kind) {
  const box = $('#extractLog');
  const line = el('div', kind ? `l-${kind}` : '', msg);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() { $('#extractLog').innerHTML = ''; }

function statBlock(items) {
  const row = $('#parseStats');
  row.innerHTML = '';
  items.forEach((it) => {
    const s = el('div', 'stat' + (it.tone ? ' ' + it.tone : ''));
    s.appendChild(el('div', 'stat-v', String(it.value)));
    s.appendChild(el('div', 'stat-k', it.label));
    row.appendChild(s);
  });
}

// --- 步骤导航 -----------------------------------------------------------

function goStep(n) {
  // 浅尝模式跳过「解析」步骤：输入是结构化卡片，没有文件切分可言，
  // 抽样预览已在第 1 步完成。
  if (S.mode === 'trial' && n === 2) n = 3;

  S.step = n;
  $$('.step').forEach((b) => {
    const i = Number(b.dataset.step);
    b.classList.toggle('active', i === n);
    b.classList.toggle('done', i < n);
  });
  $$('.panel').forEach((p) => p.classList.toggle('active', Number(p.dataset.panel) === n));
  $('#stepInd').textContent = S.mode === 'trial' && n > 2
    ? `浅尝模式 · 步骤 ${n === 3 ? 2 : n - 1} / 4`
    : `步骤 ${n} / 5`;
  $('#btnPrev').disabled = n === 1;
  $('#btnNext').disabled = n === 5 || !stepComplete(n);
  $('.content').scrollTop = 0;
}

function stepComplete(n) {
  if (n === 1) {
    return S.mode === 'trial'
      ? !!(S.trialLibrary && S.trialPlan)
      : S.files.some((f) => !f.error);
  }
  if (n === 2) {
    return S.mode === 'trial' ? !!(S.trialLibrary && S.trialPlan) : S.files.some((f) => !f.error);
  }
  if (n === 3) {
    if (S.mode === 'trial' && S.execMode === 'agent') {
      return !!(S.agentTask && S.agentStatus && S.agentStatus.done > 0);
    }
    if (S.execMode === 'agent') return !!S.agentTask;
    return S.cards.length > 0;
  }
  if (n === 4) return S.mode === 'trial' ? !!S.trialReport : S.cards.some((c) => !c._dropped);
  return true;
}

function refreshNav() {
  $('#btnNext').disabled = S.step === 5 || !stepComplete(S.step);
  $$('.step').forEach((b) => { b.disabled = Number(b.dataset.step) > S.step + 1; });
}

// ── 模式切换 ────────────────────────────────────────────────

function setMode(mode) {
  S.mode = mode;
  $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#modeFull').hidden = mode !== 'full';
  $('#modeTrial').hidden = mode !== 'trial';
  $('#trialRunBanner').hidden = mode !== 'trial';
  $('#trialExportBanner').hidden = mode !== 'trial';
  $('#exportFull').hidden = mode !== 'trial';
  if (mode === 'trial') {
    $('#exportTitle').textContent = '浅尝模式不导出';
    $('#exportDesc').textContent = '本次运行仅用于预览与确认，不写入任何文件。';
  } else {
    $('#exportTitle').textContent = '导出到记忆库';
    $('#exportDesc').textContent = '写入 Markdown 文件，可被 palace CLI 直接读取。';
  }
  if (S.step === 1) renderTrialLibrary();
  refreshNav();
}

// ── 浅尝模式：选择与校验 ────────────────────────────────────

async function pickTrialPalace() {
  const dir = await window.forge.openDirectory();
  if (!dir) return;
  S.palaceRoot = dir;
  S.trialLibrary = null;
  S.trialPlan = null;
  $('#trialParams').hidden = true;
  $('#trialPreview').innerHTML = '';
  $('#trialPalaceHint').textContent = '正在校验…';
  await inspectTrial();
}

function trialSampleOptions() {
  const sizing = $('#trialSizing').value;
  const amount = $('#trialAmount').value;
  return {
    strategy: $('#trialStrategy').value,
    statusScope: $('#trialScope').value,
    count: sizing === 'count' ? Number(amount) : null,
    ratio: sizing === 'ratio' ? Number(amount) / 100 : null,
    seed: $('#trialSeed').value.trim() === '' ? null : Number($('#trialSeed').value.trim()),
  };
}

async function inspectTrial() {
  const box = $('#trialPreview');
  box.innerHTML = '<div class="hint">校验中…</div>';

  const res = await window.forge.trialInspect({
    palaceRoot: S.palaceRoot,
    sampleOptions: trialSampleOptions(),
  });

  if (!res.ok) {
    renderTrialError(box, res.error);
    renderTrialLibrary(res.library);
    $('#trialParams').hidden = !res.library;
    refreshNav();
    return;
  }

  S.trialPlan = res.plan;
  $('#trialPalaceHint').textContent = `${res.library.root}`;
  renderTrialLibrary(res.library);
  $('#trialParams').hidden = false;
  renderTrialPreview(res);
  refreshNav();
}

function renderTrialError(box, err) {
  box.innerHTML = '';
  const e = el('div', 'err-box');
  e.appendChild(el('div', 'err-title', `${err.title}（${err.code}）`));
  e.appendChild(el('div', 'err-hint', err.hint));
  if (err.detail) e.appendChild(el('div', 'err-path', err.detail));
  box.appendChild(e);
}

function renderTrialLibrary(lib) {
  const box = $('#trialLibInfo');
  if (!lib) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';

  box.appendChild(el('h3', '', '目标记忆库概况'));
  const grid = el('div', 'lib-grid');
  const cells = [
    ['总卡片', lib.cardCount, ''],
    ['active', lib.activeCount, ''],
    ['唯一 slot', lib.uniqueSlots, ''],
    ['记忆类型', Object.keys(lib.byType || {}).length, ''],
  ];
  cells.forEach(([k, v]) => {
    const c = el('div', 'lib-cell');
    c.appendChild(el('div', 'lib-v', String(v)));
    c.appendChild(el('div', 'lib-k', k));
    grid.appendChild(c);
  });
  box.appendChild(grid);

  const types = el('div', 'lib-types');
  Object.entries(lib.byType || {})
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => {
      types.appendChild(el('span', `type-tag type-${t}`, `${typeLabel(t)} ${n}`));
    });
  box.appendChild(types);

  if (lib.problems && lib.problems.length) {
    const w = el('div', 'warn-box');
    w.style.marginTop = '10px';
    w.textContent = `记忆库有 ${lib.problems.length} 处读取问题，试运行会跳过这些文件：${
      lib.problems.slice(0, 3).map((p) => p.file).join('、')}${lib.problems.length > 3 ? ' 等' : ''}`;
    box.appendChild(w);
  }
}

function renderTrialPreview(res) {
  const box = $('#trialPreview');
  box.innerHTML = '';
  const p = res.plan;

  // 抽样计划概要
  const head = el('div', 'stats-row');
  head.style.marginTop = '4px';
  const cells = [
    ['将抽取', p.requested, 'good'],
    ['候选池', p.poolSize, ''],
    ['覆盖率', `${Math.round(p.coverageRatio * 100)}%`, ''],
    ['随机种子', p.seed, ''],
  ];
  cells.forEach(([k, v, tone]) => {
    const s = el('div', 'stat' + (tone ? ' ' + tone : ''));
    s.appendChild(el('div', 'stat-v', String(v)));
    s.appendChild(el('div', 'stat-k', k));
    head.appendChild(s);
  });
  box.appendChild(head);

  (p.warnings || []).forEach((w) => {
    box.appendChild(el('div', 'warn-box', w.message));
  });

  // 样本预览
  box.appendChild(el('div', 'hint', `样本预览（前 ${p.sample.length} / ${p.sampleTotal} 条）：`));
  const list = el('div', 'record-list');
  list.style.marginTop = '6px';
  p.sample.forEach((c) => {
    const item = el('div', 'record');
    const h = el('div', 'rec-head');
    h.appendChild(el('span', 'rec-loc', c.id));
    h.appendChild(el('span', 'rec-kind', `${typeLabel(c.type)}${c.status !== 'active' ? ' · ' + c.status : ''}`));
    item.appendChild(h);
    item.appendChild(el('div', 'rec-text', `${c.slot}\n${c.value}`));
    list.appendChild(item);
  });
  box.appendChild(list);
}

// ── 浅尝模式：结果报告 ──────────────────────────────────────

function renderTrialReport() {
  const r = S.trialReport;
  const panel = $('#trialReport');
  if (!r) { panel.hidden = true; return; }
  panel.hidden = false;

  $('#trSummary').textContent = r.summary || '';

  // 三栏：抽样 / 组织结构 / 抽取结果
  const grid = $('#trGrid');
  grid.innerHTML = '';

  // 抽样参数
  const secA = el('div', 'tr-sec');
  secA.appendChild(el('h4', '', '抽样参数'));
  const kvA = [
    ['策略', r.sampling.strategyLabel],
    ['状态范围', r.sampling.statusScopeLabel],
    ['抽样数', `${r.sampling.requested} / ${r.sampling.poolSize}`],
    ['随机种子', r.sampling.seed],
  ];
  kvA.forEach(([k, v]) => {
    const row = el('div', 'tr-kv');
    row.appendChild(el('span', '', k));
    row.appendChild(el('span', '', String(v)));
    secA.appendChild(row);
  });
  grid.appendChild(secA);

  // 组织结构（按类型的条形分布）
  const secB = el('div', 'tr-sec');
  secB.appendChild(el('h4', '', `组织结构 · ${r.organization.uniqueSlots} 个 slot`));
  const bars = el('div', 'tr-bars');
  const max = Math.max(...Object.values(r.organization.byType), 1);
  r.organization.typeOrder.forEach((t) => {
    const n = r.organization.byType[t];
    const row = el('div', 'tr-bar-row');
    row.appendChild(el('span', 'tr-bar-name', typeLabel(t)));
    const track = el('div', 'tr-bar-track');
    const fill = el('div', 'tr-bar-fill');
    fill.style.width = `${(n / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', 'tr-bar-val', String(n)));
    bars.appendChild(row);
  });
  if (!r.organization.typeOrder.length) bars.appendChild(el('div', 'empty-inline', '无数据'));
  secB.appendChild(bars);
  grid.appendChild(secB);

  // 抽取结果
  const secC = el('div', 'tr-sec');
  secC.appendChild(el('h4', '', '抽取结果'));
  const kvC = [
    ['产出卡片', r.extraction.extracted],
    ['通过校验', r.extraction.valid],
    ['去重合并', r.extraction.deduped],
    ['冲突 slot', r.extraction.conflicts],
    ['出错分块', r.extraction.errors],
  ];
  kvC.forEach(([k, v]) => {
    const row = el('div', 'tr-kv');
    row.appendChild(el('span', '', k));
    const val = el('span', '', String(v));
    if ((k === '冲突 slot' || k === '出错分块') && v > 0) val.style.color = 'var(--amber)';
    row.appendChild(val);
    secC.appendChild(row);
  });
  grid.appendChild(secC);

  // 归类分布（产出卡片按类型）
  const secD = el('div', 'tr-sec');
  secD.appendChild(el('h4', '', '归类分布（产出卡片）'));
  const objEntries = Object.entries(r.extraction.byType || {});
  if (objEntries.length) {
    const bars2 = el('div', 'tr-bars');
    const max2 = Math.max(...objEntries.map(([, n]) => n), 1);
    objEntries.sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
      const row = el('div', 'tr-bar-row');
      row.appendChild(el('span', 'tr-bar-name', typeLabel(t)));
      const track = el('div', 'tr-bar-track');
      const fill = el('div', 'tr-bar-fill');
      fill.style.width = `${(n / max2) * 100}%`;
      fill.style.background = 'var(--teal)';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'tr-bar-val', String(n)));
      bars2.appendChild(row);
    });
    secD.appendChild(bars2);
  } else {
    secD.appendChild(el('div', 'empty-inline', '本次未产出卡片，可尝试换策略或放宽筛选范围'));
  }
  grid.appendChild(secD);

  // 告警
  const warnBox = $('#trWarnings');
  warnBox.innerHTML = '';
  (r.warnings || []).forEach((w) => {
    warnBox.appendChild(el('div', 'tr-warn-item', w.message));
  });

  // 冲突清单
  const cfBox = $('#trConflicts');
  cfBox.innerHTML = '';
  const conflicts = r.conflicts || [];
  if (conflicts.length) {
    cfBox.appendChild(el('h4', '', `检出 ${conflicts.length} 处 slot 冲突`));
    conflicts.slice(0, 8).forEach((cf) => {
      const item = el('div', 'tr-conflict-item');
      item.appendChild(el('div', 'tr-conflict-slot', cf.slot));
      const vals = el('div', 'tr-conflict-vals');
      const vs = (cf.members || []).map((m) => m.value).join('  ⟷  ');
      vals.textContent = vs + (cf.suggestion ? `   → ${cf.suggestion.rationale}` : '');
      item.appendChild(vals);
      cfBox.appendChild(item);
    });
    if (conflicts.length > 8) {
      cfBox.appendChild(el('div', 'empty-inline', `另有 ${conflicts.length - 8} 处，见「内部冲突」标签页`));
    }
  }
}

/** 试运行确认后切到完整模式，固化模型参数但不沿用抽样 */
async function commitToFull() {
  const res = await window.forge.commitTrialParams({
    sampleOptions: S.trialPlan ? {
      strategy: S.trialPlan.strategy,
      statusScope: S.trialPlan.statusScope,
      seed: S.trialPlan.seed,
      count: S.trialPlan.requested,
      poolSize: S.trialPlan.poolSize,
    } : null,
    mode: 'full',
    chunkBudget: Number($('#cfgBudget').value) || 6000,
    style: $('#cfgStyle').value,
    config: cfg(),
  });
  if (res && res.ok) {
    log(`已按试运行参数准备全量运行（${res.message}）`, 'ok');
    // 保留已有记忆库路径供冲突对比，清空抽样结果
    S.mode = 'full';
    S.trialReport = null;
    S.cards = [];
    $('#trialReport').hidden = true;
    setMode('full');
    renderReview();
    goStep(1);
  }
}

async function copyReport() {
  const r = S.trialReport;
  if (!r) return;
  const lines = [
    '【记忆铸造厂 · 浅尝结果】',
    r.summary,
    '',
    `抽样：${r.sampling.strategyLabel} / ${r.sampling.statusScopeLabel} / ${r.sampling.requested} 条（候选池 ${r.sampling.poolSize}）/ seed ${r.sampling.seed}`,
    `产出：${r.extraction.extracted} 张卡片，去重 ${r.extraction.deduped}，冲突 ${r.extraction.conflicts}，出错 ${r.extraction.errors}`,
    '',
    '组织结构：',
    ...r.organization.typeOrder.map((t) => `  ${typeLabel(t)}: ${r.organization.byType[t]}`),
  ];
  if (r.conflicts && r.conflicts.length) {
    lines.push('', '冲突：');
    r.conflicts.forEach((cf) => {
      lines.push(`  ${cf.slot}: ${(cf.members || []).map((m) => m.value).join(' ⟷ ')}`);
    });
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('试运行摘要已复制到剪贴板', 'ok');
  } catch (err) {
    log(`复制失败：${err.message}`, 'warn');
  }
}

// ── 格式探查 ────────────────────────────────────────────────

/** 生成探查任务包 */
async function makeProbeTask() {
  const valid = S.mode === 'trial' ? [] : S.files.filter((f) => !f.error);
  if (!valid.length) return log('请先在第 1 步选择文件', 'err');

  const btn = $('#btnMakeProbe');
  btn.disabled = true;
  btn.textContent = '生成中…';

  const res = await window.forge.probeMakeTask(valid.map((f) => f.path));

  btn.disabled = false;
  btn.textContent = '重新生成探查任务包';

  if (!res.ok) {
    const box = $('#probeResult');
    box.innerHTML = '';
    box.appendChild(errBox(res.error));
    return;
  }

  S.probeTask = res;
  renderProbeResult(res);

  // 给出可直接复制的探查指令
  const cmd = [
    `forge probe ${res.fileCount} 个文件`,
    `forge probe-status ${res.root}`,
    `forge split ${res.root} --out ./task1`,
  ].join('\n');
  $('#probeInstruction').innerHTML = `
    <p class="ti-lead">把下面这段发给你的 agent：</p>
    <pre class="ti-body">请用记忆铸造厂（memory-forge）勘察这些记忆文件的结构：

1. 读指令文件：<code>${escapeHtml(res.instructionsPath)}</code>
2. 读 <code>${escapeHtml(res.root + '/samples')}</code> 下的每个 .json（里面是文件的头尾片段与结构统计），
   判断每个文件该怎么切
3. 为每个文件写一份切分配方到 <code>${escapeHtml(res.root + '/recipes')}</code> 目录，
   文件名把扩展名换成 <code>.recipe.json</code>

写完之后回复「已勘察 N/M 个文件」。

命令行等价流程：
${escapeHtml(cmd)}</pre>
    <p class="hint">探查目录：<code>${escapeHtml(res.root)}</code>　文件数：${res.fileCount}</p>
  `;
  $('#probeTaskPanel').hidden = false;
  $('#btnSplitByProbe').hidden = false;
  $('#agentTaskTitle').textContent = '第 3 步 · 抽取任务';
  log(`探查任务包已生成：${res.fileCount} 个文件`, 'ok');
}

/** 显示探查结果与结构速览 */
function renderProbeResult(res) {
  const box = $('#probeResult');
  box.innerHTML = '';
  if (!res.previews || !res.previews.length) return;

  const table = el('div', 'probe-table');
  res.previews.forEach((p) => {
    const row = el('div', 'probe-row');
    row.appendChild(el('span', 'probe-name', p.name));
    if (p.error) {
      row.appendChild(el('span', 'probe-err', p.error));
    } else {
      row.appendChild(el('span', 'probe-guess', `规则猜测 ${p.ruleGuess}`));
      const marks = el('span', 'probe-marks');
      (p.marks && p.marks.length ? p.marks : ['结构不明显']).forEach((m) => {
        marks.appendChild(el('span', 'probe-mark', m));
      });
      row.appendChild(marks);
      if (p.nestedContentLines > 0) {
        row.appendChild(el('span', 'probe-warn',
          `⚠ ${p.nestedContentLines} 行含嵌套内容，规则解析会丢失`));
      }
    }
    table.appendChild(row);
  });
  box.appendChild(table);
}

/** 按配方切分 */
async function splitByProbe() {
  if (!S.probeTask) return;
  const btn = $('#btnSplitByProbe');
  btn.disabled = true;
  btn.textContent = '切分中…';

  const res = await window.forge.probeSplit({
    probeDir: S.probeTask.root,
    chunkBudget: Number($('#cfgBudget').value) || 6000,
  });

  btn.disabled = false;
  btn.textContent = '按配方切分';

  if (!res.ok) {
    const box = $('#probeResult');
    box.innerHTML = '';
    box.appendChild(errBox(res.error));
    return;
  }

  // 切分结果直接转成抽取任务包
  S.agentTask = {
    root: res.root,
    chunkCount: res.chunkCount,
    instructionsPath: res.instructionsPath,
    manifest: res.manifest,
    _fromRecipe: true,
  };
  S.agentStatus = null;

  // 显示切分明细
  const box = $('#probeResult');
  box.innerHTML = '';
  const title = el('div', 'hint', '切分结果：');
  box.appendChild(title);
  res.perFile.forEach((f) => {
    const isFallback = String(f.strategy).startsWith('fallback:');
    const row = el('div', 'probe-row');
    row.appendChild(el('span', 'probe-name', f.name));
    row.appendChild(el('span', isFallback ? 'probe-guess fallback' : 'probe-guess ok',
      isFallback ? '规则兜底' : f.strategy));
    row.appendChild(el('span', 'probe-marks', `${f.recordCount} 条 → ${f.chunkCount} 块`));
    f.warnings.forEach((w) => row.appendChild(el('span', 'probe-warn', `⚠ ${w}`)));
    box.appendChild(row);
  });
  if (res.missing && res.missing.length) {
    box.appendChild(el('div', 'warn-box',
      `${res.missing.length} 个文件未提交配方，已用规则解析器兜底：${res.missing.join('、')}`));
  }
  if (res.invalid && res.invalid.length) {
    box.appendChild(el('div', 'warn-box',
      `${res.invalid.length} 个配方不合法被跳过：${res.invalid.map((i) => `${i.file.name}(${i.error})`).join('；')}`));
  }

  log(`已按配方切分：${res.perFile.length} 个文件 → ${res.chunkCount} 块`, 'ok');
  $('#btnMakeTask').textContent = '重新生成抽取任务包';
  $('#agentStep2').hidden = true;
  $('#agentStep3').hidden = false;
  await refreshAgentStatus();
  refreshNav();
}

async function copyProbeInstruction() {
  if (!S.probeTask) return;
  const r = S.probeTask;
  const text = `请用记忆铸造厂（memory-forge）勘察这些记忆文件的结构：

1. 读指令文件：${r.instructionsPath}
2. 读 ${r.root}/samples 下的每个 .json（文件的头尾片段与结构统计），
   判断每个文件该怎么切
3. 为每个文件写一份切分配方到 ${r.root}/recipes 目录，
   文件名把扩展名换成 .recipe.json

写完之后回复「已勘察 N/${r.fileCount} 个文件」。

命令行等价流程：
forge probe-status ${r.root}
forge split ${r.root} --out ./task1`;
  try {
    await navigator.clipboard.writeText(text);
    log('探查指令已复制，可直接粘贴给 agent', 'ok');
  } catch (err) {
    log(`复制失败：${err.message}，请手动选中下方文本`, 'warn');
  }
}

// --- Agent 连接状态 -------------------------------------------------------

/**
 * 顶栏显示 Agent 连接状态。
 * 这个工具没有内置模型 —— 没接上 Agent 就无法抽取，所以状态必须显眼。
 */
async function refreshAgentStatus() {
  const dot = $('#agentDot');
  const label = $('#agentLabel');
  try {
    const res = await window.forge.detectAgent('hermes');
    if (!res.ok) {
      dot.className = 'al-dot err';
      label.textContent = '检测失败';
      return;
    }
    S.agentDetect = res;
    if (!res.installed) {
      dot.className = 'al-dot err';
      label.textContent = '未检测到 hermes';
    } else if (!res.registered) {
      dot.className = 'al-dot warn';
      label.textContent = '待配置 MCP';
    } else {
      dot.className = 'al-dot ok';
      label.textContent = 'hermes 已连接';
    }
  } catch (err) {
    dot.className = 'al-dot err';
    label.textContent = '检测失败';
  }
}

async function openSettings() {
  await window.forge.openSettings();
  // 关闭窗口后回来刷新一次状态，用户可能刚配好
  setTimeout(refreshAgentStatus, 800);
}

// ── Agent 驱动模式 ────────────────────────────────────────────

/** 切换抽取执行方式 */
function setExecMode(mode) {
  S.execMode = mode;
  $$('.exec-btn').forEach((b) => b.classList.toggle('active', b.dataset.exec === mode));
  $('#execAgent').hidden = mode !== 'agent';
  $('#execLlm').hidden = mode !== 'llm';
  refreshNav();
}

/** 生成抽取任务包 */
async function makeTask() {
  // 若已经按配方切分过，就用那份结果，不要退回规则解析重来
  if (S.agentTask && S.agentTask.root && S.agentTask._fromRecipe) {
    $('#agentStep2').hidden = false;
    $('#agentStep3').hidden = false;
    await refreshAgentStatus();
    return log('已使用按配方切分的结果', 'warn');
  }

  const valid = S.mode === 'trial' ? null : S.files.filter((f) => !f.error);
  if (S.mode !== 'trial' && !valid) return log('没有可处理的文件', 'err');

  const btn = $('#btnMakeTask');
  btn.disabled = true;
  btn.textContent = '生成中…';

  const res = await window.forge.agentMakeTask({
    files: valid || [],
    palaceRoot: S.palaceRoot,
    chunkBudget: Number($('#cfgBudget').value) || 6000,
    style: $('#cfgStyle').value,
  });

  btn.disabled = false;
  btn.textContent = '重新生成任务包';

  if (!res.ok) {
    $('#agentProgress').innerHTML = '';
    $('#agentProgress').appendChild(errBox(`${res.error}`));
    return;
  }

  S.agentTask = res;
  log(`任务包已生成：${res.chunkCount} 块`, 'ok');

  // 显示给 agent 的指令，带上可直接复制的命令
  const cmd = `forge task ${res.chunkCount} 块 → 处理 → forge import`;
  $('#taskInstruction').innerHTML = `
    <p class="ti-lead">把下面这段发给你的 agent：</p>
    <pre class="ti-body">请用记忆铸造厂（memory-forge）的 CLI 处理记忆抽取：

1. 读指令文件：<code>${escapeHtml(res.instructionsPath)}</code>
2. 按其中的规范，逐块处理 <code>${escapeHtml(res.root + '/chunks')}</code> 下的每个 .md，
   把结果 JSON 写到对应的 <code>results/</code> 目录
3. 处理完回复「已完成 N/M 块」

也可以直接用命令行：
  cd ${escapeHtml(res.root)}
  # 逐块读取 chunks/*.md，结果写入 results/*.result.json
  forge import ${escapeHtml(res.root)}</pre>
    <p class="hint">任务目录：<code>${escapeHtml(res.root)}</code>　分块数：${res.chunkCount}</p>
  `;

  $('#agentStep2').hidden = false;
  $('#agentStep3').hidden = false;
  await refreshAgentStatus();
}

/** 刷新任务进度 */
async function refreshAgentStatus() {
  if (!S.agentTask) return;
  const box = $('#agentProgress');
  const st = await window.forge.agentStatus(S.agentTask.root);
  if (!st.ok) {
    box.innerHTML = '';
    box.appendChild(errBox(st.error));
    return;
  }
  S.agentStatus = st;
  box.innerHTML = '';

  const head = el('div', 'stats-row');
  const cells = [
    ['已完成', `${st.done}/${st.total}`, st.done === st.total ? 'good' : 'warn'],
    ['进度', `${st.percent}%`, st.done === st.total ? 'good' : ''],
    ['任务 ID', st.taskId.slice(0, 12), ''],
  ];
  cells.forEach(([k, v, tone]) => {
    const s = el('div', 'stat' + (tone ? ' ' + tone : ''));
    s.appendChild(el('div', 'stat-v', String(v)));
    s.appendChild(el('div', 'stat-k', k));
    head.appendChild(s);
  });
  box.appendChild(head);

  // 分块明细
  const list = el('div', 'chunk-list');
  st.chunks.forEach((c) => {
    const row = el('div', 'chunk-row');
    const mark = c.state === 'ok' ? 'ok' : c.state === 'error' ? 'err' : 'wait';
    row.appendChild(el('span', `chunk-mark ${mark}`, c.state === 'ok' ? '✓' : c.state === 'error' ? '!' : '○'));
    row.appendChild(el('span', 'chunk-id', c.id));
    row.appendChild(el('span', 'chunk-src', c.sourceFile || '未知'));
    row.appendChild(el('span', 'chunk-state',
      c.state === 'ok' ? `${c.cardCount} 张卡片` : c.state === 'error' ? '解析失败' : '未提交'));
    list.appendChild(row);
  });
  box.appendChild(list);

  if (st.done < st.total) {
    box.appendChild(el('div', 'warn-box',
      `还有 ${st.total - st.done} 块未提交结果。agent 可以分批处理，随时回来点「刷新进度」。`));
  }
}

/** 导入 agent 产出的结果 */
async function importAgentResult() {
  if (!S.agentTask) return log('请先生成任务包', 'err');

  const btn = $('#btnAgentImport');
  btn.disabled = true;
  btn.textContent = '导入中…';

  const res = await window.forge.agentImport({
    taskDir: S.agentTask.root,
    palaceRoot: S.palaceRoot,
    // 浅尝模式：带上抽样计划以便产出预览报告
    samplePlan: S.trialPlan ? {
      strategy: S.trialPlan.strategy,
      statusScope: S.trialPlan.statusScope,
      seed: S.trialPlan.seed,
      ratio: S.trialPlan.ratio,
      target: S.trialPlan.requested,
      poolSize: S.trialPlan.poolSize,
      totalSize: S.trialPlan.totalSize,
      warnings: S.trialPlan.warnings || [],
    } : null,
    sampleStats: S.trialPlan ? S.trialPlan.sample || [] : null,
  });

  btn.disabled = false;
  btn.textContent = '导入结果';

  if (!res.ok) {
    $('#agentProgress').innerHTML = '';
    $('#agentProgress').appendChild(errBox(res.error || '导入失败'));
    return;
  }

  // 走与直连模式完全相同的下游流程
  S.cards = res.cards.map((c, i) => ({
    ...c, _localId: c._localId || `A${i + 1}`, _dropped: false, _edited: false,
    status: c.status || 'active',
  }));
  S.deduped = res.deduped || [];
  S.internalConflicts = res.internalConflicts || [];
  S.baselineConflicts = res.baselineConflicts || [];
  S.newSlots = res.newSlots || [];
  S.errors = [];
  S.rejected = res.rejected || [];
  S.decisions.clear();

  log(`导入完成：${S.cards.length} 张卡片（agent 处理 ${res.progress.done}/${res.progress.total} 块）`, 'ok');
  if (S.internalConflicts.length) log(`检出 ${S.internalConflicts.length} 个内部冲突 slot`, 'warn');
  if (S.rejected.length) log(`${S.rejected.length} 张卡片被过滤`, 'warn');

  applyDecisions();
  renderReview();
  goStep(4);
}

function errBox(msg) {
  const e = el('div', 'err-box');
  e.appendChild(el('div', 'err-title', msg));
  return e;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copyInstruction() {
  if (!S.agentTask) return;
  const text = `请用记忆铸造厂（memory-forge）的 CLI 处理记忆抽取：

1. 读指令文件：${S.agentTask.instructionsPath}
2. 按其中的规范，逐块处理 ${S.agentTask.root}/chunks 下的每个 .md，
   把结果 JSON 写到对应的 results/ 目录
3. 处理完回复「已完成 N/${S.agentTask.chunkCount} 块」`;
  try {
    await navigator.clipboard.writeText(text);
    log('指令已复制，可直接粘贴给 agent', 'ok');
  } catch (err) {
    log(`复制失败：${err.message}，请手动选中下方文本`, 'warn');
  }
}

// ── 步骤 1：导入 --------------------------------------------------------

async function pickFiles() {
  const paths = await window.forge.openFiles();
  if (paths.length) await loadFiles(paths.map((p) => p.path));
}

async function loadFiles(paths) {
  log(`读取 ${paths.length} 个文件…`);
  const results = await window.forge.readFiles(paths);
  results.forEach((r) => {
    const idx = S.files.findIndex((f) => f.path === r.path);
    if (idx >= 0) S.files[idx] = r;
    else S.files.push(r);
  });
  S.activeFile = Math.max(0, S.files.findIndex((f) => !f.error));
  renderFiles();
  if (S.step === 1) goStep(2);
  log(`完成，${S.files.filter((f) => !f.error).length} 个文件可解析`, 'ok');
}

function renderFiles() {
  const box = $('#fileList');
  box.innerHTML = '';
  if (!S.files.length) {
    box.appendChild(el('div', 'empty', '尚未选择文件'));
    return;
  }
  S.files.forEach((f, i) => {
    const item = el('div', 'file-item' + (f.error ? ' error' : ''));
    item.appendChild(el('span', 'fi-name', f.name));
    if (f.error) {
      item.appendChild(el('span', 'fmt-tag err', '失败'));
      item.appendChild(el('span', 'fi-meta', f.error));
    } else {
      item.appendChild(el('span', 'fmt-tag', f.format));
      item.appendChild(el('span', 'fi-meta',
        `${S.files[i].stats.recordCount} 条记录 · ${(f.size / 1024).toFixed(1)}KB`));
      const btn = el('button', 'btn btn-sm', '查看');
      btn.onclick = () => { S.activeFile = i; goStep(2); renderParse(); };
      item.appendChild(btn);
      const rm = el('button', 'btn btn-sm btn-danger', '移除');
      rm.onclick = () => { S.files.splice(i, 1); renderFiles(); refreshNav(); };
      item.appendChild(rm);
    }
    box.appendChild(item);
  });
  refreshNav();
}

async function pickPalace() {
  const dir = await window.forge.openDirectory();
  if (!dir) return;
  S.palaceRoot = dir;
  const res = await window.forge.loadPalace(dir);
  S.palaceInfo = res;
  const badge = $('#palaceBadge');
  badge.hidden = false;
  badge.textContent = `已有记忆 ${res.cardCount} 张`;
  $('#palaceHint').textContent = `已加载：${res.cardCount} 张卡片，${res.slots.length} 个 slot`;
  if (res.problems.length) {
    log(`记忆库有 ${res.problems.length} 处读取问题`, 'warn');
  }
  log(`已加载已有记忆库（${res.cardCount} 张卡片）用于冲突对比`, 'ok');
}

// --- 步骤 2：解析 --------------------------------------------------------

function renderParse() {
  const valid = S.files.filter((f) => !f.error);
  if (!valid.length) {
    $('#recordList').innerHTML = '';
    $('#fileTabs').innerHTML = '';
    statBlock([{ value: 0, label: '文件' }]);
    return;
  }
  const active = valid[Math.min(S.activeFile, valid.length - 1)];
  const totalRecords = valid.reduce((s, f) => s + f.stats.recordCount, 0);
  const totalChars = valid.reduce((s, f) => s + f.stats.chars, 0);
  const avg = totalRecords ? Math.round(totalChars / totalRecords) : 0;

  statBlock([
    { value: valid.length, label: '文件', tone: 'good' },
    { value: totalRecords, label: '记录总数' },
    { value: avg, label: '平均长度', tone: avg > 3000 ? 'warn' : '' },
    { value: new Set(valid.map((f) => f.format)).size, label: '格式种类' },
  ]);

  const tabs = $('#fileTabs');
  tabs.innerHTML = '';
  valid.forEach((f, i) => {
    const b = el('button', 'file-tab' + (f === active ? ' active' : ''),
      `${f.name} · ${f.stats.recordCount}`);
    b.onclick = () => { S.activeFile = i; renderParse(); };
    tabs.appendChild(b);
  });

  const list = $('#recordList');
  list.innerHTML = '';
  active.records.forEach((r) => {
    const item = el('div', 'record');
    const head = el('div', 'rec-head');
    head.appendChild(el('span', 'rec-loc', r.locator));
    head.appendChild(el('span', 'rec-kind', r.kind + (r.chars ? ` · ${r.chars}字` : '')));
    item.appendChild(head);
    if (r.section) item.appendChild(el('div', 'rec-sec', r.section));
    item.appendChild(el('div', 'rec-text', r.preview || '(空)'));
    list.appendChild(item);
  });
}

// --- 步骤 3：模型配置与抽取 ------------------------------------------------

function cfg() {
  return {
    provider: $('#cfgProvider').value,
    baseUrl: $('#cfgBaseUrl').value.trim(),
    apiKey: $('#cfgApiKey').value.trim(),
    model: $('#cfgModel').value.trim(),
    temperature: 0.1,
    maxTokens: 4096,
    concurrency: Number($('#cfgConcurrency').value) || 2,
  };
}

async function detectModels() {
  const box = $('#modelDetect');
  box.innerHTML = '<div class="detect-item">探测中…</div>';
  const res = await window.forge.detectModels({
    ollamaUrl: $('#cfgBaseUrl').value.trim() || 'http://127.0.0.1:11434',
    openaiBaseUrl: $('#cfgBaseUrl').value.trim(),
    openaiKey: $('#cfgApiKey').value.trim(),
  });
  box.innerHTML = '';
  if (!res.ok) {
    box.appendChild(el('div', 'detect-item bad', res.error));
    return;
  }
  const datalist = $('#modelList');
  datalist.innerHTML = '';

  res.results.forEach((r) => {
    const item = el('div', 'detect-item ' + (r.available ? 'ok' : 'bad'));
    item.appendChild(el('div', '', `${r.provider} · ${r.available ? '可用' : '不可用'}`));
    item.appendChild(el('div', 'ct-alg', r.note));
    box.appendChild(item);

    if (r.available && r.models.length) {
      r.models.forEach((m) => {
        const o = document.createElement('option');
        o.value = m.id;
        datalist.appendChild(o);
      });
      // Ollama 可用时自动选一个合理的默认模型
      if (r.provider === 'ollama' && !$('#cfgModel').value) {
        const pick = r.models.find((m) => /14b|13b|7b|8b/i.test(m.id)) || r.models[0];
        $('#cfgModel').value = pick.id;
        $('#cfgProvider').value = 'ollama';
        $('#cfgBaseUrl').value = r.baseUrl;
        log(`自动选择本地模型：${pick.id}`, 'ok');
      }
    }
  });
}

async function testModel() {
  const btn = $('#btnTestModel');
  btn.disabled = true;
  $('#modelStatus').textContent = '测试中…';
  const res = await window.forge.testModel(cfg());
  btn.disabled = false;
  if (res.ok) {
    $('#modelStatus').textContent = `连接正常，返回：${res.preview}`;
    log('模型连接测试通过', 'ok');
  } else {
    $('#modelStatus').textContent = `失败：${res.error}`;
    log(`模型测试失败：${res.error}`, 'err');
  }
}

async function startExtract() {
  clearLog();
  const isTrial = S.mode === 'trial';

  if (isTrial) {
    if (!S.trialLibrary) return log('请先选择目标记忆库', 'err');
    if (!S.trialPlan) return log('请先预览抽样计划', 'err');
  } else {
    const valid = S.files.filter((f) => !f.error);
    if (!valid.length) return log('没有可解析的文件', 'err');
  }

  const model = $('#cfgModel').value.trim();
  if (!model) return log('请先指定模型', 'err');

  S.extracting = true;
  S.cards = []; S.deduped = []; S.internalConflicts = []; S.baselineConflicts = [];
  S.errors = []; S.rejected = []; S.decisions.clear();
  S.trialReport = null;

  $('#btnExtract').disabled = true;
  $('#btnCancel').hidden = false;
  $('#btnCancel').disabled = false;
  $('#progressWrap').hidden = false;

  const payload = {
    config: cfg(),
    mode: isTrial ? 'trial' : 'full',
    files: isTrial ? [] : S.files.filter((f) => !f.error),
    existingSlots: $('#cfgUseExisting').checked && S.palaceInfo && !isTrial ? S.palaceInfo.slots : [],
    palaceRoot: S.palaceRoot,
    chunkBudget: Number($('#cfgBudget').value) || 6000,
    style: $('#cfgStyle').value,
    sampleOptions: isTrial ? trialSampleOptions() : null,
  };

  const res = await window.forge.startExtract(payload);
  if (res && res.error) {
    S.extracting = false;
    $('#btnExtract').disabled = false;
    $('#btnCancel').hidden = true;
    log(`无法开始：${res.error.title} — ${res.error.hint}`, 'err');
    return;
  }

  S.jobId = res.jobId;
  log(`任务已启动：${res.chunkCount} 个分块待处理${isTrial ? '（浅尝模式，不会写入任何文件）' : ''}`);
}

function onExtractProgress(p) {
  $('#progressFill').style.width = `${p.percent || 0}%`;
  $('#progressText').textContent = `已完成 ${p.done} / ${p.total} 块（${p.percent || 0}%）`;
}

function onExtractError(e) {
  log(`分块 ${e.chunkIndex + 1} 失败：${e.error}`, 'err');
  S.errors.push({ ...e, scope: 'chunk' });
}

function onExtractDone(d) {
  S.extracting = false;
  $('#btnExtract').disabled = false;
  $('#btnCancel').hidden = true;
  $('#progressFill').style.width = '100%';
  $('#progressText').textContent = `完成，共 ${d.cards.length} 张卡片`;

  // 主进程已做好去重；此处补齐 UI 所需字段
  S.cards = d.cards.map((c, i) => ({
    ...c,
    _localId: c._localId || `L${i + 1}`,
    _dropped: false,
    _edited: false,
    status: c.status || 'active',
  }));
  S.deduped = d.deduped || [];
  S.internalConflicts = d.internalConflicts || [];
  S.baselineConflicts = d.baselineConflicts || [];
  S.newSlots = d.newSlots || [];
  S.uncoveredSlots = d.uncoveredSlots || [];
  S.errors = [...S.errors, ...(d.errors || []).map((e) => ({ ...e, scope: 'extract' }))];
  S.rejected = d.rejected || [];

  const isTrial = d.mode === 'trial' || S.mode === 'trial';
  if (isTrial) {
    S.trialReport = d.trialReport || S.trialReport;
    if (S.trialReport) {
      log(`浅尝完成：${S.cards.length} 张卡片（未写入任何文件）`, 'ok');
      if (S.trialReport.summary) log(S.trialReport.summary);
      (S.trialReport.warnings || []).forEach((w) => log(w.message, 'warn'));
    } else {
      log(`浅尝完成：${S.cards.length} 张卡片（未写入任何文件）`, 'ok');
    }
  } else {
    log(`抽取完成：${S.cards.length} 张卡片，去重 ${S.deduped.length} 条`, 'ok');
    if (S.internalConflicts.length) log(`检出 ${S.internalConflicts.length} 个内部冲突 slot，需你裁决`, 'warn');
    if (S.baselineConflicts.length) log(`与已有记忆有 ${S.baselineConflicts.length} 处关联/矛盾`, 'warn');
    if (S.errors.length) log(`${S.errors.length} 个分块出错`, 'warn');
  }

  applyDecisions();
  renderReview();
  // 试运行直接跳到步骤 4 的结果预览；完整模式沿用原流程
  goStep(4);
}

function onExtractFailed(f) {
  S.extracting = false;
  $('#btnExtract').disabled = false;
  $('#btnCancel').hidden = true;
  log(`任务失败：${f.error}`, 'err');
}

// --- 步骤 4：审查 --------------------------------------------------------

function applyDecisions() {
  const decisions = [...S.decisions.entries()].filter(([, a]) => a)
    .map(([slot, action]) => ({ slot, action }));
  if (!decisions.length) return;
  const applied = applyDecisionsInRenderer(S.cards, S.internalConflicts, decisions);
  // 用裁决结果覆盖，但保留被丢弃的卡片（标记 _dropped）以便用户反悔
  const byId = new Map(S.cards.map((c) => [c._localId, c]));
  S.cards.forEach((c) => { c._dropped = true; c._decided = true; });
  applied.forEach((c) => {
    const prev = byId.get(c._localId);
    c._dropped = false;
    if (prev) { c._edited = c._edited || prev._edited; }
    const idx = S.cards.findIndex((x) => x._localId === c._localId);
    if (idx >= 0) S.cards[idx] = c;
    else S.cards.push(c);
  });
}

/**
 * 裁决逻辑。与主进程 merge.js 的 applyDecisions 保持同一语义，
 * 但保留原卡片的额外字段（_dropped / _edited），便于 UI 继续编辑。
 */
function applyDecisionsInRenderer(cards, conflicts, decisions) {
  const actionOf = new Map(decisions.map((d) => [d.slot, d.action]));
  const dropped = new Set();
  const mergedBodies = new Map();
  const notes = new Map();

  conflicts.forEach((cf) => {
    const action = actionOf.get(cf.slot);
    if (!action) return;
    const members = cf.members;

    if (action === 'merge') {
      const sorted = [...members].sort((a, b) =>
        (b.body || '').length + (b.value || '').length -
        ((a.body || '').length + (a.value || '').length));
      const keeper = sorted[0];
      mergedBodies.set(keeper._localId, sorted.slice(1)
        .map((m) => m.value + (m.body ? `\n${m.body}` : '')).filter(Boolean).join('\n\n'));
      sorted.slice(1).forEach((m) => dropped.add(m._localId));
      notes.set(keeper._localId, `合并了 ${sorted.length - 1} 条同 slot 记忆`);
    } else if (action === 'supersede') {
      const sorted = [...members].sort((a, b) =>
        String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')));
      sorted.slice(1).forEach((m) => dropped.add(m._localId));
      notes.set(sorted[0]._localId, `取代了同 slot 的 ${sorted.length - 1} 条旧记忆`);
    } else if (action === 'keep-first') {
      members.slice(1).forEach((m) => dropped.add(m._localId));
    } else if (action === 'dispute') {
      members.forEach((m) => { m.status = 'disputed'; });
    } else if (action === 'drop' || action === 'skip') {
      members.forEach((m) => dropped.add(m._localId));
    }
  });

  return cards.filter((c) => !c._dropped && !dropped.has(c._localId)).map((c) => {
    const card = { ...c };
    if (mergedBodies.has(c._localId)) {
      card.body = `${card.body || card.value}\n\n${mergedBodies.get(c._localId)}`.trim();
    }
    if (notes.has(c._localId)) {
      card.body = `${card.body || card.value}\n\n> 转换备注：${notes.get(c._localId)}`.trim();
    }
    return card;
  });
}

function renderReview() {
  const alive = S.cards.filter((c) => !c._dropped);
  const dupes = S.deduped.length;
  const issues = S.errors.length + S.rejected.length;

  statBlock([
    { value: alive.length, label: '有效卡片', tone: 'good' },
    { value: S.internalConflicts.length, label: '内部冲突', tone: S.internalConflicts.length ? 'warn' : '' },
    { value: S.baselineConflicts.length, label: '涉及已有记忆', tone: S.baselineConflicts.length ? 'warn' : '' },
    { value: dupes, label: '已去重' },
    { value: issues, label: '异常', tone: issues ? 'danger' : '' },
    { value: S.newSlots.length, label: '新增 slot', tone: 'good' },
  ]);

  // 试运行结果预览（仅浅尝模式）
  renderTrialReport();

  $('#cntCards').textContent = alive.length;
  $('#cntConflicts').textContent = S.internalConflicts.length;
  $('#cntBaseline').textContent = S.baselineConflicts.length;
  $('#cntErrors').textContent = issues;

  renderCardTable();
  renderConflicts();
  renderBaseline();
  renderErrors();
  refreshNav();
}

function renderCardTable() {
  const q = $('#cardFilter').value.trim().toLowerCase();
  const typeQ = $('#cardTypeFilter').value;
  const tbody = $('#cardRows');
  tbody.innerHTML = '';

  const rows = S.cards.filter((c) => {
    if (typeQ && c.type !== typeQ) return false;
    if (!q) return true;
    return [c.title, c.value, c.subject, c.predicate, ...(c.tags || [])]
      .join(' ').toLowerCase().includes(q);
  });

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'empty', '没有匹配的卡片');
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((c) => {
    const tr = el('tr', c._dropped ? 'dropped' : '');

    const tdChk = el('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !c._dropped;
    chk.onchange = () => {
      c._dropped = !chk.checked;
      c._edited = true;
      renderReview();
    };
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    const tdType = el('td');
    tdType.appendChild(el('span', `type-tag type-${c.type}`, typeLabel(c.type)));
    tr.appendChild(tdType);

    const tdMain = el('td');
    tdMain.appendChild(el('div', 'ct-title', c.title));
    tdMain.appendChild(el('div', 'ct-value', c.value));
    if (c.aliases && c.aliases.length) {
      tdMain.appendChild(el('div', 'ct-alg', `别名: ${c.aliases.join('、')}`));
    }
    tr.appendChild(tdMain);

    const tdSlot = el('td');
    tdSlot.appendChild(el('div', 'ct-slot', `${c.subject}::${c.predicate}`));
    if (c.status === 'disputed') tdSlot.appendChild(el('span', 'type-tag type-decision', '有争议'));
    tr.appendChild(tdSlot);

    tr.appendChild(el('td', '', c.confidence.toFixed(2)));
    tr.appendChild(el('td', '', c.importance.toFixed(2)));

    const tdAct = el('td');
    const ed = el('button', 'btn btn-sm', '编辑');
    ed.onclick = () => editCard(c);
    tdAct.appendChild(ed);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });
}

function typeLabel(key) {
  const map = {
    profile: '身份', preference: '偏好', environment: '环境', project: '项目',
    procedure: '规程', lesson: '教训', decision: '决策', episode: '事件',
  };
  return map[key] || key;
}

function editCard(c) {
  const fields = [
    ['title', '标题', c.title],
    ['value', '主张', c.value],
    ['subject', 'subject', c.subject],
    ['predicate', 'predicate', c.predicate],
    ['aliases', '中文别名（逗号分隔）', (c.aliases || []).join(', ')],
    ['tags', '标签（逗号分隔）', (c.tags || []).join(', ')],
  ];
  const body = fields.map(([k, label, val]) => {
    const d = el('div', 'field');
    d.appendChild(el('label', '', label));
    const i = document.createElement('input');
    i.type = 'text';
    i.value = val;
    i.dataset.key = k;
    d.appendChild(i);
    return d;
  }).join('');

  const dlg = document.createElement('dialog');
  dlg.style.cssText = 'border:1px solid var(--border);border-radius:10px;padding:20px;max-width:520px;background:var(--surface)';
  dlg.innerHTML = `<h3 style="margin-bottom:14px;font-size:15px">编辑卡片</h3>${body}
    <div class="row gap" style="margin-top:8px">
      <button class="btn btn-primary" data-act="save">保存</button>
      <button class="btn" data-act="cancel">取消</button>
    </div>`;
  document.body.appendChild(dlg);

  dlg.querySelector('[data-act="save"]').onclick = () => {
    dlg.querySelectorAll('input[data-key]').forEach((i) => {
      const k = i.dataset.key;
      if (k === 'aliases' || k === 'tags') {
        c[k] = i.value.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        c[k] = i.value.trim();
      }
    });
    c._edited = true;
    dlg.close(); dlg.remove();
    renderReview();
  };
  dlg.querySelector('[data-act="cancel"]').onclick = () => { dlg.close(); dlg.remove(); };
  dlg.showModal();
}

function renderConflicts() {
  const box = $('#tabConflicts');
  box.innerHTML = '';
  if (!S.internalConflicts.length) {
    box.innerHTML = '<div class="empty"><div class="empty-mark">✓</div>没有内部冲突</div>';
    return;
  }
  S.internalConflicts.forEach((cf) => {
    const decided = S.decisions.get(cf.slot);
    const g = el('div', 'conflict-group' + (decided ? '' : ' severity-high'));
    const head = el('div', 'cg-head');
    head.appendChild(el('span', 'cg-slot', cf.slot));
    head.appendChild(el('span', `type-tag type-${cf.kind === 'duplicate' ? 'episode' : 'preference'}`,
      cf.kind === 'duplicate' ? '内容重复' : '主张不一致'));
    head.appendChild(el('span', 'hint', decided ? `已裁决：${actionLabel(decided)}` : '待裁决'));
    g.appendChild(head);

    const members = el('div', 'cg-members');
    cf.members.forEach((m) => {
      const row = el('div', 'cg-member');
      row.appendChild(el('div', 'cg-val', m.value));
      const src = el('div', 'cg-src',
        `conf ${(m.confidence || 0).toFixed(2)} · imp ${(m.importance || 0).toFixed(2)}` +
        (m._sourceFile ? ` · ${m._sourceFile}` : '') +
        (m._dropped ? ' · 已丢弃' : ''));
      row.querySelector('.cg-val').appendChild(src);
      members.appendChild(row);
    });
    g.appendChild(members);

    const actions = el('div', 'cg-actions');
    [['merge', '合并为一条'], ['supersede', '保留最新'], ['keep-first', '保留第一条'],
     ['dispute', '标记争议'], ['drop', '全部丢弃']].forEach(([action, label]) => {
      const b = el('button', 'btn btn-sm', label);
      if (decided === action) b.style.borderColor = 'var(--accent)';
      b.onclick = () => {
        S.decisions.set(cf.slot, S.decisions.get(cf.slot) === action ? null : action);
        applyDecisions();
        renderReview();
      };
      actions.appendChild(b);
    });
    g.appendChild(actions);
    box.appendChild(g);
  });
}

function actionLabel(a) {
  return { merge: '合并', supersede: '保留最新', 'keep-first': '保留第一条',
           dispute: '标记争议', drop: '全部丢弃' }[a] || a;
}

function renderBaseline() {
  const box = $('#tabBaseline');
  box.innerHTML = '';
  if (!S.baselineConflicts.length) {
    box.appendChild(el('div', 'empty',
      S.palaceRoot ? '与已有记忆库没有发现重叠' : '未加载已有记忆库，跳过对比'));
    if (S.newSlots.length) {
      const d = el('div', 'hint');
      d.style.marginTop = '12px';
      d.textContent = `将新增 ${S.newSlots.length} 个 slot：${S.newSlots.slice(0, 8).join('、')}`;
      box.appendChild(d);
    }
    return;
  }
  const group = (kind, title, tone) => {
    const items = S.baselineConflicts.filter((c) => c.kind === kind);
    if (!items.length) return;
    box.appendChild(el('div', 'hint', `${title}（${items.length}）`));
    items.forEach((cf) => {
      const g = el('div', 'conflict-group');
      const head = el('div', 'cg-head');
      head.appendChild(el('span', 'cg-slot', cf.slot));
      head.appendChild(el('span', `type-tag type-${tone}`, `${Math.round(cf.similarity * 100)}% 相似`));
      g.appendChild(head);
      const m = el('div', 'cg-members');
      m.appendChild(el('div', 'cg-member', ''));
      const existing = el('div', 'cg-val');
      existing.appendChild(el('div', '', `已有：${cf.existingCard.value}`));
      existing.appendChild(el('div', 'cg-src', `${cf.existingCard.id} · ${cf.existingCard.title || ''}`));
      m.querySelector('.cg-member').appendChild(existing);
      const incoming = el('div', 'cg-val');
      incoming.appendChild(el('div', '', `导入：${cf.newCard.value}`));
      incoming.appendChild(el('div', 'cg-src', cf.newCard._sourceFile || ''));
      m.querySelector('.cg-member').appendChild(incoming);
      g.appendChild(m);
      const note = el('div', 'cg-actions');
      note.appendChild(el('span', 'hint', cf.suggestion.rationale));
      g.appendChild(note);
      box.appendChild(g);
    });
  };
  group('contradiction', '与已有记忆矛盾', 'episode');
  group('enrichment', '与已有记忆相关但更详细', 'environment');
  group('identical', '与已有记忆一致', 'procedure');
}

function renderErrors() {
  const box = $('#tabErrors');
  box.innerHTML = '';
  const items = [
    ...S.errors.map((e) => ({ t: e.error, d: `分块 ${(e.chunkIndex ?? 0) + 1}${e.sourceFile ? ' · ' + e.sourceFile : ''}`, raw: e.raw })),
    ...S.rejected.map((r) => ({ t: '非法卡片已过滤', d: `分块 ${r.chunkIndex + 1} · ${r.item}` })),
  ];
  if (!items.length) {
    box.innerHTML = '<div class="empty"><div class="empty-mark">✓</div>没有异常</div>';
    return;
  }
  items.forEach((it) => {
    const g = el('div', 'conflict-group');
    const head = el('div', 'cg-head');
    head.appendChild(el('span', 'cg-slot', it.d));
    g.appendChild(head);
    const m = el('div', 'cg-members');
    m.appendChild(el('div', 'cg-val', it.t));
    if (it.raw) m.appendChild(el('div', 'cg-src', String(it.raw).slice(0, 400)));
    g.appendChild(m);
    box.appendChild(g);
  });
}

// --- 步骤 5：导出 --------------------------------------------------------

async function pickTarget() {
  const dir = await window.forge.openDirectory();
  if (!dir) return;
  S.targetDir = dir;
  $('#targetHint').textContent = dir;
  await refreshPreview();
}

async function refreshPreview() {
  if (!S.targetDir) return;
  const startSeq = (S.palaceInfo && S.palaceInfo.maxSeq ? S.palaceInfo.maxSeq : 0) + 1;
  const alive = S.cards.filter((c) => !c._dropped);
  const pv = await window.forge.previewExport({ cards: alive, startSeq });

  const box = $('#exportPreview');
  box.innerHTML = '';
  if (!alive.length) {
    box.appendChild(el('div', 'hint', '没有可导出的卡片'));
    $('#btnExport').disabled = true;
    return;
  }

  const stats = el('div', 'stats-row');
  stats.appendChild(statNode('将写入', pv.ok.length, 'good'));
  Object.entries(pv.byType).forEach(([t, n]) => {
    stats.appendChild(statNode(typeLabel(t), n));
  });
  if (pv.rejected.length) {
    stats.appendChild(statNode('不合规', pv.rejected.length, 'danger'));
  }
  box.appendChild(stats);

  if (pv.rejected.length) {
    const w = el('div', 'result-box err');
    w.appendChild(el('div', 'rb-title', `${pv.rejected.length} 张卡片不合规`));
    w.appendChild(el('div', 'rb-detail',
      pv.rejected.slice(0, 5).map((r) => `${r.title}：${r.problems.join('；')}`).join(' | ')));
    box.appendChild(w);
  }

  const d = el('div', 'result-box');
  d.appendChild(el('div', 'rb-title', 'ID 分配预览'));
  d.appendChild(el('div', 'rb-detail',
    `${pv.ok[0] ? pv.ok[0].id : '—'} … ${pv.ok[pv.ok.length - 1] ? pv.ok[pv.ok.length - 1].id : '—'}` +
    `（seq.txt 将更新至 ${pv.nextSeq - 1}）`));
  box.appendChild(d);

  $('#btnExport').disabled = pv.ok.length === 0;
}

function statNode(label, value, tone) {
  const s = el('div', 'stat' + (tone ? ' ' + tone : ''));
  s.appendChild(el('div', 'stat-v', String(value)));
  s.appendChild(el('div', 'stat-k', label));
  return s;
}

async function doExport() {
  if (!S.targetDir) return;
  const btn = $('#btnExport');
  btn.disabled = true;
  $('#exportStatus').textContent = '写入中…';

  const startSeq = (S.palaceInfo && S.palaceInfo.maxSeq ? S.palaceInfo.maxSeq : 0) + 1;
  const alive = S.cards.filter((c) => !c._dropped);
  const res = await window.forge.writeExport({
    cards: alive,
    targetDir: S.targetDir,
    startSeq,
    mode: $('#cfgMode').value,
  });

  const box = $('#exportPreview');
  const result = el('div', 'result-box ' + (res.ok ? 'ok' : 'err'));
  if (res.ok) {
    result.appendChild(el('div', 'rb-title', `成功写入 ${res.written.length} 张卡片`));
    const byType = {};
    res.written.forEach((w) => {
      const seg = w.rel.split(/[\\/]/);
      const t = seg[1] || '';
      byType[t] = (byType[t] || 0) + 1;
    });
    result.appendChild(el('div', 'rb-detail',
      Object.entries(byType).map(([t, n]) => `${typeLabel(t)} ${n}`).join(' · ')));
    if (res.seqUpdated) result.appendChild(el('div', 'rb-detail', 'seq.txt 已同步更新'));
    if (res.failed.length) result.appendChild(el('div', 'rb-detail', `${res.failed.length} 张写入失败`));
    $('#exportStatus').textContent = '导出完成';
    log(`导出完成：${res.written.length} 张卡片写入 ${S.targetDir}`, 'ok');
    setTimeout(() => goStep(1), 1200);
  } else {
    result.appendChild(el('div', 'rb-title', `导出失败：${res.error}`));
    $('#exportStatus').textContent = '导出失败';
    btn.disabled = false;
  }
  box.appendChild(result);
}

// --- 事件绑定 -----------------------------------------------------------

function bind() {
  // Agent 连接
  $('#btnAgentLink').onclick = openSettings;

  // 步骤
  $('#btnNext').onclick = () => {
    const next = S.mode === 'trial' ? (S.step === 1 ? 3 : S.step + 1) : S.step + 1;
    if (S.step === 1 || S.step === 2 || S.step === 3) goStep(next);
  };
  $('#btnPrev').onclick = () => goStep(Math.max(1, S.step - 1));
  $$('.step').forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.step);
      if (n <= S.step + 1) goStep(n);
    };
  });

  // 模式切换
  $$('.mode-btn').forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  // 抽取执行方式切换
  $$('.exec-btn').forEach((b) => {
    b.onclick = () => setExecMode(b.dataset.exec);
  });

  // Agent 模式
  $('#btnMakeProbe').onclick = makeProbeTask;
  $('#btnSplitByProbe').onclick = splitByProbe;
  $('#btnCopyProbeInstruction').onclick = copyProbeInstruction;
  $('#btnSkipProbe').onclick = () => {
    log('已跳过探查，将用规则解析器切分。若发现内容丢失，可回头做探查。', 'warn');
    $('#agentTaskTitle').textContent = '第 2 步 · 抽取任务';
  };
  $('#btnMakeTask').onclick = makeTask;
  $('#btnAgentStatus').onclick = refreshAgentStatus;
  $('#btnAgentImport').onclick = importAgentResult;
  $('#btnCopyInstruction').onclick = copyInstruction;

  // 步骤 1 — 完整模式
  $('#btnPickFiles').onclick = pickFiles;
  $('#btnPickPalace').onclick = pickPalace;
  const dz = $('#dropzone');
  dz.onclick = pickFiles;
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = async (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    const paths = await window.forge.pathsFromDropped(e.dataTransfer.files);
    if (paths.length) {
      await loadFiles(paths);
    } else {
      dz.querySelector('.dz-sub').textContent = '未能读取拖入的文件，请点击选择';
    }
  };

  // 步骤 1 — 浅尝模式
  $('#btnPickTrialPalace').onclick = pickTrialPalace;
  $('#btnPreviewSample').onclick = inspectTrial;
  $('#trialStrategy').onchange = () => { updateStrategyHint(); inspectTrial(); };
  $('#trialScope').onchange = inspectTrial;
  $('#trialSizing').onchange = () => { updateAmountLabel(); inspectTrial(); };
  $('#trialAmount').onchange = inspectTrial;
  $('#btnShuffleSeed').onclick = () => {
    $('#trialSeed').value = String(Math.floor(Math.random() * 2 ** 31));
    inspectTrial();
  };

  // 步骤 3
  $('#btnDetect').onclick = detectModels;
  $('#btnTestModel').onclick = testModel;
  $('#btnExtract').onclick = startExtract;
  $('#btnCancel').onclick = () => {
    if (S.jobId) window.forge.cancelExtract(S.jobId);
    $('#btnCancel').disabled = true;
  };

  // 步骤 4
  const TAB_BODY = { cards: 'tabCards', conflicts: 'tabConflicts', baseline: 'tabBaseline', errors: 'tabErrors' };
  $$('.tab').forEach((t) => {
    t.onclick = () => {
      S.activeTab = t.dataset.tab;
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      Object.entries(TAB_BODY).forEach(([k, id]) => {
        const body = document.getElementById(id);
        if (body) body.classList.toggle('active', k === S.activeTab);
      });
    };
  });
  Object.entries(TAB_BODY).forEach(([k, id]) => {
    const body = document.getElementById(id);
    if (body) body.classList.toggle('active', k === S.activeTab);
  });
  $('#cardFilter').oninput = renderCardTable;
  $('#cardTypeFilter').onchange = renderCardTable;
  $('#chkAll').onchange = (e) => {
    S.cards.forEach((c) => { c._dropped = !e.target.checked; c._edited = true; });
    renderReview();
  };
  $('#btnDropAll').onclick = () => {
    S.cards.forEach((c) => { c._dropped = true; });
    renderReview();
  };
  $('#btnCopyReport').onclick = copyReport;
  $('#btnToFull').onclick = commitToFull;

  // 步骤 5
  $('#btnPickTarget').onclick = pickTarget;
  $('#btnExport').onclick = doExport;
  $('#cfgMode').onchange = () => { if (S.targetDir) refreshPreview(); };

  // 主进程事件
  window.forge.onExtractProgress(onExtractProgress);
  window.forge.onExtractDone(onExtractDone);
  window.forge.onExtractError(onExtractError);
  window.forge.onExtractCancelled(() => {
    S.extracting = false;
    $('#btnExtract').disabled = false;
    $('#btnCancel').hidden = true;
    log('任务已取消', 'warn');
  });
  window.forge.onExtractFailed(onExtractFailed);
}

function updateStrategyHint() {
  const meta = S.strategies && S.strategies[$('#trialStrategy').value];
  $('#trialStrategyHint').textContent = meta ? meta.hint : '';
}

function updateAmountLabel() {
  const isRatio = $('#trialSizing').value === 'ratio';
  $('#trialAmountLabel').textContent = isRatio ? '抽样比例（%）' : '抽样数量';
  $('#trialAmount').value = isRatio ? 20 : 20;
  $('#trialAmount').max = isRatio ? '100' : '';
  $('#trialAmount').min = isRatio ? '1' : '1';
  $('#trialAmount').step = isRatio ? '1' : '1';
  $('#trialAmountHint').textContent = isRatio
    ? '按候选池的百分比抽样，实际条数向上取整'
    : '从候选池中抽取的条数，超出库容量时会自动下调';
}

// --- 启动 ---------------------------------------------------------------

(async function init() {
  bind();
  setMode('full');
  setExecMode('agent');   // 默认交给 agent，零配置
  goStep(1);
  refreshAgentStatus();

  try {
    const t = await window.forge.getTypes();
    S.typeKeys = t.types.map((x) => x.key);
    const sel = $('#cardTypeFilter');
    t.types.forEach((x) => {
      const o = document.createElement('option');
      o.value = x.key;
      o.textContent = `${x.label} · ${x.key}`;
      sel.appendChild(o);
    });
  } catch (err) {
    console.error('元信息加载失败', err);
  }

  // 浅尝模式的策略与筛选范围元数据
  try {
    const m = await window.forge.getStrategies();
    S.strategies = m.strategies;
    S.scopes = m.scopes;

    const st = $('#trialStrategy');
    Object.entries(m.strategies).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.label;
      st.appendChild(o);
    });

    const sc = $('#trialScope');
    Object.entries(m.scopes).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.label;
      sc.appendChild(o);
    });

    updateStrategyHint();
    updateAmountLabel();
  } catch (err) {
    console.error('抽样策略元数据加载失败', err);
  }

  renderFiles();
  renderReview();
})();
