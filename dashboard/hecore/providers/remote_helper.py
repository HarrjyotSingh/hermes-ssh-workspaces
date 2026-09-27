"""Remote helper executed on workspace hosts over SSH (Stage 5A).

The hermes-editor backend pipes this script to each configured host once
(cached at ``/tmp/hermes-editor-helper-<hash>.py``) and then talks to it
with one SSH invocation per operation:

    ssh <opts> user@host python3 /tmp/hermes-editor-helper-<hash>.py  \
        < request.json > response.json

All filenames/paths travel *inside* the JSON document - nothing is ever
interpolated into a shell command, so spaces and unusual characters are
safe by construction.

This is a short-lived cached file, NOT an installed service: hosts stay
unmodified apart from a temp file under their own /tmp.

Ops: ping, stat, list, read, write (CAS atomic), mkdir, rename, delete,
index (bounded markdown scan). Response is always one JSON object:

    {"ok": true, ...}
    {"ok": false, "error": {"status": int, "detail": ...}}

The write op performs full compare-and-swap remotely (current revision
validated, then temp file -> fsync -> atomic os.replace), so a write can
never land on an unexpectedly changed file even after endpoint failover.
Temp files use the identifiable ``.hermes-editor-tmp-*`` prefix and are
removed on failure; Syncthing ignore rules are never touched by us.
"""

from __future__ import annotations

HELPER_SOURCE = r'''
import hashlib, json, os, re, sys, time

TEMP_PREFIX = ".hermes-editor-tmp-"
BINARY_SNIFF = 8192
SKIPPED_DIRS = {".git",".hg",".svn","node_modules","__pycache__","venv",
                ".venv",".tox",".mypy_cache",".ruff_cache",".pytest_cache",
                ".idea",".vscode"}
INDEX_MAX_FILES = 5000
INDEX_MAX_FILE_BYTES = 512000


def fail(status, detail):
    return {"ok": False, "error": {"status": status, "detail": detail}}


def validate_rel(rel):
    if not isinstance(rel, str):
        raise ValueError("path must be a string")
    rel = rel.strip().replace("\\", "/")
    if rel.startswith("/"):
        raise ValueError("absolute paths are not allowed")
    if "\x00" in rel:
        raise ValueError("invalid path")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError("path escapes workspace root")
    return "/".join(parts)


def resolve(req, key="path", need=True):
    rel = req.get(key, "")
    if need and not isinstance(rel, str):
        raise ValueError("path must be a string")
    # an empty rel refers to the workspace root itself
    return os.path.join(req["root"], validate_rel(rel)) if rel else req["root"]


def contained(root_real, cand):
    cand_real = os.path.realpath(cand)
    if cand_real != root_real and not cand_real.startswith(root_real + os.sep):
        raise PermissionError("path escapes workspace root")
    return cand_real


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 16)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def op_ping(req, root_real):
    return {"ok": True, "root": req["root"], "hostname": os.uname().nodename,
            "root_exists": os.path.isdir(req["root"]),
            "python": "%d.%d" % sys.version_info[:2]}


def op_stat(req, root_real):
    p = resolve(req)
    contained(root_real, p)
    if not os.path.exists(p):
        return fail(404, "not found")
    st = os.stat(p)
    kind = "dir" if os.path.isdir(p) else ("file" if os.path.isfile(p) else "other")
    return {"ok": True, "path": req["path"], "type": kind,
            "size": st.st_size, "mtime_ns": st.st_mtime_ns}


def op_stat_many(req, root_real):
    """Batched stat for sync polling - bounded, no recursion.

    ``with_revision`` adds a SHA-256 for text-sized files (used by the
    bounded revision-resync paths, never by the regular poll cycle).
    """
    paths = req.get("paths")
    if not isinstance(paths, list):
        return fail(400, "paths list required")
    want_rev = bool(req.get("with_revision"))
    stats = []
    for rel in paths[:128]:
        entry = {"path": rel, "exists": False}
        try:
            vrel = validate_rel(rel)
            p = os.path.join(req["root"], vrel) if vrel else req["root"]
            contained(root_real, p)
            if os.path.isfile(p):
                st = os.stat(p)
                entry = {"path": rel, "exists": True,
                         "size": st.st_size, "mtime_ns": st.st_mtime_ns}
                if want_rev and st.st_size <= 2000000:
                    try:
                        with open(p, "rb") as fh:
                            data = fh.read()
                        if b"\x00" not in data[:8192]:
                            try:
                                data.decode("utf-8")
                                entry["revision"] = hashlib.sha256(data).hexdigest()
                            except UnicodeDecodeError:
                                pass
                    except OSError:
                        pass
        except (ValueError, PermissionError):
            entry = {"path": rel, "exists": False}
        except OSError:
            entry = {"path": rel, "exists": False}
        stats.append(entry)
    return {"ok": True, "stats": stats}


def op_list(req, root_real):
    d = resolve(req)
    contained(root_real, d)
    if not os.path.isdir(d):
        return fail(404 if not os.path.exists(d) else 400, "not a directory")
    entries = []
    try:
        names = sorted(os.listdir(d), key=lambda n: n.lower())
    except OSError as exc:
        return fail(500, "list failed: %s" % exc)
    base_rel = validate_rel(req.get("path", ""))
    for name in names:
        cp = os.path.join(d, name)
        crel = (base_rel + "/" + name) if base_rel else name
        try:
            if os.path.islink(cp) or os.path.isdir(cp):
                # list symlinked dirs by name but mark them; never auto-descend
                if os.path.isdir(cp) and not os.path.islink(cp):
                    if name in SKIPPED_DIRS and not name.startswith("."):
                        continue
                    entries.append({"name": name, "type": "dir", "path": crel})
                    continue
                if os.path.islink(cp):
                    entries.append({"name": name, "type": "symlink", "path": crel})
                    continue
                if name in SKIPPED_DIRS and not name.startswith("."):
                    continue
                entries.append({"name": name, "type": "dir", "path": crel})
            else:
                try:
                    size = os.stat(cp).st_size
                except OSError:
                    size = None
                entries.append({"name": name, "type": "file", "path": crel,
                                "size": size})
        except OSError:
            continue
    return {"ok": True, "entries": entries}


def op_read(req, root_real):
    p = resolve(req)
    contained(root_real, p)
    if not os.path.exists(p):
        return fail(404, "file not found")
    if not os.path.isfile(p):
        return fail(400, "not a regular file")
    st = os.stat(p)
    max_bytes = int(req.get("max_bytes", 2000000))
    if st.st_size > max_bytes:
        return {"ok": True, "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                "encoding": "oversized", "content": None,
                "max_text_bytes": max_bytes}
    with open(p, "rb") as fh:
        data = fh.read()
    enc = "text"
    content = None
    if b"\x00" in data[:BINARY_SNIFF]:
        enc = "binary"
    else:
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            enc = "binary"
    return {"ok": True, "size": len(data), "mtime_ns": st.st_mtime_ns,
            "revision": hashlib.sha256(data).hexdigest(), "encoding": enc,
            "content": content, "max_text_bytes": max_bytes}


def op_read_image(req, root_real):
    import base64
    p = resolve(req)
    contained(root_real, p)
    if not os.path.exists(p):
        return fail(404, "image not found")
    if not os.path.isfile(p):
        return fail(400, "not a regular file")
    max_bytes = min(int(req.get("max_bytes", 8000000)), 8000000)
    with open(p, "rb") as fh:
        data = fh.read(max_bytes + 1)
    if len(data) > max_bytes:
        return fail(413, "image is too large")
    return {"ok": True, "content_b64": base64.b64encode(data).decode("ascii")}


def op_write(req, root_real):
    import base64
    rel = validate_rel(req.get("path", ""))
    if not rel:
        return fail(400, "invalid path")
    p = os.path.join(req["root"], rel)
    contained(root_real, p)
    data = base64.b64decode(req.get("content_b64") or "")
    base_rev = req.get("base_revision", "")
    force = bool(req.get("force"))

    exists = os.path.isfile(p)
    current = sha256_file(p) if exists else ""
    if not force:
        cur = current if exists else ""
        if exists and cur != base_rev:
            return {"ok": False, "error": {"status": 409, "detail": {
                "conflict": True,
                "reason": "modified_on_disk" if base_rev else "already_exists",
                "base_revision": base_rev, "current_revision": cur}}}
        if not exists and base_rev:
            return {"ok": False, "error": {"status": 409, "detail": {
                "conflict": True, "reason": "deleted_on_disk",
                "base_revision": base_rev, "current_revision": ""}}}

    parent = os.path.dirname(p)
    tmp = None
    try:
        os.makedirs(parent, exist_ok=True)
        tmp = os.path.join(
            parent, "%s%d-%d-%s" % (TEMP_PREFIX, os.getpid(),
                                    int(time.time() * 1000),
                                    os.path.basename(p)))
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
        try:
            dfd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
        tmp = None
    except OSError as exc:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return fail(500, "write failed: %s" % exc)
    return {"ok": True, "revision": hashlib.sha256(data).hexdigest(),
            "size": len(data)}


def op_mkdir(req, root_real):
    rel = validate_rel(req.get("path", ""))
    p = os.path.join(req["root"], rel) if rel else req["root"]
    if rel:
        contained(root_real, p)
    try:
        os.makedirs(p, exist_ok=True)
    except OSError as exc:
        return fail(500, "mkdir failed: %s" % exc)
    return {"ok": True}


def op_rename(req, root_real):
    src = resolve(req, "src")
    dst_rel = validate_rel(req.get("dst", ""))
    src_rel = validate_rel(req.get("src", ""))
    if not dst_rel or dst_rel == src_rel:
        return fail(400, "destination must differ from source")
    dst = os.path.join(req["root"], dst_rel)
    contained(root_real, src)
    contained(root_real, dst)
    if not os.path.exists(src):
        return fail(404, "source not found")
    if os.path.exists(dst):
        return {"ok": False, "error": {"status": 409, "detail": {
            "conflict": True, "reason": "already_exists"}}}
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
    except OSError as exc:
        return fail(500, "move failed: %s" % exc)
    return {"ok": True, "from": src_rel, "to": dst_rel}


def op_delete(req, root_real):
    p = resolve(req)
    contained(root_real, p)
    if not os.path.exists(p):
        return fail(404, "not found")
    import shutil
    try:
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)
    except OSError as exc:
        return fail(500, "delete failed: %s" % exc)
    return {"ok": True}


ALIAS_RE = re.compile(r"^aliases\s*:\s*(.+)$", re.IGNORECASE)
TITLE_RE = re.compile(r"^title\s*:\s*(.+?)\s*$", re.IGNORECASE)
HEAD_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
LINK_RE = re.compile(r"\[\[([^\[\]\n]+)\]\]")


def _strip_code(text):
    """Blank fenced/inline code before link scanning (self-contained copy of
    hecore.wiki_links.strip_code_content - keep the two in sync)."""
    if "`" not in text and "~" not in text:
        return text
    lines = text.split("\n")
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


def extract_meta(text, rel):
    aliases, fm_title, headings = [], None, []
    in_fm = front_done = False
    first_h1 = None
    for line in text.splitlines():
        stripped = line.strip()
        if not front_done:
            if stripped == "---":
                if not in_fm and text.startswith("---"):
                    in_fm = True
                elif in_fm:
                    front_done = True
                continue
            if in_fm:
                m = TITLE_RE.match(stripped)
                if m and fm_title is None:
                    fm_title = m.group(1).strip().strip("\"'")
                m = ALIAS_RE.match(stripped)
                if m:
                    raw = m.group(1).strip().lstrip("[").rstrip("]")
                    aliases.extend(a.strip().strip("\"'")
                                   for a in raw.split(",") if a.strip())
                continue
            if stripped and not stripped.startswith(("#", "```")):
                front_done = True
        m = HEAD_RE.match(line)
        if m:
            htext = m.group(2).strip()
            headings.append({"level": len(m.group(1)), "text": htext})
            if first_h1 is None and len(m.group(1)) == 1:
                first_h1 = htext
    stripped_text = _strip_code(text)
    outgoing = sorted({m.group(1).split("|")[0].split("#")[0].strip()
                       for m in LINK_RE.finditer(stripped_text)
                       if m.group(1).split("|")[0].split("#")[0].strip()})
    stem = rel.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return {"path": rel, "title": fm_title or first_h1 or stem,
            "aliases": aliases[:20], "headings": headings[:200],
            "outgoing": outgoing[:500]}


def op_index(req, root_real):
    entries, scanned, skipped, truncated = [], 0, 0, False
    stack = [root_real]
    while stack and len(entries) < INDEX_MAX_FILES:
        cur = stack.pop()
        try:
            names = sorted(os.listdir(cur), key=lambda n: n.lower())
        except OSError:
            continue
        for name in names:
            if len(entries) >= INDEX_MAX_FILES:
                truncated = True
                break
            cp = os.path.join(cur, name)
            try:
                if os.path.islink(cp):
                    continue
                if os.path.isdir(cp):
                    if name not in SKIPPED_DIRS and not name.startswith("."):
                        stack.append(cp)
                    continue
                st = os.stat(cp)
            except OSError:
                continue
            if not name.lower().endswith(".md"):
                continue
            scanned += 1
            if st.st_size > INDEX_MAX_FILE_BYTES:
                skipped += 1
                continue
            try:
                with open(cp, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            rel = os.path.relpath(cp, root_real).replace(os.sep, "/")
            meta = extract_meta(text, rel)
            meta["mtime_ns"] = st.st_mtime_ns
            meta["size"] = st.st_size
            entries.append(meta)
    entries.sort(key=lambda e: e["path"])
    return {"ok": True, "entries": entries, "scanned": scanned,
            "skipped_oversized": skipped,
            "truncated": truncated or scanned > len(entries)}


def main():
    OPS = {"ping": op_ping, "stat": op_stat, "stat_many": op_stat_many,
           "list": op_list,
           "read": op_read, "read_image": op_read_image,
           "write": op_write, "mkdir": op_mkdir,
           "rename": op_rename, "delete": op_delete, "index": op_index}
    try:
        req = json.loads(sys.stdin.read())
        op = req.get("op", "")
        fn = OPS.get(op)
        if fn is None:
            sys.stdout.write(json.dumps(fail(400, "unknown op")))
            return
        root = req.get("root", "")
        if not root or not root.startswith("/"):
            sys.stdout.write(json.dumps(fail(400, "missing absolute root")))
            return
        # mkdir may bootstrap a missing workspace root; ping must work on
        # any configured root to report availability. Everything else
        # requires the root to exist.
        if not os.path.isdir(root) and op not in ("mkdir", "ping"):
            sys.stdout.write(json.dumps(fail(404, "workspace root not found")))
            return
        root_real = os.path.realpath(root)
        out = fn(req, root_real)
    except ValueError as exc:
        out = fail(400, str(exc))
    except PermissionError as exc:
        out = fail(400, str(exc))
    except Exception as exc:  # never crash without a JSON answer
        out = fail(500, "helper error: %r" % (exc,))
    sys.stdout.write(json.dumps(out))


main()
'''


def helper_sha256() -> str:
    import hashlib
    return hashlib.sha256(HELPER_SOURCE.encode()).hexdigest()


def helper_remote_path() -> str:
    return f"/tmp/hermes-editor-helper-{helper_sha256()[:12]}.py"
