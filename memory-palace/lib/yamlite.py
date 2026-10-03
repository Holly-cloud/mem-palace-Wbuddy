"""Minimal YAML-subset parser/serializer.

Supports exactly what the memory card frontmatter needs:
  - ``key: scalar``            (str / int / float / bool / null)
  - ``key: [a, b, c]``         inline list
  - ``key:`` + ``  - item``    block list
  - ``# comment`` lines and blank lines

This is deliberately not a general YAML implementation. Keeping it dependency-free
means the palace stays readable and hackable years from now, which is the whole
point of keeping Markdown as the source of truth.
"""

from __future__ import annotations

import json
import re
from typing import Any

_TRUE = {"true", "yes", "on"}
_FALSE = {"false", "no", "off"}
_NULL = {"", "null", "none", "~"}

_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+\.\d+$")


def _parse_scalar(raw: str) -> Any:
    s = raw.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    low = s.lower()
    if low in _NULL:
        return None
    if low in _TRUE:
        return True
    if low in _FALSE:
        return False
    if _INT_RE.match(s):
        return int(s)
    if _FLOAT_RE.match(s):
        return float(s)
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(p) for p in inner.split(",")]
    return s


def _needs_quotes(value: str) -> bool:
    if value == "":
        return True
    if value.strip() != value:
        return True
    if value[0] in "#&*!|>%@`{}[],\"'":
        return True
    if ": " in value or value.endswith(":"):
        return True
    if " #" in value:
        return True
    low = value.lower()
    if low in _TRUE | _FALSE | _NULL:
        return True
    if _INT_RE.match(value) or _FLOAT_RE.match(value):
        return True
    return False


def _dump_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if "\n" in text:
        return json.dumps(text, ensure_ascii=False)
    if _needs_quotes(text):
        return json.dumps(text, ensure_ascii=False)
    return text


def parse(text: str) -> dict[str, Any]:
    """Parse a YAML-subset document into a dict. Unknown shapes degrade to str."""
    data: dict[str, Any] = {}
    current_key: str | None = None
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        stripped = raw_line.strip()
        if stripped.startswith("- "):
            if current_key is None:
                continue
            bucket = data.get(current_key)
            if not isinstance(bucket, list):
                bucket = []
                data[current_key] = bucket
            bucket.append(_parse_scalar(stripped[2:]))
            continue
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        if not value:
            data[key] = []
            current_key = key
            continue
        data[key] = _parse_scalar(value)
        current_key = key
    return data


def dump(data: dict[str, Any], order: list[str] | None = None) -> str:
    """Serialize a dict back to the YAML subset, honouring a preferred key order."""
    keys = [k for k in (order or []) if k in data]
    keys += [k for k in data if k not in keys]
    lines: list[str] = []
    for key in keys:
        value = data[key]
        if isinstance(value, list):
            if not value:
                lines.append(f"{key}: []")
            elif all(not isinstance(v, (dict, list)) for v in value):
                lines.append(f"{key}: [{', '.join(_dump_scalar(v) for v in value)}]")
            else:
                lines.append(f"{key}:")
                for item in value:
                    lines.append(f"  - {_dump_scalar(item)}")
        else:
            lines.append(f"{key}: {_dump_scalar(value)}")
    return "\n".join(lines)


def split(text: str) -> tuple[str, str]:
    """Split a document into (frontmatter_text, body). Frontmatter optional."""
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines()
    if lines[0].strip() != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i]), "\n".join(lines[i + 1:])
    return "", text


def join(frontmatter: str, body: str) -> str:
    body = body.lstrip("\n")
    if not frontmatter.strip():
        return body
    return f"---\n{frontmatter.strip()}\n---\n\n{body}"
