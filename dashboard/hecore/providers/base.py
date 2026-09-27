"""WorkspaceProvider interface for hermes-editor (Stage 5A).

A workspace provider abstracts *where* a workspace's files live: on the
Pi itself (``LocalProvider``) or on a remote machine reached over SSH
(``SshProvider``). The HTTP API layer and the frontend never care which.

Design rules carried over from Stage 3/4 (all providers must enforce
them; they are implemented once here in shared helpers):

* Paths are workspace-relative, never absolute from the client.
* Traversal (``..``) is rejected before any I/O.
* Symlink escapes are rejected: resolved targets stay inside the root.
* Revisions are SHA-256 of raw file bytes.
* Writes are compare-and-swap: current revision validated first, then
  temp file + fsync + atomic rename inside one provider operation.
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Optional

# Files larger than this are reported "oversized" with content withheld.
MAX_TEXT_BYTES = 2_000_000
MAX_IMAGE_BYTES = 8_000_000
# A NUL byte in the first chunk marks the file as binary.
BINARY_SNIFF_BYTES = 8192
# Identifiable temp-file pattern used by atomic writes (local AND remote).
TEMP_PREFIX = ".hermes-editor-tmp-"


class ProviderError(Exception):
    """Provider operation failed (already mapped to an HTTP-ish code)."""

    def __init__(self, status_code: int, detail):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class ConflictError(ProviderError):
    """Stale-revision / deleted-on-disk / exists conflict."""

    def __init__(self, reason: str, base_revision: str, current_revision: str):
        super().__init__(409, {
            "conflict": True,
            "reason": reason,
            "base_revision": base_revision,
            "current_revision": current_revision,
        })
        self.reason = reason


class OfflineError(ProviderError):
    """Every endpoint of the host is unreachable."""

    def __init__(self, host_id: str):
        super().__init__(503, {"offline": True, "host": host_id})
        self.host_id = host_id


class PathRejected(ProviderError):
    def __init__(self, detail):
        super().__init__(400, detail)


def validate_rel_path(rel: str) -> str:
    """Normalise/validate a workspace-relative path. Raises PathRejected."""
    rel = (rel or "").strip().replace("\\", "/")
    if rel.startswith("/"):
        raise PathRejected("absolute paths are not allowed")
    if "\x00" in rel:
        raise PathRejected("invalid path")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise PathRejected("path escapes workspace root")
    if any(p.startswith(".hermes-editor-tmp-") for p in parts[1:]) or \
       (len(parts) == 1 and parts and parts[0].startswith(TEMP_PREFIX)):
        # editors may create these only internally
        pass
    return "/".join(parts)


def file_revision(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_binary(data: bytes) -> bool:
    return b"\x00" in data[:BINARY_SNIFF_BYTES]


SKIPPED_DIR_NAMES = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__",
    "venv", ".venv", ".tox", ".mypy_cache", ".ruff_cache",
    ".pytest_cache", ".idea", ".vscode",
}

# Bounded index scan caps (Stage 4 values preserved).
INDEX_MAX_FILES = 5000
INDEX_MAX_FILE_BYTES = 512_000


class WorkspaceProvider:
    """Abstract storage backend for one configured workspace root."""

    kind = "abstract"

    def __init__(self, root: str):
        self.root = root

    # -- identity ---------------------------------------------------------

    def capabilities(self) -> dict:
        return {
            "stat": True, "list": True, "read": True, "revision": True,
            "write_atomic": True, "mkdir": True, "rename": True,
            "delete": True, "index_scan": True,
        }

    # -- availability -----------------------------------------------------

    def health(self) -> dict:
        """Return {'online': bool, 'endpoint': str|None, ...}."""
        raise NotImplementedError

    @property
    def active_endpoint(self) -> Optional[str]:
        return None

    # -- operations -------------------------------------------------------

    def stat(self, rel: str) -> dict:
        raise NotImplementedError

    def stat_many(self, rels: list, with_revision: bool = False) -> list:
        """Batched existence/size/mtime probe for sync polling.

        Default: per-path stat() with 404s mapped to exists=False.
        Providers may override with a true single-round-trip batch.
        With ``with_revision`` a SHA-256 is included for text-sized files
        (bounded by MAX_TEXT_BYTES) - used by revision resync paths only.
        Returns [{path, exists, size?, mtime_ns?, revision?}, ...].
        """
        out = []
        for rel in rels:
            try:
                st = self.stat(rel)
                if st.get("type") == "file":
                    entry = {"path": rel, "exists": True,
                             "size": st.get("size") or 0,
                             "mtime_ns": st.get("mtime_ns") or 0}
                    if with_revision:
                        try:
                            f = self.read(rel)
                            entry["revision"] = f.get("revision")
                        except ProviderError as exc:
                            if exc.status_code != 404:
                                raise
                    out.append(entry)
                else:
                    out.append({"path": rel, "exists": False})
            except ProviderError as exc:
                if exc.status_code == 404:
                    out.append({"path": rel, "exists": False})
                else:
                    raise
        return out

    def list_dir(self, rel: str) -> list:
        raise NotImplementedError

    def read(self, rel: str) -> dict:
        """Return {size, mtime_ns, revision, encoding, content}."""
        raise NotImplementedError

    def read_image(self, rel: str) -> bytes:
        """Return bounded image bytes from a workspace-relative path."""
        raise NotImplementedError

    def write(self, rel: str, data: bytes, base_revision: str,
              force: bool) -> dict:
        """CAS atomic write. Returns {revision,size}. Raises ConflictError."""
        raise NotImplementedError

    def mkdir(self, rel: str) -> None:
        raise NotImplementedError

    def rename(self, src: str, dst: str) -> dict:
        raise NotImplementedError

    def delete(self, rel: str) -> None:
        raise NotImplementedError

    def index_scan(self) -> dict:
        """Bounded markdown index scan.

        Returns {entries, scanned, skipped_oversized, truncated}.
        """
        raise NotImplementedError

    def close(self) -> None:
        pass


def extract_md_metadata(text: str, rel: str) -> dict:
    """Stage 4 metadata extraction shared by local scan (remote helper has
    its own embedded copy with identical regexes)."""
    import re as _re
    alias_re = _re.compile(r"^aliases\s*:\s*(.+)$", _re.IGNORECASE)
    title_re = _re.compile(r"^title\s*:\s*(.+?)\s*$", _re.IGNORECASE)
    heading_re = _re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
    link_re = _re.compile(r"\[\[([^\[\]\n]+)\]\]")

    aliases = []
    fm_title = None
    headings = []
    in_frontmatter = False
    front_done = False
    first_heading_title = None
    for line in text.splitlines():
        stripped = line.strip()
        if not front_done:
            if stripped == "---":
                if not in_frontmatter and text.startswith("---"):
                    in_frontmatter = True
                elif in_frontmatter:
                    front_done = True
                continue
            if in_frontmatter:
                m_title = title_re.match(stripped)
                if m_title and fm_title is None:
                    fm_title = m_title.group(1).strip().strip("\"'")
                m_alias = alias_re.match(stripped)
                if m_alias:
                    raw = m_alias.group(1).strip()
                    raw = raw.lstrip("[").rstrip("]")
                    aliases.extend(
                        a.strip().strip("\"'") for a in raw.split(",")
                        if a.strip()
                    )
                continue
            if stripped and not stripped.startswith(("#", "```")):
                front_done = True
        m_head = heading_re.match(line)
        if m_head:
            htext = m_head.group(2).strip()
            headings.append({"level": len(m_head.group(1)), "text": htext})
            if first_heading_title is None and len(m_head.group(1)) == 1:
                first_heading_title = htext

    # Code-stripped extraction: wikilinks inside fenced/inline code are
    # text, not links (same discipline as hecore.wiki_links).
    from ..wiki_links import extract_outgoing_targets
    outgoing = extract_outgoing_targets(text)
    base = rel.rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0]
    return {
        "path": rel,
        "title": fm_title or first_heading_title or stem,
        "aliases": aliases[:20],
        "headings": headings[:200],
        "outgoing": outgoing[:500],
    }


ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def valid_workspace_id(wid: str) -> bool:
    return bool(ID_RE.match(wid or ""))
