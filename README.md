# mem-palace

Agent 长期记忆的结构化管理体系。包含两个配套工具：

| 目录 | 说明 |
|---|---|
| [`memory-palace/`](memory-palace/) | 结构化记忆库 + CLI。记忆卡以 Markdown 为唯一真相源，slot 为冲突键，双时态处理过期 |
| [`memory-forge/`](memory-forge/) | Electron 桌面工具。内置 LLM 能力，把任意格式的记忆文本转换为结构化记忆卡片，支持浅尝模式试运行 |

## 解决的问题

Agent 的 memory 文件会持续膨胀。常见做法是把记忆移到外部存储、原文件只留索引——但这样会遇到四个新问题：

1. 记忆内容繁杂臃肿
2. 大量过期或相互冲突的记忆
3. 人工了解记忆库现状困难
4. 难以维护

这两套工具共同解决上述问题。

## 核心设计：slot

```
slot = subject::predicate        例：user::reply_language
```

同一 slot 存在两条 active 记忆即为冲突。这让冲突检测退化成一次 `GROUP BY`，
既可自动化处理，也让人工审计成为可能——工具检测冲突并给建议，但**不替你判断谁对**。

## 快速开始

```bash
# 结构化记忆库 CLI（Python，零依赖）
cd memory-palace
python bin/palace.py init
python bin/palace.py add --type preference \
    --title "偏好结论先行" \
    --subject user --predicate reply_style \
    --value "先给结论和代码" \
    --alias 回复风格
python bin/palace.py doctor      # 体检：冲突、结构问题、膨胀指标
python bin/palace.py search "回复风格"

# 桌面转换工具（Electron）
cd memory-forge
npm install
./start.sh
npm test
```

## 测试

```bash
# memory-palace：23 项
cd memory-palace && ./smoke_test.sh

# memory-forge：242 项
cd memory-forge && npm test
```

## 设计取舍

| 决策 | 选择 | 放弃了什么 | 为什么值得 |
|---|---|---|---|
| 存储 | Markdown 真相源 | 检索速度上限 | 可审计、可迁移，人能直接维护 |
| 索引 | SQLite 派生索引 | — | 删库可重建，不丢数据 |
| 冲突粒度 | subject + predicate | 细粒度语义判断 | 退化成 GROUP BY，可自动化 |
| 真冲突 | 人工裁决 | 自动化程度 | 猜错比冲突更糟 |
| 过期处理 | 标记而非删除 | 存储紧凑性 | 保留历史可追溯，误判可逆 |
| 检索 | FTS5 + slot 过滤 | 语义泛化能力 | 数千条规模下结构化过滤更准 |
| 破坏性操作 | 默认预演 | 省心程度 | 变更可预期 |

完整设计见 [memory-palace/docs/DESIGN.md](memory-palace/docs/DESIGN.md)。

## 参考的架构

Letta/MemGPT 三层模型 · Zep/Graphiti 双时态知识图谱 · A-MEM 卡片链接 ·
Mem0 写入裁决 · LYT/MOC 人工索引 · Anthropic just-in-time context

均为借鉴其思路后按本场景（单人维护、无托管）做了取舍，未直接引入图数据库或向量库。

## License

MIT
