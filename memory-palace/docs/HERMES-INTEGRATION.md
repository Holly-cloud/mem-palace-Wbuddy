# hermes MEMORY.md 集成片段

> 把下面内容放进 `~/.hermes/memories/MEMORY.md`（2200 字符预算内）。
> 生成精简索引：`python bin/palace.py export`

---

## 片段 A：精简版（约 700 字符）

适合记忆库规模还小、高频事实不多的阶段。

```markdown
## 记忆宫殿

长期记忆存放在 agent 之外，本文件只存索引与取用规则。

取用规则：
1. 回答涉及用户偏好、历史决策、项目状态、环境配置前，先检索：
   `python <PALACE>/bin/palace.py search "<主题>"`
2. 检索输出若含「冲突提示」，必须向用户确认，不得自行选择
3. 高频事实直接记住，无需检索

高频事实：
- 回复风格：结论先行，忌铺垫免责（mem_00001）
- 语言：中文为主，技术名词保留英文（mem_00006）
- 详略：默认精简，忌长报告（mem_00002）

主题入口：
- 用户偏好 → user:: 开头，共 N 条
- 我的项目 → project: 开头
- 环境事实 → env: 开头

维护：每周 doctor，每月 gc --dry-run
```

---

## 片段 B：完整版（约 1500 字符）

适合记忆库已成规模、需要明确治理规则时。

```markdown
## 记忆宫殿（外部长期记忆）

本文件只存高频事实与索引。完整记忆在外部 memory-palace/ 目录，Markdown 为唯一真相源。

### 取用流程
1. 检索：`python <PALACE>/bin/palace.py search "<主题>"`
   可选参数：`--type <类型>`、`--subject <主题>`、`--as-of <日期>`
2. 若输出含「冲突提示」：同一 slot 存在多条 active 记忆，必须反问用户确认
3. 读原文：`python <PALACE>/bin/palace.py show <id>`

### 写入规则
仅在以下情况写入长期记忆：用户明确要求 / 偏好反复出现 / 踩坑结论 / 关键决策 / 环境事实变更
禁止写入：一次性任务进度、可直接查到的信息、自己的中间推理

写入命令：
`palace add --type <类型> --title <标题> --subject <对象> --predicate <侧面> --value <主张> --body <背景> --alias <中文触发词>`

关键：同一 subject+predicate 下只能有一条 active 记忆。写入时若提示冲突，先裁决。

### 高频事实（免检索）
- 回复风格：结论先行，忌铺垫免责
- 语言：中文为主，技术名词保留英文
- 详略：默认精简，忌长报告

### 主题索引
- user::        用户偏好与身份
- project::     进行中的项目
- env::         环境与工具链
- lesson::      经验教训

### 维护
每周 `doctor` 裁决冲突；每月 `gc` 预演后 `--execute`
冲突只标记不删除，过期只降级不销毁
```

---

## 配套的 agent 指令

在 hermes 的系统指令或 AGENTS.md 中加入，让 agent 知道宫殿的存在：

```markdown
## 记忆管理

长期记忆存放于外部记忆宫殿（路径：<PALACE>），通过 CLI 访问。

- 回答涉及用户偏好、历史决策、项目状态、环境配置前，先检索宫殿
- 检索结果含「冲突提示」时，向用户确认而非自行选择
- 值得长期记住的事实时显式写入，不要只记在会话里
- 写入时必须指定 subject 与 predicate；同一 subject+predicate 只保留一条 active 记忆
- 索引文件（MEMORY.md）里只放高频事实与索引，不要往里堆细节
```

---

## 迁移路径

从现有记忆宫殿迁移到新结构：

```bash
# 1. 备份现有记忆
cp -r <旧宫殿> <旧宫殿>.backup

# 2. 批量导入（会转成 lesson 类型，confidence=0.6，标记 imported）
python bin/palace.py import <旧宫殿路径>/*.md --type lesson

# 3. 看整体现状
python bin/palace.py stats

# 4. 找出重复项（digest 相同）
python bin/palace.py doctor

# 5. 自动合并重复项
python bin/palace.py gc --execute

# 6. 逐个人工裁决真冲突（doctor 会列出 slot 清单）
python bin/palace.py resolve --slot "<subject::predicate>" \
  --verdict supersede --winner <id> --note "理由"

# 7. 补 alias，让中文查询能命中英文 slot
#    对高频卡片逐张加 --alias，或写脚本批量回填

# 8. 验证：删掉索引重建，确认无数据丢失
rm .palace/index.db && python bin/palace.py reindex && python bin/palace.py stats

# 9. 生成精简索引，替换 MEMORY.md
python bin/palace.py export
```

**建议**：迁移期间不要删旧宫殿。新结构跑顺了、检索验证通过之后再归档。
