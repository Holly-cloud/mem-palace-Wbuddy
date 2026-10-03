'use strict';
/**
 * 连接设置页逻辑。
 *
 * 核心判断：这个工具没有内置模型，必须由 Agent 驱动。
 * 所以页面的主线是「工具 ↔ Agent 的连接」，而不是「配置模型」。
 * 四个阶段：选 Agent → 检测状态 → 注册 MCP → 确认可用。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const S = {
  agent: 'hermes',
  detect: null,
  tools: [],
  filterEnabled: false,
  // 常用工具：覆盖完整的最小闭环（探查 → 切分 → 抽取 → 导入），
  // 其余（检索、体检、类型查询）交给 GUI 或按需开放
  COMMON_TOOLS: [
    'forge_probe_start',
    'forge_probe_read_sample',
    'forge_probe_write_recipe',
    'forge_split_by_recipe',
    'forge_task_read_chunk',
    'forge_task_write_result',
    'forge_import_results',
  ],
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- 1. Agent 选择 -------------------------------------------------------

async function loadAgents() {
  const res = await window.forge.listAgents();
  const box = $('#agentList');
  box.innerHTML = '';

  res.agents.forEach((a) => {
    const card = el('div', 'agent-card' + (a.key === S.agent ? ' active' : ''));
    card.appendChild(el('span', 'ac-radio'));

    const body = el('div', 'ac-body');
    const name = el('div', 'ac-name');
    name.appendChild(el('span', '', a.label));
    name.appendChild(el('span', 'ac-badge', a.status));
    body.appendChild(name);

    const notes = el('ul', 'ac-notes');
    (a.notes || []).forEach((n) => notes.appendChild(el('li', '', n)));
    body.appendChild(notes);

    body.appendChild(el('p', 'field-hint', `文档：${a.docsUrl}`));
    card.appendChild(body);

    card.onclick = () => { S.agent = a.key; loadAgents(); detectAgent(); };
    box.appendChild(card);
  });
}

// --- 2. 检测 -------------------------------------------------------------

async function detectAgent() {
  const res = await window.forge.detectAgent(S.agent);
  S.detect = res;
  renderDetect();
}

function renderDetect() {
  const r = S.detect;
  $('#statusBlock').hidden = false;
  const box = $('#detectPanel');
  box.innerHTML = '';

  if (!r || !r.ok) {
    const row = el('div', 'detect-row');
    row.appendChild(el('span', 'dr-label', '检测'));
    row.appendChild(el('span', 'dr-err', (r && r.error) || '未知错误'));
    box.appendChild(row);
    setStatus('err', '检测失败');
    return;
  }

  const rows = [
    ['安装状态', r.installed,
      r.installed ? `已安装${r.version ? `（版本 ${r.version}）` : ''}` : '未检测到 ~/.hermes 目录'],
    ['配置文件', r.configExists ? r.configPath : `${r.configPath}（尚未创建）`,
      r.configExists ? '' : '首次配置时会自动创建', r.configExists],
    ['MCP 注册', r.registered ? '已注册 memory_forge' : '未注册',
      '', r.registered],
    ['工具前缀', r.toolPrefix, '', true],
    ['重载方式', r.reloadHint, '', true],
  ];

  rows.forEach(([label, value, note, ok]) => {
    const row = el('div', 'detect-row');
    row.appendChild(el('span', 'dr-label', label));
    const cls = ok === true ? 'dr-ok' : ok === false ? 'dr-err' : '';
    const v = el('span', `dr-value ${cls}`.trim(), value);
    row.appendChild(v);
    if (note) {
      const n = el('span', 'hint', note);
      row.appendChild(n);
    }
    box.appendChild(row);
  });

  // 顶部状态灯
  if (!r.installed) {
    setStatus('err', '未检测到 hermes');
  } else if (!r.registered) {
    setStatus('warn', '已安装，未配置 MCP');
  } else {
    setStatus('ok', '已连接');
  }

  // 配置区块
  $('#configBlock').hidden = false;
  renderSnippet();
  renderTools();
  if (r.registered) showNextSteps(['配置已写入。若 Agent 未看到新工具，执行 ' + r.reloadHint + ' 或重启。']);
}

function setStatus(kind, text) {
  const pill = $('#statusPill');
  pill.className = `status-pill ${kind}`;
  $('#statusText').textContent = text;
}

// --- 3. 配置片段 ---------------------------------------------------------

async function renderSnippet() {
  const filter = S.filterEnabled ? S.COMMON_TOOLS : null;
  const res = await window.forge.previewSnippet({ agent: S.agent, toolFilter: filter });
  $('#snippet').textContent = res.snippet;
  $('#snippetPath').textContent = (S.detect && S.detect.configPath) || '';

  if (!res.serverExists) {
    const box = $('#installResult');
    box.innerHTML = '';
    const e = el('div', 'result-box err');
    e.appendChild(el('div', 'rb-title', 'MCP server 脚本不存在'));
    e.appendChild(el('div', 'rb-detail', res.serverPath));
    box.appendChild(e);
    $('#btnInstall').disabled = true;
  } else {
    $('#installResult').innerHTML = '';
    $('#btnInstall').disabled = false;
  }
}

// --- 4. 工具清单 ---------------------------------------------------------

async function renderTools() {
  $('#toolsBlock').hidden = false;
  const res = await window.forge.listMcpTools();
  S.tools = res.tools;

  const box = $('#toolList');
  box.innerHTML = '';
  res.tools.forEach((t) => {
    const on = !S.filterEnabled || S.COMMON_TOOLS.includes(t.name);
    const item = el('div', 'tool-item' + (on ? '' : ' filtered'));

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = on;
    chk.className = 'ti-check';
    chk.onchange = () => {
      if (chk.checked) {
        S.COMMON_TOOLS = [...new Set([...S.COMMON_TOOLS, t.name])];
      } else {
        S.COMMON_TOOLS = S.COMMON_TOOLS.filter((n) => n !== t.name);
      }
      renderTools();
      renderSnippet();
    };
    item.appendChild(chk);

    const body = el('div');
    body.appendChild(el('div', 'ti-name', t.name));
    body.appendChild(el('div', 'ti-desc', t.description));
    if (t.required && t.required.length) {
      const req = el('div', 'ti-req');
      req.innerHTML = '必填：' + t.required.map((r) => `<code>${escapeHtml(r)}</code>`).join(' ');
      body.appendChild(req);
    }
    item.appendChild(body);
    box.appendChild(item);
  });
}

// --- 安装 / 卸载 / 自检 ---------------------------------------------------

async function installConfig() {
  const btn = $('#btnInstall');
  btn.disabled = true;
  btn.textContent = '写入中…';

  const filter = S.filterEnabled ? S.COMMON_TOOLS : null;
  const res = await window.forge.installAgentConfig({ agent: S.agent, toolFilter: filter });

  btn.disabled = false;
  btn.textContent = '自动写入配置';

  const box = $('#installResult');
  box.innerHTML = '';
  const e = el('div', 'result-box ' + (res.ok ? 'ok' : 'err'));

  if (!res.ok) {
    e.appendChild(el('div', 'rb-title', res.error));
    if (res.hint) e.appendChild(el('div', 'rb-detail', res.hint));
    box.appendChild(e);
    return;
  }

  const actionLabel = {
    created: '已创建配置文件', appended: '已追加到配置',
    updated: '已更新已有配置', 'section-created': '已新增 mcp_servers 段',
  };
  e.appendChild(el('div', 'rb-title', `${actionLabel[res.action] || res.action}`));
  e.appendChild(el('div', 'rb-detail', res.configPath));

  if (res.selfTest) {
    if (res.selfTest.ok) {
      e.appendChild(el('div', 'rb-detail',
        `连接自检通过：协议 ${res.selfTest.protocolVersion}，${res.selfTest.toolCount} 个工具已注册`));
    } else {
      e.appendChild(el('div', 'rb-detail', `配置已写入，但自检失败：${res.selfTest.error}`));
    }
  }

  box.appendChild(e);
  await detectAgent();
  showNextSteps(res.nextSteps);
}

async function uninstallConfig() {
  if (!confirm('确定要从 Agent 配置中移除 memory_forge 吗？\n（会自动备份为 .forge-backup）')) return;
  const res = await window.forge.uninstallAgentConfig(S.agent);
  const box = $('#installResult');
  box.innerHTML = '';
  const e = el('div', 'result-box ' + (res.ok ? 'ok' : 'err'));
  e.appendChild(el('div', 'rb-title', res.ok ? '配置已移除' : res.error));
  if (res.ok && res.action === 'not-installed') {
    e.appendChild(el('div', 'rb-detail', '配置中本来就没有 memory_forge'));
  }
  box.appendChild(e);
  $('#nextBlock').hidden = true;
  await detectAgent();
}

async function selfTest() {
  const btn = $('#btnSelfTest');
  btn.disabled = true;
  btn.textContent = '自检中…';
  const res = await window.forge.selfTestMcp();
  btn.disabled = false;
  btn.textContent = '连接自检';

  const box = $('#installResult');
  box.innerHTML = '';
  const e = el('div', 'result-box ' + (res.ok ? 'ok' : 'err'));
  if (res.ok) {
    e.appendChild(el('div', 'rb-title', 'MCP server 响应正常'));
    e.appendChild(el('div', 'rb-detail',
      `${res.serverInfo.name} v${res.serverInfo.version}　协议 ${res.protocolVersion}　工具 ${res.toolCount} 个`));
    e.appendChild(el('div', 'rb-detail', '工具：' + res.tools.join(', ')));
  } else {
    e.appendChild(el('div', 'rb-title', '自检失败'));
    e.appendChild(el('div', 'rb-detail', res.error));
    if (res.stderr) e.appendChild(el('div', 'rb-detail', res.stderr));
  }
  box.appendChild(e);
}

async function copySnippet() {
  const text = $('#snippet').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const e = el('div', 'result-box ok');
    e.appendChild(el('div', 'rb-title', '已复制到剪贴板'));
    e.appendChild(el('div', 'rb-detail', '粘贴到 ~/.hermes/config.yaml 的 mcp_servers 段下即可'));
    const box = $('#installResult');
    box.innerHTML = '';
    box.appendChild(e);
  } catch (err) {
    const e = el('div', 'result-box err');
    e.appendChild(el('div', 'rb-title', '复制失败：' + err.message));
    e.appendChild(el('div', 'rb-detail', '请手动选中上方配置片段'));
    const box = $('#installResult');
    box.innerHTML = '';
    box.appendChild(e);
  }
}

function showNextSteps(steps) {
  $('#nextBlock').hidden = false;
  const ol = $('#nextSteps');
  ol.innerHTML = '';
  (steps || []).forEach((s) => {
    const li = el('li');
    li.innerHTML = escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(hermes mcp \w+[\w ]*)/g, '<code>$1</code>');
    ol.appendChild(li);
  });

  const usage = $('#usageHint');
  usage.innerHTML = `
    <strong>连接后怎么用</strong>
    <ul>
      <li>直接对 Agent 说「用 memory forge 把这几个记忆文件整理成记忆卡片」，
          Agent 会自动调用 <code>forge_probe_start</code> 开始</li>
      <li>Agent 会先勘察格式，再逐块抽取，最后汇总冲突给你裁决</li>
      <li>想看 Agent 有哪些工具：在 Agent 里问「你有哪些 forge 开头的工具」</li>
      <li>GUI 仍然可用，两条路径共享同一套引擎</li>
    </ul>`;
}

// --- 启动 ----------------------------------------------------------------

(async function init() {
  $('#btnInstall').onclick = installConfig;
  $('#btnUninstall').onclick = uninstallConfig;
  $('#btnSelfTest').onclick = selfTest;
  $('#btnCopy').onclick = copySnippet;
  $('#filterEnabled').onchange = (e) => {
    S.filterEnabled = e.target.checked;
    renderTools();
    renderSnippet();
  };

  await loadAgents();
  await detectAgent();
})();
