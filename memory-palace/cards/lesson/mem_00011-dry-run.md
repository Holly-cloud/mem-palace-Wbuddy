---
id: mem_00011
type: lesson
title: 写入类操作必须给 dry-run 默认值
subject: lesson:safety
predicate: destructive_default
value: 破坏性操作默认预演，显式 --execute 才落盘
status: active
confidence: 0.85
importance: 0.75
valid_from: 2026-10-03
valid_to: ""
recorded_at: 2026-10-03T21:58
ended_at: ""
source: manual
links: []
tags: [safety]
aliases: [dry run, 危险操作, 预演]
hits: 0
last_hit: ""
supersedes: []
superseded_by: ""
review_after: ""
schema: 1
---

记忆宫殿 gc、resolve 等操作涉及不可逆后果，默认只报告不执行。