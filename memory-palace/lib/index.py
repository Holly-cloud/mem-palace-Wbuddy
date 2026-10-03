"""Derived index + hybrid retrieval.

The index is a cache, never the truth. Every card in ``cards/`` and
``archive/`` is mirrored into an FTS5 table; ``reindex()`` reproduces it
exactly. Deleting ``index.db`` loses nothing.

Retrieval is deliberately **not** pure vector search. Embedding similarity is
blind to two things that dominate a personal memory palace:

- whether a card is *currently* true (a superseded card embeds just as close
  as the one that replaced it);
- whether two cards are talking about the *same slot* (same subject, same
  facet) and therefore actually contradict each other.

So the ranking blends four signals: full-text relevance, exact slot match,
recency, and a status penalty that pushes dead cards down. Cards mentioning
the same slot as the query are also gathered as a "same-slot" band, which is
what lets the caller detect and surface contradictions instead of silently
returning one of the two.
"""

from __future__ import annotations

import math
import re
import sqlite3
from pathlib import Path

from . import card as cardmod
from . import config as cfgmod
from .card import Card

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    subject      TEXT NOT NULL DEFAULT '',
    predicate    TEXT NOT NULL DEFAULT '',
    value        TEXT NOT NULL DEFAULT '',
    slot         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active',
    confidence   REAL NOT NULL DEFAULT 0.8,
    importance   REAL NOT NULL DEFAULT 0.6,
    valid_from   TEXT NOT NULL DEFAULT '',
    valid_to     TEXT NOT NULL DEFAULT '',
    recorded_at  TEXT NOT NULL DEFAULT '',
    ended_at     TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '',
    aliases      TEXT NOT NULL DEFAULT '',
    links        TEXT NOT NULL DEFAULT '',
    supersedes   TEXT NOT NULL DEFAULT '',
    superseded_by TEXT NOT NULL DEFAULT '',
    review_after TEXT NOT NULL DEFAULT '',
    hits         INTEGER NOT NULL DEFAULT 0,
    last_hit     TEXT NOT NULL DEFAULT '',
    path         TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    digest       TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
    title, value, body, tags, aliases, subject, predicate,
    content='cards', content_rowid='rowid', tokenize='unicode61'
);
CREATE INDEX IF NOT EXISTS idx_cards_slot ON cards(slot);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
CREATE INDEX IF NOT EXISTS idx_cards_digest ON cards(digest);
"""

# Explicit column order shared by the CREATE TABLE above and every INSERT.
COLUMNS = [
    "id", "type", "title", "subject", "predicate", "value", "slot",
    "status", "confidence", "importance", "valid_from", "valid_to",
    "recorded_at", "ended_at", "source", "tags", "aliases", "links", "supersedes",
    "superseded_by", "review_after", "hits", "last_hit", "path", "body",
    "digest",
]


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def reindex(store, cfg: dict, progress=None) -> int:
    """Rebuild the whole index from Markdown. Idempotent and cheap."""
    conn = connect(store.db_path)
    cards = store.all_cards(include_archived=True)
    conn.execute("DELETE FROM cards")
    rows = []
    for c in cards:
        rows.append(
            (
                c.id, c.type, c.title, c.subject, c.predicate, c.value, c.slot,
                c.status, c.confidence, c.importance, c.valid_from, c.valid_to,
                c.recorded_at, c.ended_at, c.source, ",".join(c.tags),
                ",".join(c.aliases), ",".join(c.links), ",".join(c.supersedes),
                c.superseded_by, c.review_after, c.hits, c.last_hit, c.path,
                c.body, c.digest(),
            )
        )
        if progress:
            progress(c)
    conn.executemany(
        f"INSERT INTO cards ({','.join(COLUMNS)}) VALUES ({','.join('?' * len(COLUMNS))})",
        rows,
    )
    # Rebuild the external-content FTS index from scratch.
    conn.execute("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')")
    conn.commit()
    conn.close()
    return len(cards)


def row_to_card(row: sqlite3.Row) -> Card:
    return Card(
        id=row["id"], type=row["type"], title=row["title"], subject=row["subject"],
        predicate=row["predicate"], value=row["value"], status=row["status"],
        confidence=row["confidence"], importance=row["importance"],
        valid_from=row["valid_from"], valid_to=row["valid_to"],
        recorded_at=row["recorded_at"], ended_at=row["ended_at"],
        source=row["source"], tags=[t for t in row["tags"].split(",") if t],
        aliases=[a for a in row["aliases"].split(",") if a],
        links=[l for l in row["links"].split(",") if l], body=row["body"],
        hits=row["hits"], last_hit=row["last_hit"], path=row["path"],
        supersedes=[s for s in row["supersedes"].split(",") if s],
        superseded_by=row["superseded_by"], review_after=row["review_after"],
    )


_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[一-鿿]")
_CJK_RE = re.compile(r"[一-鿿]+")


def tokenize(query: str) -> list[str]:
    """CJK bigrams + latin words.

    Per-character segmentation of Chinese produces useless matches: the token
    「用」 or 「我」 hits half the corpus. Bigrams approximate word boundaries
    well enough for recall without shipping a dictionary-based segmenter.
    """
    tokens: list[str] = []
    for chunk in re.split(r"[\s,.;:!?，。；：、/\\]+", query or ""):
        if not chunk:
            continue
        for run in _CJK_RE.findall(chunk):
            if len(run) == 1:
                tokens.append(run)
            else:
                tokens.extend(run[i:i + 2] for i in range(len(run) - 1))
        latin = re.findall(r"[A-Za-z0-9_]+", chunk)
        tokens.extend(w.lower() for w in latin)
    return [t for t in tokens if t]


def _bigrams(text: str) -> set[str]:
    """Bigrams for CJK runs; whole words for latin. Must mirror `tokenize`."""
    out: set[str] = set()
    for chunk in re.split(r"[\s,.;:!?，。；：、/\\:()（）]+", text or ""):
        if not chunk:
            continue
        for run in _CJK_RE.findall(chunk):
            if len(run) == 1:
                out.add(run)
            else:
                out.update(run[i:i + 2] for i in range(len(run) - 1))
        out.update(w.lower() for w in re.findall(r"[A-Za-z0-9_]+", chunk))
    return out


def _norm(text: str) -> str:
    return (text or "").lower()


def _fts_match_expr(tokens: list[str]) -> str:
    quoted = []
    for t in tokens:
        escaped = t.replace('"', '""')
        quoted.append(f'"{escaped}"')
    return " OR ".join(quoted)


def _recency_score(card: Card, ref, halflife: float) -> float:
    age = card.age_days(ref)
    return 0.5 ** (age / max(halflife, 1.0))


def _reuse_score(card: Card) -> float:
    return min(1.0, math.log1p(max(0, card.hits)) / math.log(21))


def search(
    store,
    cfg: dict,
    query: str,
    *,
    limit: int = 8,
    types: list[str] | None = None,
    subjects: list[str] | None = None,
    include_non_active: bool = False,
    as_of: str | None = None,
) -> dict:
    """Hybrid retrieval. Returns candidates plus a conflict report."""
    conn = connect(store.db_path)
    weights = cfg.get("weights", cfgmod.WEIGHTS)
    penalties = cfg.get("status_penalty", cfgmod.STATUS_PENALTY)
    halflife = float(cfg.get("recency_halflife_days", cfgmod.RECENCY_HALFLIFE_DAYS))
    ref = cardmod.now()

    where: list[str] = []
    params: list = []
    if not include_non_active:
        where.append("c.status = 'active'")
    if as_of:
        where.append("(c.valid_from = '' OR c.valid_from <= ?)")
        params.append(as_of)
        where.append("(c.valid_to = '' OR c.valid_to > ?)")
        params.append(as_of)
    if types:
        where.append(f"c.type IN ({','.join('?' * len(types))})")
        params.extend(types)
    if subjects:
        where.append(f"(c.subject IN ({','.join('?' * len(subjects))}) OR c.subject LIKE ?)")
        params.extend(subjects)
        params.append(f"%{subjects[0].split(':')[0]}%")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    all_rows = conn.execute(f"SELECT c.* FROM cards c {clause}", params).fetchall()

    tokens = tokenize(query)
    q_norm = _norm(query)
    token_set = _bigrams(query)
    scored: list[tuple[float, sqlite3.Row, dict]] = []
    for row in all_rows:
        card = row_to_card(row)
        text = " ".join([row["title"], row["value"], row["body"], row["tags"], row["predicate"]])
        haystack = _bigrams(text)
        term_hits = sum(1 for t in token_set if t in haystack)
        lexical = (term_hits / len(token_set)) if token_set else 0.0

        # Alias bridge. The palace stores English slugs (subject/predicate)
        # but gets queried in Chinese. Aliases are the hand-maintained,
        # human-readable bridge: `aliases: [语言, 用什么语言, english or chinese]`.
        # An alias hit is strong evidence of intent, so it counts more than a
        # stray bigram match but less than a literal slot mention.
        alias_hit = 0.0
        if card.aliases:
            alias_norm = _norm(" ".join(card.aliases))
            alias_tokens = _bigrams(alias_norm)
            overlap = token_set & alias_tokens
            if overlap:
                alias_hit = min(1.0, len(overlap) / max(1.0, min(len(token_set), 6)))
            elif alias_norm and alias_norm in q_norm:
                alias_hit = 1.0

        # Slot alignment: does the query name this card's subject or predicate?
        slot_exact = 0.0
        subj, _, pred = card.slot.partition("::")
        subj = subj.split(":")[-1]
        flat_q = q_norm.replace("_", "").replace("-", "").replace(":", "")
        if subj and subj in flat_q:
            slot_exact += 0.6
        if pred and len(pred) > 2 and pred.replace("_", "") in flat_q:
            slot_exact += 0.6

        tag_hit = 1.0 if any(
            _norm(t) in token_set or (_norm(t) and _norm(t) in t) for t in card.tags
        ) else 0.0

        # Relevance = evidence that THIS card answers THIS query. Kept separate
        # from the prior (importance/recency/reuse) so a card cannot rank highly
        # purely by being important and recent while matching nothing.
        relevance = (
            weights.get("bm25", 1.0) * lexical
            + weights.get("slot_exact", 1.5) * slot_exact
            + weights.get("alias_hit", 1.2) * alias_hit
            + weights.get("tag_hit", 0.6) * tag_hit
        )
        prior = (
            weights.get("importance", 0.8) * card.importance
            + weights.get("confidence", 0.4) * card.confidence
            + weights.get("recency", 0.3) * _recency_score(card, ref, halflife)
            + weights.get("reuse", 0.25) * _reuse_score(card)
        )
        # Gate: with no query evidence at all, a card is demoted hard. With
        # evidence, the prior acts as a tiebreaker among plausible matches.
        gated = (1.0 + prior) if relevance > 0 else (prior * 0.15 - 0.5)
        score = relevance * gated + penalties.get(card.status, 0.0)
        breakdown = {
            "relevance": round(relevance, 3),
            "prior": round(prior, 3),
            "lexical": round(lexical, 3),
            "slot_exact": round(slot_exact, 2),
            "alias": round(alias_hit, 2),
            "status": card.status,
        }
        scored.append((score, row, breakdown))

    scored.sort(key=lambda t: t[0], reverse=True)

    query_subjects = {s.lower() for s in re.findall(r"[\w-]+:[\w-]+", query or "")}
    same_slot: list[Card] = []
    if query_subjects:
        marks = ",".join("?" * len(query_subjects))
        rows = conn.execute(
            f"SELECT c.* FROM cards c WHERE LOWER(c.subject) IN ({marks})", list(query_subjects)
        ).fetchall()
        same_slot = [row_to_card(r) for r in rows]

    results = []
    for score, row, breakdown in scored[:limit]:
        if score <= 0:
            continue
        results.append({"card": row_to_card(row), "score": round(score, 4), "signals": breakdown})

    conflicts = _detect_conflicts(conn, same_slot or [r["card"] for r in results])
    conn.close()
    return {
        "query": query,
        "results": results,
        "same_slot": same_slot,
        "conflicts": conflicts,
        "total_indexed": len(all_rows),
    }


def _detect_conflicts(conn: sqlite3.Connection, cards: list[Card]) -> list[dict]:
    """Slot-level truth table: which facets have >1 active claim."""
    live = [c for c in cards if c.status in ("active", "disputed")]
    buckets: dict[str, list[Card]] = {}
    for c in live:
        if c.subject and c.predicate:
            buckets.setdefault(c.slot, []).append(c)
    out: list[dict] = []
    for slot, members in buckets.items():
        if len(members) < 2:
            continue
        members.sort(key=lambda c: (c.valid_from or c.recorded_at or ""), reverse=True)
        newest = members[0]
        stale = members[1:]
        unresolved = any(m.status == "disputed" for m in members)
        out.append(
            {
                "slot": slot,
                "subject": newest.subject,
                "predicate": newest.predicate,
                "current": newest,
                "shadowed": stale,
                "needs_human": unresolved,
                "reason": "同一 slot 存在多条 active 记忆，需要裁决或标注 valid_to",
            }
        )
    out.sort(key=lambda d: (not d["needs_human"], d["slot"]))
    return out


def record_use(store, card_ids: list[str]) -> None:
    """Bump hit counters so gc can tell cold cards from useful ones."""
    if not card_ids:
        return
    conn = connect(store.db_path)
    stamp = cardmod.stamp()
    conn.executemany(
        "UPDATE cards SET hits = hits + 1, last_hit = ? WHERE id = ?",
        [(stamp, cid) for cid in card_ids],
    )
    conn.commit()
    conn.close()
    for cid in card_ids:
        found = store.get(cid)
        if found:
            found.hits += 1
            found.last_hit = stamp
            store.save(found)


def stats(store) -> dict:
    conn = connect(store.db_path)
    rows = conn.execute("SELECT type, status, COUNT(*) c FROM cards GROUP BY type, status").fetchall()
    by_type: dict[str, dict[str, int]] = {}
    total = 0
    active = 0
    for r in rows:
        by_type.setdefault(r["type"], {})[r["status"]] = r["c"]
        total += r["c"]
        if r["status"] == "active":
            active += r["c"]
    slot_rows = conn.execute(
        "SELECT slot, COUNT(*) c FROM cards WHERE status='active' GROUP BY slot HAVING c > 1"
    ).fetchall()
    conflicts = [{"slot": r["slot"], "count": r["c"]} for r in slot_rows]
    holes = conn.execute(
        "SELECT COUNT(*) c FROM cards WHERE status='active' AND (subject='' OR predicate='')"
    ).fetchone()["c"]
    body_rows = conn.execute("SELECT LENGTH(body) n FROM cards").fetchall()
    body_sizes = sorted(r["n"] for r in body_rows)
    conn.close()
    return {
        "total": total,
        "active": active,
        "by_type": by_type,
        "conflict_slots": conflicts,
        "malformed_slots": holes,
        "body_chars": {
            "total": sum(body_sizes),
            "median": body_sizes[len(body_sizes) // 2] if body_sizes else 0,
            "p95": body_sizes[int(len(body_sizes) * 0.95)] if body_sizes else 0,
            "max": body_sizes[-1] if body_sizes else 0,
        },
    }
