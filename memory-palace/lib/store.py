"""Store: the palace's source of truth is plain Markdown on disk.

Why Markdown files and not a database:

- A human can read, edit, grep, diff and version-control the whole palace.
- The agent can navigate it with the same file tools it already uses.
- Nothing is lost when a tool is abandoned; the files outlive the code.

SQLite is a *derived* index (see ``index.py``). Delete ``.palace/index.db``
at any time and ``palace.py reindex`` rebuilds it from the files.

Layout::

    memory-palace/
      cards/<type>/mem_00042-<slug>.md    one file per memory
      maps/                              human-written MOC / index notes
      entries/YYYY-MM.md                 session journal (append-only)
      archive/                           retired cards kept for history
      .palace/
        index.db                         derived FTS5 index (rebuildable)
        seq.txt                           monotonic id counter
        config.json                       optional overrides
        audit.log                         append-only operation log
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
from pathlib import Path

from . import card as cardmod
from .card import Card

CARD_DIR = "cards"
MAP_DIR = "maps"
ENTRY_DIR = "entries"
ARCHIVE_DIR = "archive"
STATE_DIR = ".palace"

APP_NAME = "palace"


class Store:
    def __init__(self, root: Path):
        self.root = Path(root).expanduser().resolve()

    # --- paths -----------------------------------------------------------
    @property
    def cards_dir(self) -> Path:
        return self.root / CARD_DIR

    @property
    def maps_dir(self) -> Path:
        return self.root / MAP_DIR

    @property
    def entries_dir(self) -> Path:
        return self.root / ENTRY_DIR

    @property
    def archive_dir(self) -> Path:
        return self.root / ARCHIVE_DIR

    @property
    def state_dir(self) -> Path:
        return self.root / STATE_DIR

    @property
    def db_path(self) -> Path:
        return self.state_dir / "index.db"

    @property
    def seq_path(self) -> Path:
        return self.state_dir / "seq.txt"

    @property
    def audit_path(self) -> Path:
        return self.state_dir / "audit.log"

    # --- lifecycle -------------------------------------------------------
    def ensure(self) -> None:
        from . import config as cfgmod

        for path in (
            self.cards_dir,
            self.maps_dir,
            self.entries_dir,
            self.archive_dir,
            self.state_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        for card_type in cfgmod.TYPE_ORDER:
            (self.cards_dir / card_type).mkdir(parents=True, exist_ok=True)
        if not self.seq_path.exists():
            self.seq_path.write_text("0\n", encoding="utf-8")
        readme = self.root / "README.md"
        if not readme.exists():
            readme.write_text(
                "# 记忆宫殿\n\n"
                "本目录是 agent 长期记忆的**唯一真相源**。\n\n"
                "- `cards/` — 记忆卡，一张卡一件事，按类型分目录\n"
                "- `maps/` — 人工维护的主题索引（MOC），用于人工浏览\n"
                "- `entries/` — 会话日志，按月归档，只追加\n"
                "- `archive/` — 已退役的记忆卡，保留以供追溯\n"
                "- `.palace/` — 派生索引与状态，删掉可重建\n\n"
                "常用命令见 `DESIGN.md` 或运行 `python bin/palace.py --help`。\n",
                encoding="utf-8",
            )

    # --- id sequence -----------------------------------------------------
    def next_id(self) -> str:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        try:
            current = int(self.seq_path.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            current = 0
        # Never hand out an id that already exists, even if seq.txt drifted.
        existing = {c.id for c in self.all_cards()}
        while True:
            current += 1
            candidate = cardmod.make_id(current)
            if candidate not in existing:
                break
        self.seq_path.write_text(f"{current}\n", encoding="utf-8")
        return candidate

    # --- read ------------------------------------------------------------
    def all_cards(self, include_archived: bool = True) -> list[Card]:
        cards: list[Card] = []
        roots = [self.cards_dir]
        if include_archived:
            roots.append(self.archive_dir)
        for base in roots:
            if not base.exists():
                continue
            for path in sorted(base.rglob("*.md")):
                if path.name.startswith("_") or path.name == "README.md":
                    continue
                loaded = cardmod.load_file(path, self.root)
                if loaded:
                    cards.append(loaded)
        return cards

    def get(self, card_id: str) -> Card | None:
        for c in self.all_cards():
            if c.id == card_id:
                return c
        return None

    def slot_map(self, cards: list[Card] | None = None) -> dict[str, list[Card]]:
        """slot -> cards. The backbone of conflict detection."""
        cards = cards if cards is not None else self.all_cards()
        out: dict[str, list[Card]] = {}
        for c in cards:
            if c.subject and c.predicate:
                out.setdefault(c.slot, []).append(c)
        return out

    def card_path(self, card: Card) -> Path:
        if card.path:
            candidate = self.root / card.path
            if candidate.exists():
                return candidate
        target_dir = self.archive_dir / card.type if card.status == "archived" else self.cards_dir / card.type
        return target_dir / f"{card.id}-{cardmod.slugify(card.title)}.md"

    # --- write -----------------------------------------------------------
    def save(self, card: Card, move: bool = False) -> Path:
        self.ensure()
        target = self.card_path(card)
        old = self.root / card.path if card.path else None
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(card.render(), encoding="utf-8")
        if old and old.exists() and old.resolve() != target.resolve():
            old.unlink()
        card.path = str(target.relative_to(self.root)).replace("\\", "/")
        return target

    def archive(self, card: Card) -> Path:
        card.status = "archived"
        card.path = ""  # force recompute into archive dir
        return self.save(card)

    # --- audit -----------------------------------------------------------
    def audit(self, op: str, **fields) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        record = {"ts": cardmod.stamp(), "op": op}
        record.update({k: v for k, v in fields.items() if v not in (None, "", [])})
        line = json.dumps(record, ensure_ascii=False)
        with self.audit_path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    # --- session journal --------------------------------------------------
    def current_entry_path(self, ref: dt.datetime | None = None) -> Path:
        ref = ref or cardmod.now()
        month = f"{ref.year:04d}-{ref.month:02d}"
        path = self.entries_dir / month / f"{ref.day:02d}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def append_entry(self, text: str, heading: str | None = None) -> Path:
        path = self.current_entry_path()
        stamp = cardmod.stamp()
        heading = heading or stamp
        if path.exists():
            existing = path.read_text(encoding="utf-8").rstrip()
        else:
            existing = f"# {path.parent.name}-{path.stem}"
        block = f"\n\n## {heading}\n\n{text.strip()}\n"
        path.write_text(existing + block, encoding="utf-8")
        return path

    # --- bulk import ------------------------------------------------------
    def import_files(self, paths: list[Path], default_type: str = "lesson") -> list[Card]:
        """Convert loose Markdown files into cards (best-effort, no LLM needed)."""
        created: list[Card] = []
        for src in paths:
            try:
                text = Path(src).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            text = text.strip()
            if not text:
                continue
            title = ""
            for line in text.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("#").strip()
                    break
            if not title:
                title = Path(src).stem
            new_id = self.next_id()
            card = Card(
                id=new_id,
                type=default_type,
                title=title,
                subject=f"import:{cardmod.slugify(Path(src).stem, 24)}",
                predicate="imported_document",
                value=title,
                status="active",
                confidence=0.6,
                valid_from=cardmod.today(),
                recorded_at=cardmod.stamp(),
                source=f"import:{Path(src).name}",
                tags=["imported"],
                body=text,
            )
            self.save(card)
            self.audit("import", id=new_id, source=str(src), type=default_type)
            created.append(card)
        return created

    # --- backup -----------------------------------------------------------
    def backup(self, dest: Path) -> Path:
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        stamp = cardmod.now().strftime("%Y%m%d-%H%M")
        target = dest / f"palace-backup-{stamp}"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(
            self.root,
            target,
            ignore=shutil.ignore_patterns(STATE_DIR, ".git", "__pycache__"),
        )
        return target
