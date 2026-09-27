"""Wikilink rewriting on note rename (ZenNotes-style, MIT-licensed pattern).

Pure functions only - no provider, FastAPI, or state imports - so the same
logic can be mirrored verbatim by the web UI and any other runtime.

Scope: when ``Notes/Old Name.md`` is renamed, every ``[[Old Name ...]]`` /
``![[Old Name ...]]`` anywhere in the workspace should follow. Aliases,
``#heading`` anchors and embed markers survive; fenced and inline code never
matches (links inside code blocks are text, not links).

Target resolution mirrors what the frontend does at click time: a target
resolves against the PRE-rename index entries by exact path, unique path
suffix, basename, title, or alias - ambiguous matches are left untouched
rather than rewritten wrongly.
"""

from __future__ import annotations

import re

# Fenced code block / inline code / (optionally embedded) wikilink tokeniser.
# Code alternatives come FIRST so their contents are preserved verbatim.
TOKEN_RE = re.compile(r"(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(!?)\[\[([^\]\n]+?)\]\]")


def strip_code_content(body: str) -> str:
    """Blank out fenced and inline code so link scanning never reads code.

    Line-based and indentation-tolerant: a fence nested under a list item is
    still a code block. Mirrors ZenNotes' stripCodeContent discipline.
    """
    if "`" not in body and "~" not in body:
        return body
    lines = body.split("\n")
    in_fence = False
    fence_char = ""
    fence_len = 0
    for i, line in enumerate(lines):
        m = re.match(r"^[ \t]*(`{3,}|~{3,})(.*)$", line)
        if m:
            marker = m.group(1)
            char = marker[0]
            rest = m.group(2)
            if not in_fence:
                # A backtick fence's info string may not contain a backtick
                # (CommonMark); tilde fences have no such restriction.
                if char == "~" or "`" not in rest:
                    in_fence = True
                    fence_char = char
                    fence_len = len(marker)
                    lines[i] = " "
                    continue
            elif char == fence_char and len(marker) >= fence_len and rest.strip() == "":
                in_fence = False
                lines[i] = " "
                continue
        if in_fence:
            lines[i] = " "
    return re.sub(r"`[^`\n]*`", " ", "\n".join(lines))


def split_wikilink_content(content: str) -> tuple:
    """Split ``[[ ... ]]`` inner text into (target, anchor, alias).

    The anchor and alias keep their leading delimiter so a link can be
    reassembled verbatim after only its target segment is swapped.
    """
    rest = content
    alias = ""
    pipe = rest.find("|")
    if pipe >= 0:
        alias = rest[pipe:]
        rest = rest[:pipe]
    anchor = ""
    m = re.search(r"[#^]", rest)
    if m:
        anchor = rest[m.start():]
        rest = rest[: m.start()]
    return rest, anchor, alias


def swap_basename(target: str, new_stem: str) -> str:
    """Replace the final path segment of a link target with ``new_stem``."""
    slash = target.rfind("/")
    directory = target[: slash + 1] if slash >= 0 else ""
    base = target[slash + 1:] if slash >= 0 else target
    md = re.search(r"\.md$", base, re.IGNORECASE)
    return f"{directory}{new_stem}{md.group(0) if md else ''}"


def _norm(value: str) -> str:
    return (value or "").strip().lower().replace("\\", "/")


def _strip_md(value: str) -> str:
    return re.sub(r"\.md$", "", value, flags=re.IGNORECASE)


def _entry_names(entry: dict) -> list:
    names = []
    stem = _strip_md(_entry_stem(entry))
    if stem:
        names.append(stem.lower())
    base = stem.rsplit("/", 1)[-1]
    if base:
        names.append(base)
    title = entry.get("title")
    if isinstance(title, str) and title.strip():
        names.append(title.strip().lower())
    for alias in entry.get("aliases") or []:
        if isinstance(alias, str) and alias.strip():
            names.append(alias.strip().lower())
    return names


def _entry_stem(entry: dict) -> str:
    path = entry.get("path") if isinstance(entry, dict) else None
    return str(path or "").replace("\\", "/")


def resolve_target_entry(entries: list, target: str) -> dict | None:
    """Resolve one stored outgoing target to an index entry, or None.

    Ladder: exact path match -> unique suffix match -> unique name match
    (basename, title or alias). Ambiguity resolves to nothing: we never
    guess between two notes with the same name.
    """
    needle = _norm(_strip_md((target or "").strip()))
    if not needle:
        return None
    stems = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        stem = _strip_md(_entry_stem(e))
        if stem:
            stems.append((stem.lower(), e))
    for stem, e in stems:
        if stem == needle:
            return e
    suffix_hits = [e for stem, e in stems if stem.endswith("/" + needle)]
    if len(suffix_hits) == 1:
        return suffix_hits[0]
    name_hits = [e for e in entries if isinstance(e, dict) and needle in _entry_names(e)]
    if len(name_hits) == 1:
        return name_hits[0]
    return None


def inbound_referencers(entries: list, old_path: str) -> list:
    """Index paths of OTHER notes whose outgoing targets resolve to ``old_path``."""
    def _points_at_old(target: str) -> bool:
        hit = resolve_target_entry(entries, target)
        return hit is not None and _entry_stem(hit) == old_path

    out = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        p = _entry_stem(e)
        if not p or p == old_path:
            continue
        for t in e.get("outgoing") or []:
            if _points_at_old(str(t)):
                out.append(p)
                break
    return out


def rewrite_links_for_rename(body: str, entries: list, old_path: str,
                             new_stem: str) -> tuple:
    """Rewrite every inbound link to ``old_path`` toward ``new_stem``.

    Returns ``(body, changed_count, touched_paths)`` where ``touched_paths``
    lists the OTHER notes whose outgoing targets resolved to ``old_path``.
    """
    def _points_at_old(target: str) -> bool:
        hit = resolve_target_entry(entries, target)
        return hit is not None and _entry_stem(hit) == old_path

    touched = inbound_referencers(entries, old_path)
    if not touched:
        return body, 0, []

    changed = 0

    def repl(m: re.Match) -> str:
        nonlocal changed
        code, embed, content = m.group(1), m.group(2), m.group(3)
        if code is not None:
            return m.group(0)
        target, anchor, alias = split_wikilink_content(content)
        if not _points_at_old(target):
            return m.group(0)
        new_target = swap_basename(target, new_stem)
        if new_target == target:
            return m.group(0)
        changed += 1
        return f"{embed}[[{new_target}{anchor}{alias}]]"

    next_body = TOKEN_RE.sub(repl, body)
    return next_body, changed, touched


def extract_outgoing_targets(text: str) -> list:
    """Code-stripped, anchor/alias-stripped outgoing wikilink targets.

    Drop-in replacement for the regex scan inside extract_md_metadata so
    indexed backlinks never count links inside code blocks.
    """
    stripped = strip_code_content(text)
    out = set()
    for m in re.finditer(r"\[\[([^\[\]\n]+)\]\]", stripped):
        inner = m.group(1).split("|")[0].split("#")[0].strip()
        if inner:
            out.add(inner)
    return sorted(out)
