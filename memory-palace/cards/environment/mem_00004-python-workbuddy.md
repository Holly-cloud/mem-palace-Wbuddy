---
id: mem_00004
type: environment
title: Python 走 WorkBuddy 托管运行时
subject: env:runtime
predicate: python_path
value: <USER_HOME>/.workbuddy/binaries/python/versions/3.13.12/python.exe
status: active
confidence: 0.85
importance: 0.85
valid_from: 2026-10-03
valid_to: ""
recorded_at: 2026-10-03T21:58
ended_at: ""
source: manual
links: []
tags: [infra]
aliases: [python, 解释器, 运行时]
hits: 4
last_hit: 2026-10-03T23:21
supersedes: []
superseded_by: ""
review_after: ""
schema: 1
---

禁止 pip install 到全局，依赖装在托管 venv 里。