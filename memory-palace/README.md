# 记忆宫殿 · 使用手册

设计文档见 [`docs/DESIGN.md`](docs/DESIGN.md)。本文件是日常操作手册。

本目录是 agent 长期记忆的**唯一真相源**。

---

## 快速开始

```bash
cd memory-palace

# 自动探测 Python；若自动探测失败，用 PYTHON 环境变量指定
python bin/palace.py init
python bin/palace.py add --type preference \
    --title "偏好结论先行" \
    --subject user --predicate reply_style \
    --value "先给结论和代码" \
    --body "不需要铺垫和免责声明。" \
    --alias 回复风格 --alias 怎么回答 \
    --tag communication
python bin/palace.py search "怎么回答比较合适"
```

测试脚本同理，支持跨机器运行：

```bash
./smoke_test.sh                          # 自动探测
PYTHON=/usr/bin/python3 ./smoke_test.sh  # 手动指定
```

---

## 目录结构

```
memory-palace/
├── cards/                    记忆卡，一张一文件，按类型分目录
│   ├── profile/              身份事实
│   ├── preference/           偏好约定
│   ├── environment/          环境事实
│   ├── project/              进行中工作
│   ├── procedure/            操作规程
│   ├── lesson/               经验教训
│   ├── decision/             决策记录
│   └── episode/              事件记录
├── maps/                     人工维护的主题索引（MOC）
├── entries/                  会话日志，按月归档，只追加
│   └── 2026-10/03.md
├── archive/                  已归档的记忆卡
├── docs/DESIGN.md            设计文档
├── lib/                      核心库
├── bin/palace.py             CLI
├── scripts/                  辅助脚本
└── .palace/                  派生状态（删掉可重建）
    ├── index.db              SQLite FTS5 索引
    ├── seq.txt               ID 计数器
    ├── audit.log             变更审计
    └── config.json           可选：自定义配置
```

---

## 写入记忆

```bash
# 最小参数
palace add --type lesson \
  --title "过度追问背景会降低回答质量" \
  --subject lesson:communication --predicate why_ask_context \
  --value "先搜索再问"

# 完整参数
palace add \
  --type decision \
  --title "记忆宫殿采用 Markdown 单一真相源" \
  --subject project:memory-palace --predicate storage_design \
  --value "Markdown 为真相源，SQLite 仅作派生索引" \
  --body "理由：人可直接读改、可 git 版本化，工具弃用时数据不丢失。" \
  --tag memory --tag architecture \
  --alias 存储 --alias 架构选型 \
  --importance 0.85 --confidence 0.9 \
  --source manual
```

### 关键参数

| 参数 | 说明 |
|---|---|
| `--type` | 8 种类型之一，决定 TTL 和体量上限 |
| `--subject` | 关于谁/什么：`user`、`env:workstation`、`project:xxx` |
| `--predicate` | 哪个侧面，snake_case，**决定冲突检测粒度** |
| `--value` | 主张本身，一行讲完 |
| `--body` | 背景、原因、边界条件。有体量上限 |
| `--alias` | 中文触发词，跨语言检索靠它桥接，可重复 |
| `--importance` | 0–1，影响排序与 TTL 缩放 |

### 什么时候该写

- 用户明确要求记住某事
- 反复出现的偏好（同 slot 已有 2 条以上）
- 踩坑后的结论 → `lesson`
- 关键决策及理由 → `decision`
- 环境硬事实变化 → `environment`

**不要写**：一次性任务进度、能直接查到的信息、agent 的中间推理。

### 写入时会做什么

1. schema 校验（缺字段 / 超体量 / 状态与时间矛盾会报错）
2. **slot 冲突预检**——该 subject+predicate 已有 active 记忆时，返回冲突提示与建议
3. 写文件、重建索引、记 audit.log

若返回了 `slot_conflict`，先裁决再决定是否写入：

```bash
palace resolve --slot "user::reply_language" --verdict merge \
  --winner mem_00006 --note "技术解释用英文，其他场景用中文"
```

---

## 检索

```bash
palace search "用什么语言回复我"
palace search "编辑器配置" --type environment
palace search "项目进展" --subject project:memory-palace
palace search "语言偏好" --json                   # 结构化输出
palace search "语言偏好" --include-non-active    # 含过期/被取代的
palace search "语言偏好" --as-of 2026-06-01      # 当时的真相
```

输出包含：命中列表、分数明细、同 slot 相关记忆、**冲突提示**。

**看到冲突提示时，不要自行选一条**——反问用户。

---

## 体检与维护

```bash
palace doctor      # 每周：冲突、结构问题、膨胀指标
palace gc          # 每月：预演（不改任何文件）
palace gc --execute
palace stats       # 全景统计
```

### gc 会做什么

| 动作 | 自动执行 | 说明 |
|---|---|---|
| 重复项合并 | 是 | digest 相同，自动合并，保留信息量大的一张 |
| TTL 过期标记 | 是 | 转为 `expired`，设 `valid_to`，退出默认检索 |
| 冷记忆归档 | 需 `--execute` | 90 天未用且重要性 ≤0.25 → 移出 `cards/` |
| 断链检测 | 仅报告 | 链接指向已删除的记忆 |
| 失效地图检测 | 仅报告 | MOC 引用了已非 active 的记忆 |

`gc` **默认 dry-run**。过期和合并是可逆的（标记而非删除），归档会移出 `cards/` 但保留在 `archive/`。

---

## 冲突裁决

```bash
palace resolve --slot "<subject::predicate>" --verdict <类型> [选项]
```

| verdict | 含义 | 附加参数 |
|---|---|---|
| `supersede` | 新记忆取代旧的 | `--winner <id>` |
| `merge` | 两条都对，合并成一条 | `--winner` `--merge-from <id>` |
| `keep` | 分时段，各自有效 | `--winner` `--valid-from <日期>` |
| `dispute` | 暂挂，标记有争议，等你判断 | — |
| `archive` | 整条废止 | — |

`--note` 会写入卡片正文和 audit.log，记录裁决理由。

---

## 配置

在 `.palace/config.json` 中覆盖默认值：

```json
{
  "types": {
    "lesson": { "ttl_days": 720, "importance": 0.8, "body_limit": 1600 }
  },
  "gc": {
    "importance_floor": 0.3,
    "unused_days": 120,
    "protected_types": ["profile", "preference", "decision"]
  },
  "weights": {
    "alias_hit": 1.5,
    "importance": 1.0
  }
}
```

`protected_types` 里的类型永不归档。调 `weights` 改变检索倾向：调高 `alias_hit` 更依赖显式中文触发词，调高 `recency` 更偏重新记忆。

---

## 备份与恢复

```bash
palace backup --dest ./backups    # 生成带时间戳的快照
palace reindex                    # 索引坏了就重建
```

建议：把 memory-palace 目录纳入 git。冲突裁决、批量归档这类改动有了版本记录才敢做。

---

## 维护节奏

| 频率 | 动作 |
|---|---|
| 每周 | `doctor` 看冲突；裁决 slot 争议 |
| 每月 | `gc` 预演 → `gc --execute`；`stats` 看趋势 |
| 季度 | 复核 `preference` 类记忆（人可能变了）；清理 `maps/` |
| 重大变更前 | `backup` |

---

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 检索中文查不到英文 slot | 缺 alias | 给卡片加 `--alias` |
| 重要卡片搜不到 | relevance 为 0 被门控重罚 | 补 alias 或 tags |
| 同一问题总命中错记忆 | slot 定义过粗 | 细化 predicate |
| 索引与文件不一致 | 异常退出 | `reindex` |
| ID 冲突 | seq.txt 被改坏 | `next_id` 已做去重兜底 |

---

## 设计铁律

1. **冲突只标记不删除** —— 猜错比冲突更糟
2. **过期只降级不销毁** —— 保留历史可追溯，误判可逆
3. **破坏性操作默认预演** —— `gc` 不加 `--execute` 不落盘
4. **工具不替你判断谁对** —— 真冲突交给人
5. **Markdown 是唯一真相源** —— 索引随时可重建
