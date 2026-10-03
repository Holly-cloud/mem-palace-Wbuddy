"""Palace-wide configuration: memory types, TTL policy, scoring weights.

Every knob that affects maintenance behaviour lives here so that tuning is a
config edit, not a code change. ``config.json`` in ``.palace/`` overrides any of
these values; anything absent falls back to the defaults below.
"""

from __future__ import annotations

import json
from pathlib import Path

# --- Memory type taxonomy -------------------------------------------------
# Derived from the union of the LYT note taxonomy (Things/Statements/Questions/
# Quotes/People) and the cognitive-science memory taxonomy used across the
# agent-memory literature (semantic / episodic / procedural / preference).
#
# ttl_days       : how long an untouched `active` card stays current.
# importance     : baseline weight; scales the effective TTL and ranking.
# body_limit     : hard cap in characters. One card, one fact. Overflow means
#                  the card should be split, not grown.
# volatile       : if true, the type is expected to churn and is the first
#                  target for archival during gc.
TYPES: dict[str, dict] = {
    "profile": {
        "label": "身份事实",
        "desc": "用户是谁：姓名、职业、城市、长期身份。",
        "ttl_days": 730,
        "importance": 0.70,
        "body_limit": 600,
        "volatile": False,
    },
    "preference": {
        "label": "偏好约定",
        "desc": "用户希望如何被对待：语气、格式、风格、禁忌。",
        "ttl_days": 365,
        "importance": 0.60,
        "body_limit": 600,
        "volatile": False,
    },
    "environment": {
        "label": "环境事实",
        "desc": "机器、路径、工具链、账号位置等硬事实。",
        "ttl_days": 180,
        "importance": 0.85,
        "body_limit": 800,
        "volatile": True,
    },
    "project": {
        "label": "进行中工作",
        "desc": "有目标、有起止的工作项与当前状态。",
        "ttl_days": 120,
        "importance": 0.85,
        "body_limit": 1200,
        "volatile": True,
    },
    "procedure": {
        "label": "操作规程",
        "desc": "怎么做：命令、流程、约定、检查清单。",
        "ttl_days": 365,
        "importance": 0.80,
        "body_limit": 1400,
        "volatile": False,
    },
    "lesson": {
        "label": "经验教训",
        "desc": "踩过的坑与结论。最容易膨胀，也最有复用价值。",
        "ttl_days": 540,
        "importance": 0.75,
        "body_limit": 1200,
        "volatile": False,
    },
    "decision": {
        "label": "决策记录",
        "desc": "做了什么选择、为什么、以及被什么取代。",
        "ttl_days": 365,
        "importance": 0.90,
        "body_limit": 1200,
        "volatile": False,
    },
    "episode": {
        "label": "事件记录",
        "desc": "发生过什么。流水账性质，应沉淀为 lesson 或 decision。",
        "ttl_days": 90,
        "importance": 0.40,
        "body_limit": 900,
        "volatile": True,
    },
}

TYPE_ORDER = list(TYPES.keys())

# --- Card lifecycle states ------------------------------------------------
# active     : currently believed true
# superseded : was true, a newer card replaced it (valid_to is set)
# expired    : passed its TTL without refresh (valid_to is set)
# disputed   : a contradiction could not be auto-judged; needs a human
# archived   : intentionally retired; kept for history, excluded from recall
STATUSES = ("active", "superseded", "expired", "disputed", "archived")

# Status handling in ranking. Negative = penalty applied to the relevance score.
STATUS_PENALTY = {
    "active": 0.0,
    "disputed": -0.60,   # still recallable, but flagged
    "expired": -1.50,
    "superseded": -2.00,
    "archived": -2.00,
}

# Semantic link vocabulary (Zettelkasten `rel:` extensions).
LINK_RELATIONS = (
    "extends",     # this memory elaborates another
    "supports",    # this memory is evidence for another
    "contradicts", # this memory is incompatible with another
    "refines",     # this memory narrows / sharpens another
    "supersedes",  # this memory replaces another (mirror of status)
    "derived_from",# this memory was distilled from an episode
    "example_of",  # this memory is a case illustrating another
)

# --- Ranking weights ------------------------------------------------------
WEIGHTS = {
    "bm25": 1.00,          # lexical overlap, normalized 0..1
    "slot_exact": 1.50,    # subject+predicate matched the query
    "alias_hit": 1.20,     # an authored Chinese trigger word matched
    "tag_hit": 0.60,       # one or more query terms matched tags
    "importance": 0.80,
    "confidence": 0.40,
    "recency": 0.30,       # half-life decay on recorded_at
    "reuse": 0.25,         # log-ish bonus for cards that keep getting used
}

RECENCY_HALFLIFE_DAYS = 180.0

# Cards below this importance after gc are archived first.
GC_IMPORTANCE_FLOOR = 0.25
# A card must be unused for this long before gc may consider archiving it.
GC_UNUSED_DAYS = 90
# Never archive these no matter how cold, however low the importance.
GC_PROTECTED_TYPES = ("profile", "preference", "decision")

DEFAULT_CONFIG: dict = {
    "types": TYPES,
    "status_penalty": STATUS_PENALTY,
    "weights": WEIGHTS,
    "recency_halflife_days": RECENCY_HALFLIFE_DAYS,
    "gc": {
        "importance_floor": GC_IMPORTANCE_FLOOR,
        "unused_days": GC_UNUSED_DAYS,
        "protected_types": list(GC_PROTECTED_TYPES),
    },
    "link_relations": list(LINK_RELATIONS),
}


def load(palace_root: Path) -> dict:
    """Load config, overlaying ``.palace/config.json`` on the defaults."""
    path = palace_root / ".palace" / "config.json"
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if path.exists():
        try:
            user = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"config.json 解析失败: {exc}")
        _merge(cfg, user)
    return cfg


def _merge(base: dict, overlay: dict) -> dict:
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value
    return base


def type_meta(cfg: dict, card_type: str) -> dict:
    meta = cfg.get("types", {}).get(card_type)
    if meta is None:
        meta = {
            "label": card_type,
            "desc": "自定义类型。",
            "ttl_days": 365,
            "importance": 0.6,
            "body_limit": 1200,
            "volatile": False,
        }
        cfg.setdefault("types", {})[card_type] = meta
    return meta
