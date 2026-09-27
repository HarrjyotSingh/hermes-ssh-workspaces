"""Incremental workspace markdown index maintenance (Stage 5B).

The Stage 4 index (bounded scan, 5000-file cap, >512 KB exclusion,
dot-directory exclusion) remains the FALLBACK full rebuild - unchanged.
This module patches ONLY the affected entry/entries after a single-file
create/modify/delete/rename so the 734-note Obsidian workspace is never
rescanned wholesale after every edit.

Storage reuses the existing per-workspace index JSON written by
``PUT /index/state`` (``index-<hash>.json`` under hermes-editor-state), so
the frontend and backend share one source of truth and no new state
format is introduced.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from pathlib import Path
from typing import Optional

from .providers.base import INDEX_MAX_FILE_BYTES, extract_md_metadata

log = logging.getLogger(__name__)

_lock = threading.Lock()


def _state_dir() -> Path:
    try:
        from .registry import state_dir
        return state_dir()
    except Exception:
        d = Path.home() / ".hermes" / "hermes-editor-state"
        d.mkdir(parents=True, exist_ok=True)
        return d


def entries_file(wid: str) -> Path:
    key = hashlib.sha256(f"ws:{wid}".encode()).hexdigest()[:12]
    return _state_dir() / f"index-{key}.json"


def load_entries(wid: str) -> Optional[list]:
    f = entries_file(wid)
    if not f.is_file():
        return None   # no index built yet: caller keeps fallback behaviour
    try:
        entries = json.loads(f.read_text(encoding="utf-8"))
        return entries if isinstance(entries, list) else None
    except (OSError, ValueError):
        return None


def save_entries(wid: str, entries: list) -> bool:
    f = entries_file(wid)
    tmp = f.with_suffix(f".tmp-{os.getpid()}")
    try:
        tmp.write_text(json.dumps(entries), encoding="utf-8")
        os.replace(tmp, f)
        return True
    except OSError as exc:
        log.warning("hermes-editor index store: persist failed: %s", exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def _entry_for(entries: list, rel: str) -> Optional[dict]:
    for e in entries:
        if isinstance(e, dict) and e.get("path") == rel:
            return e
    return None


def apply_change(wid: str, provider, rel: str,
                 deleted: bool = False,
                 renamed_to: Optional[str] = None,
                 text: Optional[str] = None,
                 stat_info: Optional[dict] = None,
                 index_markdown: bool = True) -> bool:
    """Patch exactly one affected path in the persisted workspace index.

    * modify/create : re-extract metadata for ``rel`` only
    * delete        : drop the entry
    * rename        : re-path the existing entry (content untouched)

    Returns True when the persisted index was updated. If no index has
    been built yet (or it is unreadable) this is a no-op returning False -
    the next explicit full rebuild remains the bounded fallback.
    """
    if not rel.lower().endswith(".md") or not index_markdown:
        return False
    with _lock:
        entries = load_entries(wid)
        if entries is None:
            return False

        if renamed_to is not None:
            entry = _entry_for(entries, rel)
            if entry is not None:
                entry["path"] = renamed_to
                entries.sort(key=lambda e: e.get("path", ""))
                return save_entries(wid, entries)
            # fall through: treat as create of renamed_to below
            rel, deleted = renamed_to, False

        if deleted:
            entries = [e for e in entries
                       if not (isinstance(e, dict) and e.get("path") == rel)]
            return save_entries(wid, entries)

        # create/modify: fetch fresh metadata (content supplied or read now)
        size = mtime_ns = None
        if text is None:
            try:
                f = provider.read(rel)
            except Exception:
                return False
            if f.get("encoding") != "text":
                return False
            text = f.get("content") or ""
            size = f.get("size")
            mtime_ns = f.get("mtime_ns")
        if len((text or "").encode("utf-8")) > INDEX_MAX_FILE_BYTES:
            entries = [e for e in entries
                       if not (isinstance(e, dict) and e.get("path") == rel)]
            return save_entries(wid, entries)
        meta = extract_md_metadata(text or "", rel)
        if stat_info:
            size = stat_info.get("size", size)
            mtime_ns = stat_info.get("mtime_ns", mtime_ns)
        meta["size"] = size
        meta["mtime_ns"] = mtime_ns
        existing = _entry_for(entries, rel)
        if existing is not None:
            existing.update(meta)
        else:
            entries.append(meta)
            entries.sort(key=lambda e: e.get("path", ""))
        return save_entries(wid, entries)


def backlinks_for(entries: list, target_path: str) -> list:
    """Derived (never stored) backlink list for one note."""
    stem = target_path.rsplit("/", 1)[-1]
    stem = stem.rsplit(".", 1)[0].lower()
    norm = target_path[:-3].lower() if target_path.lower().endswith(".md") \
        else target_path.lower()
    out = []
    for e in entries:
        if not isinstance(e, dict) or e.get("path") == target_path:
            continue
        linked = False
        for t in e.get("outgoing") or []:
            tl = (t or "").lower()
            if tl == norm or tl == target_path.lower() or \
                    tl.rsplit("/", 1)[-1] == stem:
                linked = True
                break
        if linked:
            out.append(e.get("path"))
    return out
