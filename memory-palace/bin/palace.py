#!/usr/bin/env python3
"""palace — command line interface for the memory palace.

Design intent: the CLI is the *agent's* hands, and it is intentionally
verbose about uncertainty. Commands that could destroy information default to
dry-run; commands that would require guessing (conflict arbitration) report a
verdict suggestion rather than acting on it.

Quick start::

    python bin/palace.py init
    python bin/palace.py add --type preference --title "..." \\
        --subject user --predicate reply_style --value "结论先行" --body "..."
    python bin/palace.py search "回复风格"
    python bin/palace.py doctor
    python bin/palace.py gc --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib import card as cardmod                      # noqa: E402
from lib import config as cfgmod                     # noqa: E402
from lib import index as idxmod                      # noqa: E402
from lib import lifecycle as lifecycle               # noqa: E402
from lib.card import Card                            # noqa: E402
from lib.store import Store                          # noqa: E402

DEFAULT_ROOT = Path(__file__).resolve().parent.parent


def get_store(args) -> tuple[Store, dict]:
    root = Path(args.root).expanduser().resolve() if getattr(args, "root", None) else DEFAULT_ROOT
    store = Store(root)
    return store, cfgmod.load(root)


def out(obj) -> None:
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))
    else:
        print(obj)


# --- commands -------------------------------------------------------------

def cmd_init(args):
    store, cfg = get_store(args)
    store.ensure()
    idxmod.reindex(store, cfg)
    out({
        "ok": True,
        "root": str(store.root),
        "types": cfgmod.TYPE_ORDER,
        "indexed": len(store.all_cards()),
        "next": "用 `palace add` 写入第一条记忆，或 `palace import` 导入现有记忆宫殿文件",
    })


def cmd_add(args):
    store, cfg = get_store(args)
    store.ensure()
    meta = cfgmod.type_meta(cfg, args.type)
    body = args.body
    if body and not body.strip().endswith("\n"):
        body = body.strip()

    new_id = args.id or store.next_id()
    card = Card(
        id=new_id,
        type=args.type,
        title=args.title,
        subject=args.subject,
        predicate=args.predicate,
        value=args.value or args.title,
        status="active",
        confidence=args.confidence,
        importance=args.importance if args.importance is not None else meta["importance"],
        valid_from=cardmod.normalize_date(args.valid_from or "today"),
        valid_to=cardmod.normalize_date(args.valid_to),
        recorded_at=cardmod.stamp(),
        source=args.source or "manual",
        tags=args.tag or [],
        aliases=args.alias or [],
        body=body or "",
    )

    problems = cardmod.validate(card, cfg)
    hard = [p for p in problems if "超过" in p or "缺少必填" in p or "必须" in p or "不应" in p]
    if hard and not args.force:
        return out({"ok": False, "error": "卡片校验未通过", "problems": problems,
                    "hint": "确认后可加 --force 强制写入"})

    # Pre-write conflict probe: same slot already has an active card?
    existing = [c for c in store.all_cards(include_archived=False)
                if c.slot == card.slot and c.status == "active" and c.subject]
    card.save = None  # not used; keep dataclass clean
    path = store.save(card)
    store.audit("add", id=card.id, slot=card.slot, type=card.type, title=card.title)
    idxmod.reindex(store, cfg)

    result = {"ok": True, "id": card.id, "path": str(path.relative_to(store.root)), "slot": card.slot}
    if problems:
        result["warnings"] = problems
    if existing:
        proposal = lifecycle._propose_action([*existing, card])
        result["slot_conflict"] = {
            "existing": [{"id": c.id, "title": c.title, "value": c.value} for c in existing],
            "suggested": proposal,
            "how_to_resolve": (
                f"python bin/palace.py resolve --slot '{card.slot}' --verdict <"
                "supersede|merge|keep|dispute|archive> --winner <id>"
            ),
        }
        if proposal["action"] == "escalate":
            result["note"] = "工具不会替你判断哪条为真，请人工裁决；裁决前该 slot 视为有争议"
    return out(result)


def cmd_search(args):
    store, cfg = get_store(args)
    if not store.db_path.exists():
        idxmod.reindex(store, cfg)
    res = idxmod.search(
        store, cfg, args.query,
        limit=args.limit,
        types=args.type,
        subjects=args.subject,
        include_non_active=args.include_non_active,
        as_of=args.as_of,
    )
    if args.json:
        return out(res)

    print(f"\n查询: {args.query}")
    print(f"命中 {len(res['results'])} / 索引 {res['total_indexed']} 条\n")
    for i, hit in enumerate(res["results"], 1):
        c = hit["card"]
        flags = []
        if c.status != "active":
            flags.append(f"⚠ {c.status}")
        if hit["signals"]["slot_exact"]:
            flags.append("slot 命中")
        flag = ("  [" + ", ".join(flags) + "]") if flags else ""
        print(f"{i}. [{c.id}] {c.title}{flag}")
        print(f"   {c.type} | {c.slot} | score={hit['score']} | hits={c.hits}")
        print(f"   {c.value[:110]}")
        if c.body:
            first = c.body.strip().splitlines()[0][:110]
            print(f"   {first}")
        print()

    if res["conflicts"]:
        print("─── 冲突提示 ───")
        for cf in res["conflicts"]:
            cur = cf["current"]
            print(f"slot `{cf['slot']}` 有 {len(cf['shadowed']) + 1} 条 active 记忆：")
            print(f"  当前推断: [{cur.id}] {cur.value}")
            for sh in cf["shadowed"]:
                print(f"  竞争记忆: [{sh.id}] {sh.value}  ({sh.recorded_at})")
            print(f"  → {cf['reason']}")
        print()
    if res["same_slot"]:
        print("─── 同 slot 相关记忆 ───")
        for c in res["same_slot"]:
            print(f"  [{c.id}] {c.status:10s} {c.value[:80]}")
    idxmod.record_use(store, [h["card"].id for h in res["results"]])


def cmd_list(args):
    store, cfg = get_store(args)
    cards = store.all_cards(include_archived=args.all)
    if args.type:
        cards = [c for c in cards if c.type == args.type]
    if args.status:
        cards = [c for c in cards if c.status == args.status]
    if args.subject:
        cards = [c for c in cards if c.subject.startswith(args.subject)]
    cards.sort(key=lambda c: c.id)
    if args.json:
        return out([{"id": c.id, "title": c.title, "type": c.type, "status": c.status,
                     "slot": c.slot, "value": c.value, "path": c.path} for c in cards])
    if not cards:
        return out("没有匹配的记忆卡")
    for c in cards:
        print(f"[{c.id}] {c.status:11s} {c.type:12s} {c.title}")
        print(f"         slot={c.slot}  value={c.value[:70]}")


def cmd_show(args):
    store, cfg = get_store(args)
    c = store.get(args.id)
    if c is None:
        return out(f"未找到 {args.id}")
    out(c.render())


def cmd_doctor(args):
    """The 'understand the current state of my palace' command."""
    store, cfg = get_store(args)
    conflicts = lifecycle.find_conflicts(store, cfg)
    stats = idxmod.stats(store)
    problems = []
    for c in store.all_cards():
        for p in cardmod.validate(c, cfg):
            problems.append({"id": c.id, "title": c.title, "problem": p})

    report = {
        "root": str(store.root),
        "cards": stats["total"],
        "active": stats["active"],
        "conflicts": [
            {
                "slot": cf["slot"], "kind": cf["kind"],
                "cards": [{"id": c.id, "title": c.title, "value": c.value[:60],
                           "recorded_at": c.recorded_at, "source": c.source} for c in cf["cards"]],
                "suggested_action": cf["auto_action"],
            }
            for cf in conflicts
        ],
        "schema_problems": problems,
        "body_stats": stats["body_chars"],
        "by_type": stats["by_type"],
    }

    if args.json:
        return out(report)

    print(f"\n═══ 记忆宫殿体检报告 ═══\n")
    print(f"记忆卡总数 {stats['total']}（active {stats['active']}）\n")
    print("按类型：")
    for t, counts in sorted(stats["by_type"].items(), key=lambda kv: -sum(kv[1].values())):
        meta = cfgmod.type_meta(cfg, t)
        detail = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"  {t:12s} {meta['label']:6s} {detail}")
    print(f"\n正文长度：总量 {stats['body_chars']['total']} 字符，"
          f"中位数 {stats['body_chars']['median']}，P95 {stats['body_chars']['p95']}，"
          f"最大 {stats['body_chars']['max']}")

    print(f"\n冲突 slot：{len(conflicts)} 个")
    for cf in conflicts:
        print(f"\n  ▸ {cf['slot']}  ({cf['kind']})")
        for c in cf["cards"]:
            print(f"      [{c.id}] {c.title}")
            print(f"          value={c.value[:70]}")
            print(f"          recorded={c.recorded_at}  source={c.source}")
        act = cf["auto_action"]
        arrow = {"merge": "合并", "supersede": "新记忆取代旧记忆", "escalate": "需人工裁决"}[act["action"]]
        print(f"      → 建议：{arrow}（置信度 {act['confidence']}）— {act['rationale']}")

    if problems:
        print(f"\n结构问题：{len(problems)} 处")
        for p in problems[:20]:
            print(f"  [{p['id']}] {p['problem']}")
    if not conflicts and not problems:
        print("\n✓ 结构健康，无冲突、无越界卡片。")


def cmd_resolve(args):
    store, cfg = get_store(args)
    result = lifecycle.resolve(
        store, cfg, args.slot, args.verdict,
        winner=args.winner, merge_from=args.merge_from, note=args.note,
        valid_to=cardmod.normalize_date(args.valid_from or ""),
    )
    out(result)


def cmd_gc(args):
    store, cfg = get_store(args)
    dry_run = not args.execute
    report = lifecycle.gc(store, cfg, dry_run=dry_run, archive_cold=not args.keep)
    if args.json:
        return out(report)
    print(f"\n═══ 维护 {'预演（未改动任何文件）' if dry_run else '执行'} ═══\n")
    print(report["summary"])
    for item in report["expiring"]:
        print(f"  过期  [{item['id']}] {item['title']}  (已存在 {item['age_days']} 天 / TTL {item['ttl']})")
    for item in report["mergeable"]:
        print(f"  合并  [{item['keeper']}] 吸收 {', '.join(item['absorbed'])}  slot={item['slot']}")
    for item in report["archive_candidates"]:
        print(f"  归档  [{item['id']}] {item['title']}  "
              f"(importance={item['importance']}, {item['days_unused']} 天未被使用)")
    for item in report["orphan_links"]:
        print(f"  断链  [{item['id']}] → {item['target']} 不存在")
    for item in report["stale_maps"]:
        print(f"  地图  {item['map']} 引用了已失效记忆: {', '.join(item['missing'])}")
    if dry_run:
        print("\n加 --execute 实际执行。过期与合并可逆（标记而非删除），归档会移出 cards/。")


def cmd_expire(args):
    store, cfg = get_store(args)
    out({"expired": lifecycle.apply_expiry(store, cfg)})


def cmd_stats(args):
    store, cfg = get_store(args)
    if not store.db_path.exists():
        idxmod.reindex(store, cfg)
    stats = idxmod.stats(store)
    ov = lifecycle.overview(store, cfg)
    if args.json:
        return out({"stats": stats, "overview": ov})
    print(f"\n═══ 记忆宫殿概览 ═══\n")
    print(f"总计 {ov['total']} 张记忆卡，active {ov['active']} 张\n")
    print("状态分布：" + ", ".join(f"{k}={v}" for k, v in sorted(ov["by_status"].items())))
    print("\n类型分布：")
    for t, counts in sorted(ov["by_type"].items(), key=lambda kv: -kv[1].get("total", 0)):
        print(f"  {t:12s} {counts.get('total', 0):4d}  " +
              " ".join(f"{k}={v}" for k, v in sorted(counts.items()) if k != "total"))
    if ov["contested_slots"]:
        print(f"\n⚠ 有争议的 slot（{len(ov['contested_slots'])} 个）：")
        for slot, n in list(ov["contested_slots"].items())[:10]:
            print(f"  {slot}: {n} 条 active")
    if ov["needs_review"]:
        print(f"\n需要复核（disputed 或低置信）：{len(ov['needs_review'])} 张")
        for item in ov["needs_review"][:10]:
            print(f"  [{item['id']}] {item['title']} (status={item['status']}, {item['age_days']}天)")
    print("\n高频记忆：")
    for item in ov["hot_cards"][:5]:
        print(f"  [{item['id']}] {item['title']}  被使用 {item['hits']} 次")
    print(f"\n索引健康：断链 {len(stats.get('conflict_slots', []))} 个争议 slot，"
          f"{stats['malformed_slots']} 张卡片缺 slot 定义")


def cmd_reindex(args):
    store, cfg = get_store(args)
    n = idxmod.reindex(store, cfg)
    out({"ok": True, "indexed": n})


def cmd_log(args):
    store, cfg = get_store(args)
    text = args.text
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    if not text:
        return out("没有内容。用 --text 或 --file 提供。")
    path = store.append_entry(text, heading=args.heading)
    store.audit("log", path=str(path.relative_to(store.root)))
    out({"ok": True, "path": str(path.relative_to(store.root))})


def cmd_distill(args):
    """Turn a session log into draft cards. Prints drafts; writing is explicit."""
    store, cfg = get_store(args)
    path = Path(args.file) if args.file else store.current_entry_path()
    if not path.exists():
        return out(f"找不到 {path}")
    text = path.read_text(encoding="utf-8")
    lines = [l.strip("-* ").strip() for l in text.splitlines()]
    candidates = [l for l in lines if len(l) > 12 and not l.startswith("#")]
    out({
        "source": str(path),
        "note": "以下为候选原子记忆，请在 agent 侧归纳后用 `add` 显式写入；工具不做无监督的批量入库",
        "candidates": candidates[: args.limit],
    })


def cmd_import(args):
    store, cfg = get_store(args)
    paths: list[Path] = []
    for raw in args.paths:
        p = Path(raw)
        if p.is_dir():
            paths.extend(sorted(p.rglob("*.md")))
        elif p.exists():
            paths.append(p)
    if not paths:
        return out({"ok": False, "error": "没有找到可导入的文件"})
    created = store.import_files(paths, default_type=args.type)
    idxmod.reindex(store, cfg)
    out({"ok": True, "imported": len(created),
         "ids": [c.id for c in created],
         "note": "导入项默认 confidence=0.6、标记 imported 标签，请尽快人工复核"})


def cmd_template(args):
    store, cfg = get_store(args)
    meta = cfgmod.type_meta(cfg, args.type)
    sample = Card(
        id="mem_XXXXX", type=args.type, title="一句话说清这条记忆讲什么",
        subject="user", predicate="example_predicate", value="主张本身，一行讲完",
        status="active", confidence=0.9, importance=meta["importance"],
        valid_from=cardmod.today(), valid_to="", recorded_at=cardmod.stamp(),
        source="manual", tags=["example"], body="补充背景、原因、边界条件。",
    )
    out(sample.render())


def cmd_export(args):
    """Export a compact brief — this is what goes into the agent's memory file."""
    store, cfg = get_store(args)
    ov = lifecycle.overview(store, cfg)
    active = [c for c in store.all_cards(include_archived=False) if c.status == "active"]
    active.sort(key=lambda c: (-c.importance, -c.hits))
    lines = ["# 记忆宫殿索引（自动生成，请勿手工编辑）", ""]
    lines.append(f"记忆卡 {len(active)} 张 active / {ov['total']} 张总计。")
    lines.append(f"有争议 slot {len(ov['contested_slots'])} 个；需复核 {len(ov['needs_review'])} 张。")
    lines.append("")
    lines.append("## 主题入口")
    subj: dict[str, list[Card]] = {}
    for c in active:
        subj.setdefault(c.subject or "(未分类)", []).append(c)
    for subject, items in sorted(subj.items(), key=lambda kv: -len(kv[1])):
        lines.append(f"- **{subject}** ({len(items)} 条)")
        for c in sorted(items, key=lambda x: -x.importance)[:5]:
            lines.append(f"  - `{c.id}` {c.title}")
    lines.append("")
    lines.append("## 常用命令")
    lines.append("- 按需取记忆：`python bin/palace.py search \"<关键词>\"`")
    lines.append("- 体检：`python bin/palace.py doctor`")
    lines.append("- 维护：`python bin/palace.py gc --dry-run` 后加 `--execute`")
    text = "\n".join(lines)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        out({"ok": True, "out": args.out})
    else:
        print(text)


def cmd_backup(args):
    store, cfg = get_store(args)
    target = store.backup(Path(args.dest))
    out({"ok": True, "backup": str(target)})


# --- parser ---------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="palace",
        description="记忆宫殿：Markdown 优先、支持冲突与过期处理的 agent 长期记忆库",
    )
    p.add_argument("--root", help="宫殿根目录（默认脚本所在项目）")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="初始化目录结构与索引").set_defaults(func=cmd_init)

    sp = sub.add_parser("add", help="写入一条记忆卡")
    sp.add_argument("--type", required=True, choices=cfgmod.TYPE_ORDER)
    sp.add_argument("--title", required=True)
    sp.add_argument("--subject", required=True, help="实体/主题，如 user、project:palace")
    sp.add_argument("--predicate", required=True, help="侧面，如 prefers_output_format")
    sp.add_argument("--value", default="", help="主张一行讲完；缺省用 title")
    sp.add_argument("--body", default="", help="补充背景、原因、边界条件")
    sp.add_argument("--tag", action="append", help="可重复")
    sp.add_argument("--alias", action="append",
                    help="中文触发词，可重复。用于跨语言检索：库内 slot 用英文 slug，查询用中文时靠它桥接")
    sp.add_argument("--source", default="manual")
    sp.add_argument("--valid-from", default="today")
    sp.add_argument("--valid-to", default="")
    sp.add_argument("--confidence", type=float, default=0.85)
    sp.add_argument("--importance", type=float, default=None)
    sp.add_argument("--id", default="", help="手工指定 ID（迁移时用）")
    sp.add_argument("--force", action="store_true", help="忽略校验警告强制写入")
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("search", help="混合检索")
    sp.add_argument("query")
    sp.add_argument("--limit", type=int, default=8)
    sp.add_argument("--type", action="append", choices=cfgmod.TYPE_ORDER)
    sp.add_argument("--subject", action="append")
    sp.add_argument("--include-non-active", action="store_true", help="含已过期/被取代的记忆")
    sp.add_argument("--as-of", default="", help="按某天的历史真相检索，如 2026-06-01")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_search)

    sp = sub.add_parser("list", help="列出记忆卡")
    sp.add_argument("--type", choices=cfgmod.TYPE_ORDER)
    sp.add_argument("--status")
    sp.add_argument("--subject")
    sp.add_argument("--all", action="store_true", help="含归档")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("show", help="查看单张记忆卡原文")
    sp.add_argument("id")
    sp.set_defaults(func=cmd_show)

    sp = sub.add_parser("doctor", help="体检：冲突、结构问题、膨胀指标")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_doctor)

    sp = sub.add_parser("resolve", help="人工裁决某个 slot 的冲突")
    sp.add_argument("--slot", required=True)
    sp.add_argument("--verdict", required=True,
                    choices=["supersede", "merge", "keep", "dispute", "archive"])
    sp.add_argument("--winner", default="", help="保留哪张卡的 ID")
    sp.add_argument("--merge-from", action="append", help="合并模式下要并入的卡 ID")
    sp.add_argument("--note", default="", help="裁决理由，会写入卡片与审计日志")
    sp.add_argument("--valid-from", default="", help="指定被取代记忆的 valid_to 日期")
    sp.set_defaults(func=cmd_resolve)

    sp = sub.add_parser("gc", help="维护：过期 / 合并 / 归档 / 断链")
    sp.add_argument("--execute", action="store_true", help="真正执行（默认仅预演）")
    sp.add_argument("--keep", action="store_true", help="不归档冷记忆")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_gc)

    sub.add_parser("expire", help="只跑过期扫描").set_defaults(func=cmd_expire)

    sp = sub.add_parser("stats", help="全局概览统计")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_stats)

    sub.add_parser("reindex", help="从 Markdown 重建索引").set_defaults(func=cmd_reindex)

    sp = sub.add_parser("log", help="追加会话日志（按月归档）")
    sp.add_argument("--text", default="")
    sp.add_argument("--file", default="")
    sp.add_argument("--heading", default="")
    sp.set_defaults(func=cmd_log)

    sp = sub.add_parser("distill", help="从会话日志提取候选原子记忆（只读）")
    sp.add_argument("--file", default="")
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_distill)

    sp = sub.add_parser("import", help="导入既有 Markdown 记忆文件")
    sp.add_argument("paths", nargs="+")
    sp.add_argument("--type", default="lesson", choices=cfgmod.TYPE_ORDER)
    sp.set_defaults(func=cmd_import)

    sp = sub.add_parser("template", help="打印某类型的记忆卡模板")
    sp.add_argument("--type", default="lesson", choices=cfgmod.TYPE_ORDER)
    sp.set_defaults(func=cmd_template)

    sp = sub.add_parser("export", help="导出精简索引（放进 agent memory 文件）")
    sp.add_argument("--out", default="")
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser("backup", help="备份整个宫殿")
    sp.add_argument("--dest", default="./backups")
    sp.set_defaults(func=cmd_backup)

    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    result = args.func(args)
    if isinstance(result, dict) and result.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
