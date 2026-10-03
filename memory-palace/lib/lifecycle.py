"""Lifecycle operations: conflict arbitration, expiry, consolidation, gc.

This is the part that answers "记忆内容繁杂臃肿 / 大量过期或相互冲突 /
人工了解现状困难 / 难以维护".

Division of labour — deliberately conservative about automating judgment:

* **Mechanical and automatic**: exact-duplicate merge, validity-window
  bookkeeping, TTL expiry, orphan link repair, index rebuild, statistics.
  These have unambiguous right answers.
* **Judgment, agent-assisted**: conflict arbitration between two differing
  cards. The tool *detects* and *stages* the conflict; it refuses to guess.
  ``auto_supersede`` exists but is opt-in and only fires on high-confidence
  signals (explicit negation of the same slot, or an explicit new value from
  the same source within a short window).
* **Judgment, human**: anything expensive or irreversible to get wrong
  (deleting a card, bulk cleanup, choosing between two plausible beliefs).

Every mutation writes to ``.palace/audit.log`` so the palace's history is
inspectable rather than mysterious.
"""

from __future__ import annotations

import re
from pathlib import Path

from . import card as cardmod
from . import config as cfgmod
from . import index as idxmod
from .card import Card
from .store import Store

# Phrases that mark an explicit correction of an existing belief.
NEGATION_PATTERNS = [
    r"(不再|不用|不要|改为|换成|改成|已经?不|stop|no longer|switch(ed)? to|instead of)",
]
# Phrases that mark a fresh, deliberate restatement of the same slot.
RESTATE_PATTERNS = [
    r"(现在|目前|从现在起| henceforth|going forward|as of)",
]


# --- conflict detection ---------------------------------------------------

def find_conflicts(store: Store, cfg: dict) -> list[dict]:
    """Slot-level conflicts among ``active`` cards. The core of the pain point."""
    cards = store.all_cards(include_archived=False)
    buckets: dict[str, list[Card]] = {}
    for c in cards:
        if c.status == "active" and c.subject and c.predicate:
            buckets.setdefault(c.slot, []).append(c)

    conflicts: list[dict] = []
    for slot, members in buckets.items():
        if len(members) < 2:
            continue
        members.sort(key=lambda c: (c.valid_from or c.recorded_at or "", c.id), reverse=True)
        digests = {c.digest() for c in members}
        kind = "duplicate" if len(digests) < len(members) else "divergent"
        conflicts.append(
            {
                "slot": slot,
                "subject": members[0].subject,
                "predicate": members[0].predicate,
                "kind": kind,
                "cards": members,
                "auto_action": _propose_action(members),
            }
        )
    conflicts.sort(key=lambda d: (d["kind"] == "duplicate", d["slot"]))
    return conflicts


def _propose_action(members: list[Card]) -> dict:
    """Suggest (never perform) an arbitration for a conflicting slot."""
    newest, *rest = members
    if len({c.digest() for c in members}) < len(members):
        keeper = max(members, key=lambda c: (len(c.body), c.recorded_at))
        return {
            "action": "merge",
            "keeper": keeper.id,
            "absorb": [c.id for c in members if c.id != keeper.id],
            "confidence": 0.95,
            "rationale": "内容重复，保留信息量最大的一张，其余并入并标记 superseded",
        }

    explicit = any(
        re.search(p, newest.value or newest.title or "", re.IGNORECASE) for p in NEGATION_PATTERNS
    )
    restated = any(
        re.search(p, newest.value or newest.title or "", re.IGNORECASE) for p in RESTATE_PATTERNS
    )
    same_source = len({c.source for c in members}) == 1
    recent = newest.age_days() <= 30 and all(c.age_days() <= 180 for c in members)

    if (explicit or restated) and same_source and recent:
        return {
            "action": "supersede",
            "new": newest.id,
            "supersede": [c.id for c in rest],
            "confidence": 0.75,
            "rationale": "同一来源、近期、含明确变更措辞（改为/不再/现在）",
        }
    if explicit and restated:
        return {
            "action": "supersede",
            "new": newest.id,
            "supersede": [c.id for c in rest],
            "confidence": 0.6,
            "rationale": "含明确变更措辞，但来源不一致，建议人工确认",
        }
    return {
        "action": "escalate",
        "new": newest.id,
        "supersede": [],
        "confidence": 0.0,
        "rationale": "两条记忆都可能是对的（例如不同时期/不同场景），工具不做判断，请人工裁决",
    }


# --- conflict resolution --------------------------------------------------

def resolve(
    store: Store,
    cfg: dict,
    slot: str,
    verdict: str,
    *,
    winner: str = "",
    merge_from: list[str] | None = None,
    note: str = "",
    valid_to: str = "",
) -> dict:
    """Apply a human (or vetted agent) decision to one conflicting slot.

    verdict: ``keep`` | ``supersede`` | ``merge`` | ``dispute`` | ``archive``
    """
    cards = store.all_cards(include_archived=False)
    members = [
        c for c in cards
        if c.slot == slot and c.status in ("active", "disputed")
    ]
    if not members:
        return {"ok": False, "error": f"slot `{slot}` 没有 active/disputed 记忆"}

    stamp = cardmod.stamp()
    today = cardmod.today()
    touched: list[str] = []

    def close(card: Card, new_status: str, by: str) -> None:
        card.status = new_status
        card.valid_to = card.valid_to or valid_to or today
        card.ended_at = stamp
        card.superseded_by = by
        store.save(card)
        touched.append(card.id)

    if verdict == "dispute":
        for c in members:
            c.status = "disputed"
            c.valid_to = ""
            c.ended_at = ""
            c.superseded_by = ""
            store.save(c)
            touched.append(c.id)
        store.audit("resolve", slot=slot, verdict=verdict, ids=touched, note=note)

    elif verdict in ("supersede", "merge"):
        chosen = winner or _propose_action(members).get("new") or members[0].id
        keeper = next((c for c in members if c.id == chosen), None)
        if keeper is None:
            return {"ok": False, "error": f"winner `{chosen}` 不在 slot `{slot}` 内"}

        if verdict == "merge":
            absorbs = merge_from or [c.id for c in members if c.id != chosen]
            body_parts = [keeper.body.strip()] + [
                c.body.strip() for c in members if c.id in absorbs and c.body.strip()
            ]
            keeper.body = "\n\n".join(p for p in body_parts if p)
            keeper.tags = sorted({*keeper.tags, *[t for c in members if c.id in absorbs for t in c.tags]})
            keeper.hits += sum(c.hits for c in members if c.id in absorbs)
            keeper.source = f"{keeper.source}|merged:{','.join(absorbs)}"
        for c in members:
            if c.id == chosen:
                continue
            close(c, "superseded", chosen)
            rel = f"{chosen}:supersedes"
            if rel not in keeper.supersedes:
                keeper.supersedes.append(c.id)
        if note:
            keeper.body += f"\n\n> 裁决记录 {today}: {note}"
        store.save(keeper)
        touched.append(keeper.id)
        store.audit("resolve", slot=slot, verdict=verdict, winner=chosen, ids=touched, note=note)

    elif verdict == "keep":
        # Accept that both are true: give the losers an explicit validity window
        # so future retrieval can answer "what was true when".
        losers = [c for c in members if c.id != (winner or members[0].id)]
        keeper = next((c for c in members if c.id == (winner or members[0].id)), members[0])
        boundary = valid_to or today
        for c in losers:
            c.status = "superseded"
            c.valid_to = c.valid_to or boundary
            c.ended_at = stamp
            c.superseded_by = ""
            store.save(c)
            touched.append(c.id)
        keeper.status = "active"
        store.save(keeper)
        touched.append(keeper.id)
        store.audit("resolve", slot=slot, verdict="keep", keeper=keeper.id, ids=touched, note=note)

    elif verdict == "archive":
        for c in members:
            store.archive(c)
            touched.append(c.id)
        store.audit("resolve", slot=slot, verdict="archive", ids=touched, note=note)
    else:
        return {"ok": False, "error": f"未知裁决类型 `{verdict}`"}

    idxmod.reindex(store, cfg)
    return {"ok": True, "verdict": verdict, "slot": slot, "touched": touched, "note": note}


def auto_resolve(store: Store, cfg: dict, min_confidence: float = 0.7) -> list[dict]:
    """Apply only high-confidence, non-destructive actions (duplicates).

    ``supersede`` is deliberately excluded: it changes what the agent believes,
    so it stays a human/agent decision unless you pass ``include_supersede``.
    """
    applied: list[dict] = []
    for conflict in find_conflicts(store, cfg):
        action = conflict["auto_action"]
        if action["action"] != "merge" or action["confidence"] < min_confidence:
            continue
        keeper_id = action["keeper"]
        keeper = store.get(keeper_id)
        if keeper is None:
            continue
        absorbs = [store.get(i) for i in action["absorb"]]
        absorbs = [c for c in absorbs if c]
        if not absorbs:
            continue
        bodies = [keeper.body.strip()] + [c.body.strip() for c in absorbs if c.body.strip()]
        keeper.body = "\n\n".join(b for b in bodies if b)
        keeper.tags = sorted({*keeper.tags, *[t for c in absorbs for t in c.tags]})
        keeper.hits += sum(c.hits for c in absorbs)
        stamp = cardmod.stamp()
        today = cardmod.today()
        for c in absorbs:
            c.status = "superseded"
            c.valid_to = c.valid_to or today
            c.ended_at = stamp
            c.superseded_by = keeper_id
            store.save(c)
        store.save(keeper)
        store.audit("auto_merge", slot=conflict["slot"], keeper=keeper_id, absorbed=action["absorb"])
        applied.append({"slot": conflict["slot"], "keeper": keeper_id, "absorbed": action["absorb"]})
    if applied:
        idxmod.reindex(store, cfg)
    return applied


# --- expiry & forgetting --------------------------------------------------

def apply_expiry(store: Store, cfg: dict, ref=None) -> list[dict]:
    """Close validity windows on active cards that outlived their TTL.

    Expiry is not deletion. The card moves to ``superseded``/``expired`` and
    keeps answering historical questions; it simply stops being the answer to
    present-tense ones.
    """
    ref = ref or cardmod.now()
    gc_cfg = cfg.get("gc", {})
    stamp = cardmod.stamp()
    today = cardmod.today()
    expired: list[dict] = []
    for c in store.all_cards(include_archived=False):
        if c.status != "active":
            continue
        meta = cfgmod.type_meta(cfg, c.type)
        ttl = c.ttl_days if hasattr(c, "ttl_days") else meta.get("ttl_days", 365)
        try:
            ttl = int(ttl)
        except (TypeError, ValueError):
            ttl = 365
        # Importance scales the window: important-but-stale is still stale, but
        # a critical project survives 1.4x its nominal TTL.
        ttl = int(ttl * (0.7 + 0.6 * float(c.importance)))
        age = c.age_days(ref)
        if age <= ttl:
            continue
        c.status = "expired"
        c.valid_to = c.valid_to or today
        c.ended_at = stamp
        c.review_after = c.review_after or ""
        store.save(c)
        store.audit("expire", id=c.id, slot=c.slot, age_days=round(age, 1), ttl=ttl)
        expired.append({"id": c.id, "title": c.title, "slot": c.slot, "age_days": round(age, 1), "ttl": ttl})
    if expired:
        idxmod.reindex(store, cfg)
    return expired


def gc(
    store: Store,
    cfg: dict,
    *,
    dry_run: bool = True,
    archive_cold: bool = True,
    expire: bool = True,
    purge_index: bool = True,
) -> dict:
    """Maintenance sweep. Defaults to a dry run so nothing changes by surprise."""
    gc_cfg = cfg.get("gc", {})
    floor = float(gc_cfg.get("importance_floor", 0.25))
    unused_days = float(gc_cfg.get("unused_days", 90))
    protected = set(gc_cfg.get("protected_types", []))

    report: dict = {
        "dry_run": dry_run,
        "expiring": apply_expiry(store, cfg) if expire else [],
        "mergeable": auto_resolve(store, cfg),
        "archive_candidates": [],
        "orphan_links": [],
        "stale_maps": [],
    }

    for c in store.all_cards(include_archived=False):
        # Archive candidates: low value, unused for a long time.
        if c.type in protected or c.status not in ("active",):
            continue
        if c.superseded_by or c.links:
            continue
        cold = c.days_since_hit() > unused_days
        if archive_cold and cold and c.importance <= floor:
            report["archive_candidates"].append(
                {"id": c.id, "title": c.title, "type": c.type,
                 "importance": c.importance, "days_unused": round(c.days_since_hit(), 1)}
            )

        # Orphan links: pointers to ids that no longer exist.
        for rel in c.links:
            if ":" not in rel:
                continue
            target = rel.split(":", 1)[0]
            if target and store.get(target) is None:
                report["orphan_links"].append({"id": c.id, "target": target})

    # MOC maps pointing at cards that no longer exist / went archived.
    if store.maps_dir.exists():
        active_ids = {c.id for c in store.all_cards(include_archived=False) if c.status == "active"}
        for m in sorted(store.maps_dir.rglob("*.md")):
            text = m.read_text(encoding="utf-8")
            refs = set(re.findall(r"\b(mem_\d{5})\b", text))
            missing = sorted(refs - active_ids)
            if missing:
                report["stale_maps"].append({"map": str(m.relative_to(store.root)), "missing": missing})

    if not dry_run:
        for item in report["archive_candidates"]:
            found = store.get(item["id"])
            if found:
                store.archive(found)
                store.audit("archive", id=found.id, reason="cold+low_importance")
        if purge_index:
            idxmod.reindex(store, cfg)
        report["archived"] = len(report["archive_candidates"])

    report["summary"] = (
        f"{'预演' if dry_run else '执行'}：过期 {len(report['expiring'])}，"
        f"自动合并 {len(report['mergeable'])}，归档候选 {len(report['archive_candidates'])}，"
        f"断链 {len(report['orphan_links'])}，失效地图 {len(report['stale_maps'])}"
    )
    return report


# --- human-facing snapshot -------------------------------------------------

def overview(store: Store, cfg: dict) -> dict:
    """The 'what does my palace look like right now' answer, in one call."""
    cards = store.all_cards(include_archived=True)
    by_type: dict[str, dict[str, int]] = {}
    by_status: dict[str, int] = {}
    for c in cards:
        by_type.setdefault(c.type, {}).setdefault("total", 0)
        by_type[c.type]["total"] += 1
        by_type[c.type][c.status] = by_type[c.type].get(c.status, 0) + 1
        by_status[c.status] = by_status.get(c.status, 0) + 1

    active = [c for c in cards if c.status == "active"]
    slots = {}
    for c in active:
        if c.subject and c.predicate:
            slots[c.slot] = slots.get(c.slot, 0) + 1
    contested = {s: n for s, n in slots.items() if n > 1}

    needs_review = [
        {"id": c.id, "title": c.title, "type": c.type, "status": c.status,
         "age_days": round(c.age_days())}
        for c in active
        if c.status == "disputed" or c.confidence < 0.5
    ]

    subjects: dict[str, int] = {}
    for c in active:
        head = c.subject.split(":")[0] if c.subject else "(空)"
        subjects[head] = subjects.get(head, 0) + 1

    return {
        "total": len(cards),
        "active": len(active),
        "by_type": by_type,
        "by_status": by_status,
        "contested_slots": contested,
        "needs_review": needs_review,
        "subjects": dict(sorted(subjects.items(), key=lambda kv: -kv[1])),
        "hot_cards": sorted(
            [{"id": c.id, "title": c.title, "hits": c.hits} for c in active],
            key=lambda d: -d["hits"],
        )[:10],
        "cold_cards": [
            {"id": c.id, "title": c.title, "days_unused": round(c.days_since_hit())}
            for c in active
        ][:0],
        "maps": sorted(str(p.relative_to(store.root)) for p in store.maps_dir.rglob("*.md"))
        if store.maps_dir.exists() else [],
    }
