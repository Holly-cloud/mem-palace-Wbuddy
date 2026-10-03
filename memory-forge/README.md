# 记忆铸造厂 · Memory Forge

把任意格式的 Agent 记忆文本，转换为结构化的记忆卡片库。

面向的场景：你手里有一堆杂乱的 Agent 记忆（Markdown 笔记、对话导出、JSON 配置、日志、纯文本片段），想迁入 [memory-palace](../memory-palace) 那套结构化体系，但又不想手工整理。

**内置大语言模型能力** —— 抽取由 Agent 执行，工具本身不含模型。
通过 MCP 与 Agent 连接，无需配置任何 API Key。

**三种运行模式**：
- **完整模式** — 处理你选定的文件，全量输出并可导出
- **浅尝模式** — 从已有记忆库抽样试运行，只读不写，先看效果再决定是否全量
- **探查模式** — 格式不统一时，先让 agent 勘察结构再切分

---

## 特点

| | |
|---|---|
| **Agent 驱动** | 工具不含模型，抽取由 Agent 完成。通过 MCP 连接，无需 API Key |
| **格式探查** | Agent 记忆格式千差万别，让 agent 先勘察结构、产出切分配方，避免规则解析丢内容 |
| **两种执行方式** | Agent 驱动（默认）；也可直连 Ollama / OpenAI 兼容端点 / Claude |
| **格式不限** | Markdown / 纯文本 / JSON / JSONL / 日志 / YAML / CSV / 对话导出 / Codex 会话 |
| **浅尝模式** | 从真实记忆库抽样试运行，全程只读，确认后再转全量 |
| **冲突可见** | 与已有记忆库对比，同一 slot 的矛盾会被检出并要求你裁决，不自动决定 |
| **格式可靠** | 输出与 memory-palace 的 schema 严格对齐，导出的文件可被 CLI 直接读取 |
| **可追溯** | 每张卡片记录来自哪个文件、哪个片段 |

---

## 快速开始

```bash
npm install
./start.sh          # 启动 GUI
```

首次使用**先配置 Agent 连接**：点右上角「未检测到 hermes」那个入口 →
「自动写入配置」→ 在 hermes 会话里 `/reload-mcp`。

```bash
npm test            # 全部 522 项测试
```

---

## 与 Agent 的连接（MCP）

**这个工具本身不运行推理。** 它没有内置模型 —— 抽取靠 Agent，工具只负责解析、切分、校验、去重、冲突检测这些确定性工作。

所以「工具 ↔ Agent 的连接」是使用前提，而不是可选项。配置在独立的「连接设置」窗口（主界面右上角入口）。

### 为什么用 MCP 而不是让 Agent 走 CLI

走 CLI 的话，Agent 需要知道工具装在哪、命令怎么拼、中间产物落在哪。这些都是实现细节，每轮都得重新推断，猜错就整条流程断掉。

走 MCP，Agent 只需理解一件事：**有哪些工具、各自做什么**。路径、参数、文件名规则全由 server 内部维护。

工具名语义化到可以直接当自然语言用，比如 `forge_read_chunk`。

### 接入 hermes（三步）

GUI 里点「自动写入配置」即可，也可以手动把配置片段加到 `~/.hermes/config.yaml`：

```yaml
mcp_servers:
  memory_forge:
    command: "node"
    args: ["/绝对路径/memory-forge/bin/forge-mcp.js"]
    enabled: true
    timeout: 300
```

然后在 hermes 会话里执行 `/reload-mcp`，用 `hermes mcp list` 确认连接。

工具会以 `mcp__memory_forge__<name>` 的形式出现在 Agent 工具列表里。

### 12 个工具

| 分组 | 工具 | 用途 |
|---|---|---|
| 勘察 | `forge_probe_start` | 勘察文件格式，生成探查任务 |
| | `forge_probe_read_sample` | 读结构采样（头尾片段 + 客观统计） |
| | `forge_probe_write_recipe` | 写切分配方 |
| | `forge_probe_status` | 查探查进度 |
| 切分 | `forge_split_by_recipe` | 按配方切分，生成抽取任务 |
| 抽取 | `forge_task_start` | 跳过探查直接生成任务 |
| | `forge_task_read_chunk` | 读一个分块的内容 |
| | `forge_task_write_result` | 提交某块的抽取结果 |
| | `forge_import_results` | 导入结果、跑下游管线、可选写盘 |
| 记忆库 | `forge_palace_doctor` | 体检记忆库 |
| | `forge_palace_search` | 检索已生效的记忆 |
| | `forge_list_types` | 列出类型与字段规则 |

设置页可以只暴露常用工具 —— 全量 12 个会占用 Agent 上下文，筛到 7 个能省下一半。

### Agent 的典型用法

```
你：用 memory forge 把这三个记忆文件整理成记忆卡片
Agent：（自动调用 forge_probe_start 勘察格式）
      （若格式复杂，调用 forge_probe_read_sample 后写配方）
      （forge_split_by_recipe 切分）
      （逐块 forge_task_read_chunk → 理解 → forge_task_write_result）
      （forge_import_results 汇总，报告冲突）
```

工作流的全部知识固化在工具语义与返回值里（`nextSteps` 字段），Agent 不需要知道文件放在哪。

### 配置写入是安全的

写 `~/.hermes/config.yaml` 时用**文本级最小插入**，不做「解析 YAML → 修改 → 序列化」：

- 不引入 yaml 依赖
- 任何序列化差异都不会改写用户的其他配置
- 逐行锚定条目边界，重复安装是更新而非追加
- 自动备份为 `.forge-backup`

测试覆盖了 6 种场景：新建、追加到已有段、重复安装、无 `mcp_servers` 段、备份、卸载——每种都验证了**原有配置未被破坏**。

---

## 快速开始

```bash
npm install
./start.sh          # 启动 GUI
npm test            # 全部 390 项测试
```

**建议用 `start.sh`**。它处理两个常见障碍：

- `ELECTRON_RUN_AS_NODE=1` 被环境预设时，Electron 会退化成纯 Node 运行时，报 `Cannot read properties of undefined (reading 'whenReady')`。这个变量在 Electron 启动**前**就被读取，主进程代码无法补救，只能由启动脚本剥离。
- 无显示环境（服务器 / 容器 / 远程会话）会崩在 `GPU process isn't usable`，脚本自动降级为软件渲染。

首次使用建议直接体验 agent 模式：进入第 3 步点「生成任务包」，把生成的指令粘给你的 agent 即可。
如果你更想走自建模型，第 3 步右上角可切到「直连模型 API」，点「探测可用模型」会自动列出 Ollama 已安装的模型。

---

## 格式探查（格式不统一时）

### 为什么需要这一步

Agent 记忆的格式远比「Markdown / JSON / 日志 / 纯文本」四种能概括。规则解析器只能靠正则猜边界，
遇到没见过的结构就会出问题。举个具体例子 —— Codex / Claude Code 的会话行长这样：

```jsonl
{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我重构记忆模块"}]}
```

规则解析器只取顶层字符串字段，于是留下 `type=message`、`role=user`，
而**真正有意义的内容「帮我重构记忆模块」藏在数组里，被完全丢弃** —— 而且是静默丢弃，
不报错、不告警。这类结构没法用正则穷举。

实测四种常见格式下规则解析的表现：

| 文件 | 规则判定 | 结果 |
|---|---|---|
| `chatgpt-export.json` | json | 记录混进 role/timestamp，丢失「谁说的话」 |
| `codex-session.jsonl` | jsonl | **内容全部丢失**（在 `content[].text` 里） |
| `settings.yaml` | text | 完全不识别 |
| `memories.csv` | text | 表头与数据行混在一起 |

### 职责边界

```
agent 判断「这是什么结构、该怎么切」→ 产出配方（recipe）
引擎执行「按配方切分」          → 保证确定性与可复现
```

agent 给的是**声明式配方**而不是代码。这样切分过程可审计、可复现，
agent 也不会因为写错代码而破坏流程。判断错时改配方即可，不必重跑任何模型。

### 用法

```bash
# 1. 生成探查任务包（含文件采样 + 结构统计）
forge probe codex.jsonl chat-export.json memories.csv settings.yaml

# 2. agent 读 INSTRUCTIONS.md 与 samples/*.json，为每个文件写配方到 recipes/

# 3. 按配方切分，生成抽取任务包
forge split ./forge-probe-xxx --out ./task1

# 4. 后续与常规抽取流程相同
forge import ./task1 --write ~/memory-palace
```

辅助命令：

```bash
forge probe-status ./forge-probe-xxx   # 看进度
```

GUI 里在第 3 步有「格式探查（可选）」卡片，点「生成探查任务包」即可。

**格式已知时可以跳过这步** —— 常见的 Markdown / 日志直接 `forge task` 即可。

### 探查会给 agent 看什么

不给全文，只给**结构采样**（大文件会撑爆上下文，而判断格式靠结构特征而非具体内容）：

- 头部 3000 字符 + 尾部 1200 字符
- 结构统计：`jsonLineRate`（多少行是合法 JSON）、`nestedContentLines`（含嵌套内容数组的行数）、
  `roleMarkers`（对话角色出现次数）、`csvLike`、`yamlLikeKeys`、`timestampRatio`、`headingCount`
- 规则解析器的猜测（供参考或推翻）

命令行还会打印一份速览，并对**可能丢内容**的文件告警：

```
codex-session.jsonl    253 字符  JSONL 对话 嵌套内容
                       规则猜测: jsonl  ⚠ 检测到 2 行含嵌套内容数组，规则解析会丢失
```

### 配方格式

```json
{
  "file": "codex-session.jsonl",
  "strategy": "jsonl",
  "fields": { "角色": "role", "内容": "content[].text" },
  "includeMeta": ["type"],
  "note": "Codex 会话格式，真实内容在 content[].text 数组里"
}
```

`fields` 的路径支持 `a.b` 与 `a[].text`（取数组内每个元素的 text）。
**只有显式写 `[]` 才展开数组** —— 不带 `[]` 的路径保持常规取值行为，字段类型不可预知时也不丢数据。

可用策略：`lines` / `jsonl` / `json_array` / `conversation` / `record_separator` /
`markdown` / `yaml` / `csv` / `log` / `blank_line` / `whole`

### 切分效果对比

同一个 Codex 会话文件，两种方式的关键信息保留情况：

```
关键信息是否保留：
  + "帮我重构"   规则:无  配方:有      ← 规则解析完全丢弃的内容
  = "结论先行"   规则:有  配方:有
```

配方切分在保证不丢内容的前提下，还能按 agent 指定的字段映射把结构渲染得更清晰：

```
角色: user
内容: 帮我重构记忆模块
type: message
```

### 未提交配方的兜底

没有提交配方、或配方不合法时，该文件自动退回规则解析器，并在输出里明确标注：

```
[配方]   codex-session.jsonl   jsonl        3 条 → 1 块
[兜底]   chat.log              fallback:log 42 条 → 3 块   ⚠ 未提交探查配方，已用规则解析器兜底
```

不丢数据，也不静默 —— 你会明确看到哪些文件走了兜底。

### 规则解析器也做了增强

探查不是唯一防线。即使跳过探查，规则解析器也比之前强：

| 改进 | 效果 |
|---|---|
| JSON/JSONL 递归收集字符串叶子 | `content[].text` 这类嵌套内容不再丢失 |
| 新增 YAML / CSV 格式识别 | 配置文件与记忆表不再被当成纯文本 |
| CSV 正确处理引号与分隔符 | `含,逗号`、`含"引号"`、TSV 都能解析 |

这意味着：即使不做探查，Codex 会话的内容也不会再被静默丢弃（路径会以
`content.text: ...` 的形式呈现，比配方切分粗糙，但信息完整）。

---

## Agent 驱动模式（推荐）

### 为什么这样设计

原方案要求你自己准备模型端点与 API Key。这是整个工具里门槛最高的一环：
装模型、配 endpoint、填 Key、调并发 —— 任何一步不通就卡住。

但你已经在跟一个 agent 打交道了，那个 agent 本身就带着模型能力，何必再折腾一遍。

所以把职责切开：

```
agent 负责「理解」 —— 从文本里判断什么值得长期记住
引擎负责「机械」 —— 解析、切分、schema 校验、去重、冲突检测、导出
```

这条边界很重要：**判断交给 agent，但凡是能确定性完成的部分一律不外包**，
否则结果不可复现，也无法审计。

### 命令行用法（agent 更适合）

CLI 是给 agent 准备的主路径 —— agent 用 shell 比驱动 GUI 可靠得多，
可以一次跑完「生成任务包 → 逐块读取 → 写出结果 → 导入」，
中途失败也能精确重跑某一步。

```bash
# 1. 生成任务包
node bin/forge.js task notes.md chat.log --out ./task1

# 2. 读 ./task1/INSTRUCTIONS.md，按里面规范逐块处理
#    读 ./task1/chunks/*.md，结果写进 ./task1/results/*.result.json

# 3. 导入（不写盘，先看统计）
node bin/forge.js import ./task1

# 4. 确认无误后写入记忆库
node bin/forge.js import ./task1 --write ~/memory-palace
```

辅助命令：

```bash
forge status ./task1                                        # 看进度，支持分批处理
forge validate ./task1/results/001-notes.result.json       # 单独校验一个结果文件
forge types                                                 # 列出类型与字段要求
forge task --trial --palace ~/memory-palace --count 20 --out ./trial1   # 浅尝模式
forge import ./task1 --json                                 # JSON 输出，便于程序处理
```

`--write` 缺省时**不写任何文件**，只做校验与统计。写盘前会先告诉你卡片数、去重数、冲突数。

### GUI 用法

第 3 步默认就是「交给 Agent 处理」：

1. **生成任务包** —— 点一下，工具切好分块并生成抽取规范
2. **交给 Agent** —— 界面给出一段现成的指令，点「复制指令」粘给你的 agent
3. **导入结果** —— agent 写完 `results/` 后回到这里导入

也可以切到「直连模型 API」走原来的路径。

### 任务包结构

```
task1/
├── INSTRUCTIONS.md       抽取规范（agent 读这个）
├── manifest.json         分块清单、任务 ID、进度基准
├── ALL.md                所有分块合并（想一次读完的 agent 用）
├── chunks/
│   ├── 001-notes.md      单块原文，带 record 定位
│   └── 002-chat.md
└── results/
    ├── 001-notes.result.json    ← agent 写这里
    └── 002-chat.result.json
```

### 为什么分块存放

agent 有上下文限制，几千条记忆不可能一次读完。分块让 agent 能：

- 一次处理一块，串行推进
- 中断后从断点继续（`forge status` 看清哪些块已完成）
- 只重跑失败的那几块，不必全量重来

### agent 输出的容错

agent 不会严格照搬格式，实际会遇到的偏差都做了吸收：

| 偏差 | 处理 |
|---|---|
| 包在 ```json 围栏里 | 自动剥离 |
| 前后带解说文字 | 扫描配平括号提取 |
| 直接输出数组而非 `{"cards":[]}` | 识别三种数组形态 |
| 用 `content` / `category` / `name` 代替 `body` / `type` / `title` | 字段别名映射 |
| `subject` 与 `predicate` 合成一个 `slot` 字段 | 拆回两个字段 |
| type 写成中文「偏好」 | 归一到 `preference` |
| tags 写成逗号分隔字符串 | 拆成数组 |
| 某块无内容 | 写 `{"cards": []}` 即可，是合法结果 |

只有**缺必填字段**才会被过滤，且会明确报出原因。
schema 警告（如正文超长）不丢弃，而是记录下来交给人判断。

纯元信息分块（只有文件头、无实质内容）会被标记为可跳过，agent 直接写空结果即可，不浪费一次往返。

### 与直连模式的关系

两种模式**下游完全一致**：导入的卡片走的是同一套 `dedupe → 冲突检测 → 审查 → 导出`，
代码路径一字不差，所以产出可以直接对比。

抽取规范也共用一套 —— `INSTRUCTIONS.md` 由直连模式的 `SYSTEM_PROMPT` 生成，不会各自漂移。

---

---

## 浅尝模式

从已有记忆库抽样一小批，跑一遍完整流程看效果。**全程只读，绝不写入目标记忆库。**

进入第 1 步后切换到「浅尝模式」，选择目标记忆库目录即可。

### 抽样怎么接进现有流程

浅尝模式**没有引入任何新的整理逻辑**，只在管线前面多了一个「取样与还原」环节：

```
完整模式：文件 → parseContent ─────────────┐
                                          ├→ chunkRecords → extractAll → 去重 → 冲突检测 → 报告
浅尝模式：记忆库 → loadPalace → 抽样 → 还原为 records ─┘
```

具体实现（`src/engine/sampler.js` + `main.js` 的 `buildChunks`）：

1. `validateTarget()` 校验路径，读取卡片（只读）
2. `planSample()` 按策略抽样，产出抽样计划
3. `sampleToRecords()` 把抽样卡片**还原成记忆文本**，构造出与 `parseContent` 产物同构的 Record[]
4. 之后完全走既有管线，产出的报告字段名与格式也完全一致

关键在于还原这一步。刻意把卡片渲染成朴素文本（`[记忆卡 mem_00042]` / `类型:` / `主张:` …）再喂给抽取器，而不是把卡片对象直接塞进结果——这样试运行走的是和真实记忆文件完全一样的解析路径，抽取环节的输入形态一致，试运行结果才有参考价值。

> 实现细节：`sampleToRecords()` 直接构造 Record，而**不是**把文本拼起来再交给 `parseContent`。因为 `parseContent` 会按标题层级合并段落，多张卡片拼成的文本会被并成一个块，导致「一条记录 = 一张记忆卡」的对应关系丢失、溯源失效。直接构造则保证一卡一条。

### 抽样参数

| 参数 | 取值 | 说明 |
|---|---|---|
| 抽样策略 | `random` | 等概率随机抽。适合快速验证流程是否跑通 |
| | `stratified` | 按记忆类型分层，保证每种类型都有代表。适合预览归类效果 |
| | `slot` | 每个 slot 至多取 1 条，最大化 slot 覆盖。**最容易暴露潜在冲突** |
| 抽样方式 | 按数量 / 按比例 | 二选一；同时给时以比例为准 |
| 状态范围 | `active` | 只抽当前生效的记忆（默认） |
| | `all` | 含 superseded / expired / disputed |
| 随机种子 | 整数，可留空 | 留空则随机生成。**填相同种子可复现同一批样本**，便于对比不同模型或参数的效果 |

界面在选中记忆库后实时预览抽样计划（将抽多少条、覆盖率多少、样本长什么样），改任一参数立即重算。

### 预览输出什么

试运行完成后面板按四组信息展示：

**抽样参数** — 策略、状态范围、抽样数 / 候选池、随机种子

**组织结构** — 样本按记忆类型的条形分布、覆盖的唯一 slot 数

**抽取结果** — 产出卡片数、通过校验数、去重合并数、冲突 slot 数、出错分块数

**归类分布** — 产出卡片按类型的分布（条形图）

外加两类提示：

- **告警** — 抽样数超容量被下调、样本量不足以覆盖全部类型等
- **冲突清单** — 样本内检出的 slot 冲突，带各方的值与建议动作

顶部有一句话摘要，形如：

> 从 128 张记忆中抽样 20 张（分层抽样，占候选池 18%）；产出 17 张结构化卡片；去重 3 条；发现 2 处 slot 冲突；覆盖 16 个 slot、4 种类型。

面板右上角「浅尝结果」徽标 + 绿色只读底色，与完整模式的界面明确区分。

### 确认后如何转全量

点「按此参数运行全量」，工具会：

1. 固化模型、分块预算、抽取侧重这些参数
2. **清空抽样参数**——全量就是全量，不该再抽样
3. 切回完整模式，回到第 1 步重新选来源

「复制摘要」可把结果摘要与冲突清单复制到剪贴板，方便贴到笔记或提交给同事看。

### 只读保证

三层防护，写盘这个危险动作放在主进程而非界面，因为不能依赖界面是否正确传参：

| 层 | 机制 |
|---|---|
| 引擎层 | `sampler` 模块只调用 `loadPalace`（只读）与 `readFile`，无任何写操作 |
| 主进程 | `export:write` 开头检查 `mode`，`trial` / `preview` 直接返回错误，不执行任何写入 |
| 界面层 | 浅尝模式下导出面板整体隐藏，步骤 3、5 显示只读提示条 |

测试用目录快照逐文件比对，验证试运行全程（含抽样、解析、抽取、去重、冲突检测、报告生成）未修改、未新增、未删除任何文件。

### 边界情况

| 情况 | 行为 |
|---|---|
| 路径不存在 | `NOT_FOUND` — 「记忆库路径不存在」+ 提示确认拼写 |
| 路径是文件不是目录 | `NOT_A_DIRECTORY` — 提示应选记忆库根目录 |
| 无读取权限 | `NO_PERMISSION` — 提示检查目录权限 |
| 目录存在但没有卡片 | `NO_CARDS` — 提示确认这是 palace 根目录 |
| 有卡片但无 active | `NO_MATCHING` — 提示放宽筛选范围 |
| 抽样数量超容量 | **自动下调到池大小**，附 `SAMPLE_CLAMPED` 告警说明，不静默截断 |
| 数量填 0 / 负数 | `NO_SAMPLE` — 明确报错，不静默替换成默认值 |
| 比例不在 0~1 | `BAD_RATIO` — 明确报错 |
| 比例过小（如 0.1%） | **向上取整到至少 1 条** |
| 样本量少于类型数 | `SAMPLE_COVERAGE` 告警，列出未覆盖的类型 |
| slot 扩散时 slot 数不足 | 告警说明实际覆盖率，并用剩余候选补齐 |
| 记忆库有损坏文件 | 跳过并在概况里列出数量与文件名，其余照常 |

错误在界面上是红色提示块，含**标题 + 可执行的建议 + 具体路径**，不是干巴巴的 errno。

---

## 完整模式

五步向导，每步都可回退修改。

### 1 导入

拖拽或选择文件。支持 `.md` `.markdown` `.txt` `.json` `.jsonl` `.ndjson` `.log`。

可选：**加载已有记忆库**。加载后第 3 步会提示模型已有 slot（减少重复抽取），第 4 步会检出与现有记忆的冲突。

### 2 解析

查看切分结果。格式识别基于内容嗅探 + 扩展名，规则：

- **Markdown** — 按 h1/h2/h3 切分，保留标题层级
- **日志** — 按时间戳切分事件，同事件多行合并
- **JSON** — 递归展开；含字符串字段的对象作为一条记录，保留 JSON Pointer 路径
- **JSONL** — 逐行解析，非法行保留原文并汇总提示
- **纯文本** — 空行分段；超长段落按句读切分（上限 4000 字）

每条记录都带 `<record id loc>` 标签，抽取结果可回溯到原文位置。

### 3 抽取

**模型配置**

| 后端 | 地址 | 密钥 | 说明 |
|---|---|---|---|
| Ollama | `http://127.0.0.1:11434` | 不需要 | 本地推理，数据不出本机 |
| OpenAI 兼容 | 如 `https://api.openai.com/v1` | 需要 | 兼容 vLLM、LM Studio、DeepSeek 等 |
| Anthropic | `https://api.anthropic.com` | 需要 | 默认 `claude-sonnet-5` |

**参数**

- 每块字符预算：控制单次请求规模。文件内容杂糅时调小可获得更细切分
- 抽取侧重：让模型优先关注某类信息
- 并发数：本地推理建议 1–2，云端可提高

**容错**：指数退避重试（自动处理 429 限流）、JSON 容错解析（markdown 围栏、前后解释文字、嵌套括号、字符串内的括号）、单块失败不影响整体。

### 4 审查

**这一步是刻意设计的：转换结果需要你确认。**

四个标签页：

- **记忆卡片** — 逐张查看、编辑、丢弃
- **内部冲突** — 同一 slot 有多条主张，必须你裁决
- **涉及已有记忆** — 与现有记忆库的一致 / 相关 / 矛盾
- **异常** — 哪些块失败、哪些卡片被过滤

**裁决原则**：工具检测冲突并给出建议，但**不自动裁决**。两条记忆都可能是对的（不同时期、不同场景），硬选一个比留着冲突更糟。

五种裁决：合并为一条 / 保留最新 / 保留第一条 / 标记争议 / 全部丢弃。

### 5 导出

选择目标记忆库目录，写入 `cards/<类型>/`。同名文件会先备份到 `.palace/import-backups/`，同时同步 `seq.txt` 保证后续 CLI 不分配重复 ID。

导出前会预览 ID 分配范围与类型分布，不合规卡片会被拦下并说明原因。

---

## 抽取质量的关键

抽取质量主要取决于**来源质量**与**提示词约束**，后者已在代码中固化：

**强制一卡一事** —— 提示词明确给反例。若模型把「用户喜欢简洁的回答，且用中文，且在 macOS 上开发」塞进一张卡，`subject+predicate` 就会失准，冲突检测随之失效。

**slot 是核心** —— `subject`（关于谁）× `predicate`（哪个侧面）。同一 slot 只能有一条有效记忆。predicate 用英文 snake_case 保证一致性，中文检索靠 `aliases` 桥接。

**宁少勿编** —— 明确告知「返回空数组是可接受且正确的答案」。原文没有的不推测。

**过滤噪音** —— 寒暄、临时任务进度、中间推理一律不抽。这是防止新记忆库快速膨胀的关键。

---

## 相似度阈值

冲突判定依赖相似度，阈值经过用例校准：

| 场景 | 相似度 |
|---|---|
| 完全相同 | 1.00 |
| 近义改写 | 0.94 |
| 补充细节（一方是另一方子集） | 0.77–0.80 |
| 同主题矛盾 | 0.60 |
| 同类不同值 | 0.50 |
| 同前缀无关 | 0.27 |
| 完全不同 | 0.00 |

阈值（`src/engine/merge.js` 的 `THRESHOLD`）：

- `identical ≥ 0.93` —— 与已有记忆一致，跳过
- `enrichment ≥ 0.70` —— 相关但更详细，合并正文
- `< 0.52` —— 真正矛盾，需人工判断

算法用 Dice + 较短方覆盖率 + 长度因子加权。不用朴素 bigram Jaccard，因为它对短中文系统性偏低（会把「子集」这种最该判相关的场景压到阈值以下）。

---

## 项目结构

```
memory-forge/
├── bin/
│   ├── forge.js            CLI（agent 驱动的主路径）
│   └── forge-mcp.js        MCP Server（stdio，hermes 通过它驱动工具）
├── electron/
│   ├── main.js             主进程：窗口、IPC、buildChunks、任务调度
│   └── preload.js          安全桥：白名单 API + webUtils 拖拽
├── src/
│   ├── engine/             纯 Node 引擎，无 Electron 依赖，可独立测试
│   │   ├── parser.js       格式识别、切分、分块（探查的兜底）
│   │   ├── schema.js       卡片 schema、归一化、校验、渲染
│   │   ├── llm.js          多后端客户端、重试、JSON 容错
│   │   ├── extract.js      提示词与抽取管线（直连模式）
│   │   ├── agentmode.js    agent 模式：任务包生成、结果导入、指令生成
│   │   ├── probe.js        探查模式：结构探测、配方校验、配方加载
│   │   ├── splitByRecipe.js 配方驱动的切分执行器（11 种策略）
│   │   ├── merge.js        去重、冲突检测、基线对比、裁决
│   │   ├── sampler.js      浅尝模式：路径校验、抽样、卡片还原、报告
│   │   ├── palace.js       读取已有记忆库
│   │   └── agentAdapter.js Agent 适配：检测、配置生成、连接自检
│   └── renderer/           界面（原生 JS，无框架）
│       ├── index.html      主界面（五步向导）
│       ├── settings.html   连接设置（独立窗口）
│       ├── styles.css
│       ├── settings.css
│       └── renderer.js / settings.js
└── test/                   522 项测试
```

**引擎与界面完全解耦**：`src/engine/` 不依赖 Electron，可在纯 Node 下测试与复用。

**agent 模式的位置**：`agentmode.js` 只负责「生成任务包 + 导入结果」，
中间的理解工作由 agent 完成。产出的卡片走的是与直连模式**完全相同**的下游管线
（`dedupe → 冲突检测 → 审查 → 导出`），保证两种模式的输出口径一致。

**探查模式的位置**：`probe.js` 只负责「给 agent 看结构 + 收配方」，
`splitByRecipe.js` 负责「按配方执行切分」。两者都不涉及抽取逻辑，
产物与 `parser.js` 产出的 Record 同构，因此后续流程完全一致。

**浅尝模式的位置**：`sampler.js` 只负责「取样与还原」，产出与 `parseContent` 同构的
Record[]，之后的分块、抽取、去重、冲突检测、报告全部是既有代码。

---

## 安全设计

- `contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开
- 渲染进程只能通过 preload 暴露的白名单方法触达能力，无法调用未授权 IPC
- CSP 禁止外部脚本与内联脚本
- 外链一律用系统浏览器打开，阻止应用内导航
- API Key 存在内存中，不落盘
- 文件读取限制 8MB，超出明确报错跳过

---

## 测试

```bash
npm test              # 全部 522 项
npm run test:engine   # 111 项引擎测试
npm run test:e2e      # 20 项真实文件端到端
npm run test:trial    # 111 项浅尝模式（74 单元 + 37 集成）
npm run test:agent    # 60 项 agent 驱动模式
npm run test:probe    # 90 项格式探查模式
npm run test:mcp      # 130 项 MCP 集成（真实 JSON-RPC over stdio）
```

引擎测试覆盖：格式识别、解析切分、JSON 容错解析、schema 归一化与校验、渲染往返一致性、去重、冲突检测、基线对比、裁决应用、ID 分配、palace 读取、相似度算法，以及用 mock LLM 跑的完整管线。

端到端测试用真实的 md/log/json/jsonl/txt 五种文件，跑通「解析 → 抽取 → 去重 → 冲突检出 → 裁决 → 分配 ID → 写盘 → 回读验证」，并确认回读后的 slot 口径与 `palace doctor` 一致。

浅尝模式测试覆盖抽样三种策略、可复现性、全部边界错误码、只读保证（目录快照逐文件比对）、写入守卫，以及「试运行与完整模式分块结构同构」。

agent 模式测试覆盖任务包结构、指令内容质量、八类输出容错、进度追踪、部分提交，以及「agent 产出走同一套下游管线且不改动记忆库」。

探查模式测试覆盖结构探测（JSONL/对话/CSV/YAML/日志/Markdown 六类特征）、JSON 路径取值（8 种形态含 `a[].text`）、配方切分（11 种策略含 CSV 引号与 TSV）、配方校验、探查任务包、配方→分块→抽取任务包链路、兜底行为，以及全流程只读保证。

MCP 集成测试走**真实 JSON-RPC over stdio**（不用内部调用绕过协议层），覆盖握手、12 个工具的注册与描述、探查→切分→抽取→导入的完整工作流、错误处理、以及配置写入的 6 种场景。

---

## 开发中修掉的真实缺陷

留个记录，避免以后重犯：

| 缺陷 | 症状 | 根因 |
|---|---|---|
| **多文件分块索引撞车** | 第二个文件的 chunk 0 结果被覆盖，数据静默丢失 | `chunkRecords` 对每个文件独立调用，index 都从 0 开始 |
| **MCP 工具全部调不到** | `tools/list` 列出了工具但调用报「未知工具」 | 实现用短名 `probe_start`，声明用 `forge_probe_start`，前缀不匹配 |
| **配置更新吃掉其他条目** | 再次安装 memory_forge 时把 filesystem 条目删了 | 替换正则 `(?:[ \t]+.*\n)*` 贪婪匹配跨越了兄弟条目 |
| **嵌套内容静默丢失** | Codex 会话的真实内容整个消失 | 规则解析只取顶层字符串字段，`content[].text` 被丢弃 |
| **抽取内容被截断** | 完整模式只处理每段前 240 字 | `fs:readFiles` 只返回 `preview` |
| 日志被误判为 JSON | `[2026-01-01 ...]` 行首方括号触发 JSON 检测 | JSON 嗅探排在了日志嗅探之前 |
| 分块文本为空 | 抽取结果 0 张 | `chunk.text` 字段从未赋值 |
| 小预算死循环 | 2GB 堆溢出 | `sliceLong` 在 `budget=1` 时步长为 0 |
| JSON 解析漏数组 | 输出前面有解释文字时抓不到数组 | 扫描器固定先找 `{`，跳过更早的 `[` |
| 数组路径取值过度 | `content`、`a.b.c`、`tags` 全返回 null | `pickPath` 把不带 `[]` 的路径也当数组展开 |
| CSV 表头被当数据 | 抽取阶段多出一条「表头是 xxx」的无用记忆 | `splitCsv` 把表头行 push 进了 records |
| `collectStrings` 类型错误 | JSON 解析抛 `skip.has is not a function` | 传了数组而非 Set |

---

## 已知限制

- **单文件 8MB 上限**：超出会跳过并提示。超大文件建议先切分。
- **不递归扫描目录**：需多选文件。目录导入可先自行列出文件。
- **本地模型质量决定抽取质量**：7B 级模型偶尔会把多件事塞进一张卡，审查步骤要仔细看。
- **裁决逻辑在渲染进程与主进程各有一份**：语义一致但代码重复。后续应把 merge.js 直接暴露给渲染进程。

---

## 与 memory-palace 的衔接

产出文件示例：

```markdown
---
id: mem_00042
type: preference
title: 偏好结论先行的技术回答
subject: user
predicate: reply_style
value: 先给结论和代码，再讲原因
status: active
confidence: 0.85
importance: 0.6
valid_from: 2026-10-03
valid_to: ""
recorded_at: 2026-10-03T22:30
source: forge:notes.md
tags: [communication]
aliases: [回复风格, 怎么回答]
hits: 0
schema: 1
---

技术问题不需要铺垫和免责声明。
```

导出后可直接验证：

```bash
cd ../memory-palace
python bin/palace.py reindex
python bin/palace.py doctor      # 应无结构冲突
python bin/palace.py search "回复风格"
```
