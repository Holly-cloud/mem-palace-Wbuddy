---
type: MOC
title: 记忆宫殿总览
updated: 2026-10-03
---

# 记忆宫殿总览

人工浏览入口。自动统计用 `python bin/palace.py stats`，此文件负责说明「这些记忆都讲什么」。

## 我是谁（profile）

- 暂无

## 我希望如何被对待（preference）

| slot | 主张 | id |
|---|---|---|
| `user::reply_style` | 先给结论和代码，再讲原因 | mem_00001 |
| `user::verbosity` | 默认精简，不要长报告 | mem_00002 |
| `user::reply_language` | 技术解释用英文，其他场景用中文 | mem_00006 |

> `mem_00007` / `mem_00008` 已被合并或取代，保留在原位以备追溯。

## 我的环境（environment）

| slot | 主张 | id |
|---|---|---|
| `env:workstation::os_and_shell` | Windows 11，shell 为 Git Bash | mem_00003 |
| `env:runtime::python_path` | WorkBuddy 托管 Python 3.13.12 | mem_00004 |
| `env:editor::default_editor` | VSCode 2019 | mem_00012（已过期） |

## 我在做的事（project）

| slot | 主张 | id |
|---|---|---|
| `project:memory-palace::status` | 已迁移到外部存储，memory 仅存索引 | mem_00005 |
| `project:memory-palace::storage_design` | Markdown 真相源 + SQLite 派生索引 | mem_00009 |

## 我踩过的坑（lesson）

| slot | 结论 | id |
|---|---|---|
| `lesson:communication::why_ask_context` | 先搜索再问，不要用提问代替检索 | mem_00010 |
| `lesson:safety::destructive_default` | 破坏性操作默认预演 | mem_00011 |

---

## 维护提示

- 新增主题时在这里加一节，并更新上表
- `palace doctor` 会指出失效引用（指向非 active 记忆的 id）
- 冲突 slot 会在这里显式标出，避免只留一条而丢失另一条的存在
