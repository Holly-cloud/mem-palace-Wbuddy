"""The memory card: schema, validation, (de)serialization.

Design rules encoded here:

1. **One card = one claim.** Atomicity is what makes conflict detection and
   expiry tractable. A card states `subject` + `predicate` -> `value`.
2. **The slot is the conflict key.** Two cards conflict iff they share
   `(subject, predicate)` and both are `active`. Differing predicates about the
   same subject are not conflicts — they are different facets.
3. **Bi-temporal.** `valid_from` / `valid_to` record when the claim was true in
   the world; `recorded_at` / `ended_at` record when the palace learned it.
   Keeping both apart is what makes "what did I believe last March" answerable
   after a preference changes today.
4. **Supersede, never delete.** History stays queryable; only status changes.
5. **Provenance is mandatory.** Every card records where it came from and how
   confident the extractor was, so a human can audit or bulk-reject.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

from . import yamlite

SCHEMA_VERSION = 1

# Frontmatter key order — keep human diffs stable.
KEY_ORDER = [
    "id",
    "type",
    "title",
    "subject",
    "predicate",
    "value",
    "status",
    "confidence",
    "importance",
    "valid_from",
    "valid_to",
    "recorded_at",
    "ended_at",
    "source",
    "links",
    "tags",
    "aliases",
    "hits",
    "last_hit",
    "supersedes",
    "superseded_by",
    "review_after",
    "schema",
]

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def now() -> dt.datetime:
    return dt.datetime.now()


def today() -> str:
    return now().strftime("%Y-%m-%d")


def stamp() -> str:
    return now().strftime("%Y-%m-%dT%H:%M")


def slugify(text: str, limit: int = 40) -> str:
    """ASCII slug; falls back to a short hash for CJK titles."""
    text = (text or "").strip().lower()
    slug = _SLUG_RE.sub("-", text.encode("ascii", "ignore").decode()).strip("-")
    if not slug:
        slug = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
    return slug[:limit].strip("-") or "note"


def make_id(seq: int) -> str:
    """Human-readable, sortable, stable identity. Never reused after deletion."""
    return f"mem_{seq:05d}"


@dataclass
class Card:
    # --- identity -----------------------------------------------------
    id: str = ""
    type: str = "lesson"
    title: str = ""

    # --- the claim (slot definition) ----------------------------------
    subject: str = ""      # entity or topic: "user", "project:memory-palace"
    predicate: str = ""    # facet: "prefers_output_format", "uses_python_version"
    value: str = ""        # the claim content in one line

    # --- lifecycle ----------------------------------------------------
    status: str = "active"
    confidence: float = 0.8
    importance: float = 0.6

    # --- bi-temporal --------------------------------------------------
    valid_from: str = ""   # date the claim became true in the world
    valid_to: str = ""     # date it stopped being true ("" == still true)
    recorded_at: str = ""  # when the palace learned it
    ended_at: str = ""     # when the palace learned it stopped being true

    # --- provenance & relations ---------------------------------------
    source: str = ""       # "session:<id>" | "manual" | "import:<path>" | "distill:<id>"
    links: list[str] = field(default_factory=list)   # ["<id>:contradicts", ...]
    tags: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)  # 中文触发词，见 searchable_text

    # --- usage statistics ----------------------------------------------
    hits: int = 0
    last_hit: str = ""

    # --- supersede chain ----------------------------------------------
    supersedes: list[str] = field(default_factory=list)
    superseded_by: str = ""
    review_after: str = ""  # set when a card is worth re-confirming later

    # --- payload ------------------------------------------------------
    body: str = ""
    path: str = ""          # repo-relative file path, filled on write
    schema: int = SCHEMA_VERSION

    # -- derived ---------------------------------------------------------
    @property
    def slot(self) -> str:
        return f"{self.subject.strip().lower()}::{self.predicate.strip().lower()}"

    @property
    def is_current(self) -> bool:
        return self.status == "active" and not self.valid_to

    def age_days(self, ref: dt.datetime | None = None) -> float:
        ref = ref or now()
        ts = parse_dt(self.recorded_at) or parse_dt(self.valid_from)
        if ts is None:
            return 0.0
        return max(0.0, (ref - ts).total_seconds() / 86400.0)

    def days_since_hit(self, ref: dt.datetime | None = None) -> float:
        if not self.last_hit:
            return self.age_days(ref)
        ts = parse_dt(self.last_hit)
        if ts is None:
            return self.age_days(ref)
        ref = ref or now()
        return max(0.0, (ref - ts).total_seconds() / 86400.0)

    # -- serialization ---------------------------------------------------
    def frontmatter(self) -> str:
        data: dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "title": self.title,
            "subject": self.subject,
            "predicate": self.predicate,
            "value": self.value,
            "status": self.status,
            "confidence": round(float(self.confidence), 3),
            "importance": round(float(self.importance), 3),
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "recorded_at": self.recorded_at,
            "ended_at": self.ended_at,
            "source": self.source,
            "links": self.links,
            "tags": self.tags,
            "aliases": self.aliases,
            "hits": self.hits,
            "last_hit": self.last_hit,
            "supersedes": self.supersedes,
            "superseded_by": self.superseded_by,
            "review_after": self.review_after,
            "schema": self.schema,
        }
        return yamlite.dump(data, KEY_ORDER)

    def render(self) -> str:
        return yamlite.join(self.frontmatter(), self.body)

    def digest(self) -> str:
        """Content hash used to spot exact-duplicate writes cheaply."""
        basis = f"{self.slot}|{self.value.strip().lower()}|{self.body.strip()}"
        return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]

    def searchable_text(self) -> str:
        return " ".join(
            [
                self.title, self.value, self.body, self.subject, self.predicate,
                " ".join(self.tags), " ".join(self.aliases),
            ]
        )


def parse_dt(text: str) -> dt.datetime | None:
    if not text:
        return None
    text = text.strip().replace("Z", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def normalize_date(text: str) -> str:
    """Accept 'today' / 'yesterday' / ISO-ish input, return YYYY-MM-DD."""
    if not text:
        return ""
    text = text.strip()
    low = text.lower()
    if low in ("today", "now"):
        return today()
    if low == "yesterday":
        return (now() - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    ts = parse_dt(text)
    return ts.strftime("%Y-%m-%d") if ts else text


# --- (de)serialization ----------------------------------------------------

_LIST_FIELDS = {"tags", "supersedes", "links"}


def from_frontmatter(data: dict[str, Any], body: str = "", path: str = "") -> Card:
    def as_list(key: str) -> list[str]:
        raw = data.get(key)
        if raw is None:
            return []
        if isinstance(raw, list):
            return [str(x) for x in raw if x is not None and str(x) != ""]
        text = str(raw).strip()
        return [text] if text else []

    def as_float(key: str, default: float) -> float:
        raw = data.get(key, default)
        try:
            return float(raw)
        except (TypeError, ValueError):
            return default

    def as_int(key: str) -> int:
        try:
            return int(data.get(key, 0) or 0)
        except (TypeError, ValueError):
            return 0

    return Card(
        id=str(data.get("id", "") or ""),
        type=str(data.get("type", "lesson") or "lesson"),
        title=str(data.get("title", "") or ""),
        subject=str(data.get("subject", "") or ""),
        predicate=str(data.get("predicate", "") or ""),
        value=str(data.get("value", "") or ""),
        status=str(data.get("status", "active") or "active"),
        confidence=as_float("confidence", 0.8),
        importance=as_float("importance", 0.6),
        valid_from=normalize_date(str(data.get("valid_from", "") or "")),
        valid_to=normalize_date(str(data.get("valid_to", "") or "")),
        recorded_at=str(data.get("recorded_at", "") or ""),
        ended_at=str(data.get("ended_at", "") or ""),
        source=str(data.get("source", "") or ""),
        links=as_list("links"),
        tags=as_list("tags"),
        aliases=as_list("aliases"),
        hits=as_int("hits"),
        last_hit=str(data.get("last_hit", "") or ""),
        supersedes=as_list("supersedes"),
        superseded_by=str(data.get("superseded_by", "") or ""),
        review_after=normalize_date(str(data.get("review_after", "") or "")),
        body=body.strip(),
        path=path,
    )


def load_file(path, repo_root=None) -> Card | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    fm_text, body = yamlite.split(text)
    if not fm_text:
        return None
    data = yamlite.parse(fm_text)
    if not data.get("id"):
        return None
    rel = ""
    if repo_root is not None:
        try:
            rel = str(path.relative_to(repo_root)).replace("\\", "/")
        except ValueError:
            rel = path.name
    return from_frontmatter(data, body, rel)


# --- validation -----------------------------------------------------------

REQUIRED_FIELDS = ("id", "type", "title", "subject", "predicate", "status")


def validate(card: Card, cfg: dict) -> list[str]:
    """Return a list of human-readable problems. Empty list == valid."""
    from . import config as cfgmod

    problems: list[str] = []
    for field_name in REQUIRED_FIELDS:
        if not str(getattr(card, field_name, "") or "").strip():
            problems.append(f"缺少必填字段 `{field_name}`")

    known = cfgmod.TYPES
    if card.type not in known:
        problems.append(f"未知类型 `{card.type}`（建议改用：{', '.join(known)}）")
    if card.status not in cfgmod.STATUSES:
        problems.append(f"未知状态 `{card.status}`（合法值：{', '.join(cfgmod.STATUSES)}）")

    if card.subject and " " in card.subject.strip():
        problems.append("subject 不应包含空格，请用 `-` 连接（如 `project:my-app`）")
    if card.predicate and " " in card.predicate.strip():
        problems.append("predicate 不应包含空格，请用 snake_case")

    limit = cfgmod.type_meta(cfg, card.type).get("body_limit", 1200)
    if len(card.body) > limit:
        problems.append(
            f"正文 {len(card.body)} 字符，超过 `{card.type}` 上限 {limit}。"
            "一张卡只讲一件事，请拆成多张并用 links 串联"
        )
    if not card.value.strip() and not card.body.strip():
        problems.append("value 与 body 不能同时为空")

    for name in ("confidence", "importance"):
        val = getattr(card, name)
        if not 0.0 <= val <= 1.0:
            problems.append(f"{name} 必须在 0..1 之间，当前为 {val}")

    if card.valid_from and card.valid_to and card.valid_to < card.valid_from:
        problems.append(f"valid_to ({card.valid_to}) 早于 valid_from ({card.valid_from})")

    if card.status == "active" and card.valid_to:
        problems.append("status=active 时不应设置 valid_to；结束有效期请改用 superseded/expired")
    if card.status in ("superseded", "expired") and not card.valid_to:
        problems.append(f"status={card.status} 时必须设置 valid_to 以记录失效时间")
    if card.status == "superseded" and not card.superseded_by:
        problems.append("status=superseded 时必须写明 superseded_by，便于追溯取代链")

    rels = {r.split(":", 1)[0] for r in card.links if ":" in r}
    unknown = rels - set(cfg.get("link_relations", cfgmod.LINK_RELATIONS))
    for rel in sorted(unknown):
        problems.append(f"未知链接关系 `{rel}`")
    return problems
