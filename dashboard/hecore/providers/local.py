"""Local-filesystem workspace provider (Stage 2/3/4 behaviour preserved)."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Optional

from .base import (
    INDEX_MAX_FILES,
    INDEX_MAX_FILE_BYTES,
    MAX_TEXT_BYTES,
    MAX_IMAGE_BYTES,
    SKIPPED_DIR_NAMES,
    TEMP_PREFIX,
    ConflictError,
    ProviderError,
    WorkspaceProvider,
    extract_md_metadata,
    file_revision,
    is_binary,
    validate_rel_path,
)


class LocalProvider(WorkspaceProvider):
    kind = "local"

    def __init__(self, root: Optional[str] = None):
        # root=None -> active Hermes home (Stage 3 default workspace).
        if root is None:
            try:
                from hermes_constants import get_hermes_home
                root = str(get_hermes_home())
            except Exception:
                root = str(Path.home() / ".hermes")
        super().__init__(root)
        self._root: Optional[Path] = None

    # -- path resolution ---------------------------------------------------

    def _resolved_root(self) -> Path:
        if self._root is None:
            p = Path(self.root).expanduser()
            try:
                resolved = p.resolve(strict=True)
            except (OSError, RuntimeError):
                raise ProviderError(404, f"workspace root not found: {self.root}")
            if not resolved.is_dir():
                raise ProviderError(404, f"workspace root not found: {self.root}")
            self._root = resolved
        return self._root

    def _resolve(self, rel: str) -> Path:
        rel = validate_rel_path(rel)
        resolved_root = self._resolved_root()
        candidate = (resolved_root / rel).resolve() if rel else resolved_root
        try:
            candidate.relative_to(resolved_root)
        except ValueError:
            raise ProviderError(400, "path escapes workspace root")
        return candidate

    # -- availability ------------------------------------------------------

    def health(self) -> dict:
        try:
            ok = self._resolved_root().is_dir()
        except ProviderError:
            ok = False
        return {"online": ok, "endpoint": "local", "transport": "local"}

    @property
    def active_endpoint(self) -> Optional[str]:
        return "local"

    # -- operations ---------------------------------------------------------

    def stat(self, rel: str) -> dict:
        p = self._resolve(rel)
        if not p.exists():
            raise ProviderError(404, "not found")
        st = p.stat()
        return {
            "path": rel,
            "type": "dir" if p.is_dir() else ("file" if p.is_file() else "other"),
            "size": st.st_size,
            "mtime_ns": st.st_mtime_ns,
        }

    def stat_many(self, rels: list, with_revision: bool = False) -> list:
        resolved_root = self._resolved_root()
        out = []
        for rel in rels:
            try:
                validated = validate_rel_path(rel)
                candidate = (resolved_root / validated).resolve() \
                    if validated else resolved_root
                candidate.relative_to(resolved_root)
            except Exception:
                out.append({"path": rel, "exists": False})
                continue
            try:
                if candidate.is_file():
                    st = candidate.stat()
                    entry = {"path": rel, "exists": True,
                             "size": st.st_size,
                             "mtime_ns": st.st_mtime_ns}
                    if with_revision and st.st_size <= MAX_TEXT_BYTES:
                        try:
                            data = candidate.read_bytes()
                            if not is_binary(data):
                                try:
                                    data.decode("utf-8")
                                    entry["revision"] = file_revision(data)
                                except UnicodeDecodeError:
                                    pass
                        except OSError:
                            pass
                    out.append(entry)
                else:
                    out.append({"path": rel, "exists": False})
            except OSError:
                out.append({"path": rel, "exists": False})
        return out

    def list_dir(self, rel: str) -> list:
        d = self._resolve(rel)
        if not d.exists():
            raise ProviderError(404, "directory not found")
        if not d.is_dir():
            raise ProviderError(400, "not a directory")
        try:
            children = sorted(d.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))
        except OSError as exc:
            raise ProviderError(500, f"list failed: {exc}")

        resolved_root = self._resolved_root()
        rel_base = d.relative_to(resolved_root)
        entries = []
        for child in children:
            name = child.name
            if child.is_dir():
                if name in SKIPPED_DIR_NAMES and not name.startswith("."):
                    continue
                child_rel = str(rel_base / name) if str(rel_base) != "." else name
                entries.append({"name": name, "type": "dir", "path": child_rel})
            else:
                child_rel = str(rel_base / name) if str(rel_base) != "." else name
                try:
                    size = child.stat().st_size
                except OSError:
                    size = None
                entries.append({"name": name, "type": "file", "path": child_rel, "size": size})
        return entries

    def read(self, rel: str) -> dict:
        p = self._resolve(rel)
        if not p.exists():
            raise ProviderError(404, "file not found")
        if not p.is_file():
            raise ProviderError(400, "not a regular file")
        try:
            data = p.read_bytes()
        except OSError as exc:
            raise ProviderError(500, f"read failed: {exc}")
        st = p.stat()
        encoding = "text"
        content = None
        if len(data) > MAX_TEXT_BYTES:
            encoding = "oversized"
        elif is_binary(data):
            encoding = "binary"
        else:
            try:
                content = data.decode("utf-8")
            except UnicodeDecodeError:
                encoding = "binary"
        return {
            "size": len(data),
            "mtime_ns": st.st_mtime_ns,
            "revision": file_revision(data),
            "encoding": encoding,
            "content": content,
            "max_text_bytes": MAX_TEXT_BYTES,
        }

    def read_image(self, rel: str) -> bytes:
        p = self._resolve(validate_rel_path(rel))
        if not p.exists():
            raise ProviderError(404, "image not found")
        if not p.is_file():
            raise ProviderError(400, "not a regular file")
        try:
            with p.open("rb") as fh:
                data = fh.read(MAX_IMAGE_BYTES + 1)
        except OSError as exc:
            raise ProviderError(500, f"image read failed: {exc}")
        if len(data) > MAX_IMAGE_BYTES:
            raise ProviderError(413, "image is too large")
        return data

    def write(self, rel: str, data: bytes, base_revision: str,
              force: bool) -> dict:
        rel = validate_rel_path(rel)
        if not rel:
            raise ProviderError(400, "invalid path")
        p = self._resolve(rel)

        current_bytes = None
        exists = p.exists()
        if exists:
            if not p.is_file():
                raise ProviderError(400, "target is not a regular file")
            current_bytes = p.read_bytes()

        if not force:
            current_rev = file_revision(current_bytes) if current_bytes is not None else ""
            if exists and current_rev != base_revision:
                raise ConflictError(
                    "modified_on_disk" if base_revision else "already_exists",
                    base_revision, current_rev)
            if not exists and base_revision:
                raise ConflictError("deleted_on_disk", base_revision, "")

        tmp = None
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.parent / f"{TEMP_PREFIX}{os.getpid()}-{int(time.time()*1000)}-{p.name}"
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, p)
            tmp = None
        except OSError as exc:
            if tmp is not None:
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass
            raise ProviderError(500, f"write failed: {exc}")
        return {"revision": file_revision(data), "size": len(data)}

    def mkdir(self, rel: str) -> None:
        rel = validate_rel_path(rel)
        if not rel:
            raise ProviderError(400, "invalid directory")
        p = self._resolve(rel)
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ProviderError(500, f"mkdir failed: {exc}")

    def rename(self, src: str, dst: str) -> dict:
        src_rel = validate_rel_path(src)
        sp = self._resolve(src_rel)
        if not sp.is_file() and not sp.is_dir():
            raise ProviderError(404, "source not found")
        dst_rel = validate_rel_path(dst)
        if not dst_rel or dst_rel == src_rel:
            raise ProviderError(400, "destination must differ from source")
        dp = self._resolve(dst_rel)
        if dp.exists():
            raise ProviderError(409, {"conflict": True, "reason": "already_exists"})
        try:
            dp.parent.mkdir(parents=True, exist_ok=True)
            sp.rename(dp)
        except OSError as exc:
            raise ProviderError(500, f"move failed: {exc}")
        return {"from": src_rel, "to": dst_rel}

    def delete(self, rel: str) -> None:
        p = self._resolve(rel)
        if not p.exists():
            raise ProviderError(404, "not found")
        try:
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
        except OSError as exc:
            raise ProviderError(500, f"delete failed: {exc}")

    def index_scan(self) -> dict:
        resolved_root = self._resolved_root()
        entries = []
        scanned = 0
        skipped_oversized = 0
        truncated = False
        stack = [resolved_root]
        while stack and len(entries) < INDEX_MAX_FILES:
            current = stack.pop()
            try:
                children = sorted(current.iterdir(), key=lambda c: c.name.lower())
            except OSError:
                continue
            for child in children:
                if len(entries) >= INDEX_MAX_FILES:
                    truncated = True
                    break
                name = child.name
                try:
                    if child.is_symlink():
                        continue  # never follow links out of the workspace
                    is_dir = child.is_dir()
                    st = child.stat()
                except OSError:
                    continue
                if is_dir:
                    if name not in SKIPPED_DIR_NAMES and not name.startswith("."):
                        stack.append(child)
                    continue
                if not name.lower().endswith(".md"):
                    continue
                scanned += 1
                try:
                    if st.st_size > INDEX_MAX_FILE_BYTES:
                        skipped_oversized += 1
                        continue
                    text = child.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                rel = child.relative_to(resolved_root).as_posix()
                meta = extract_md_metadata(text, rel)
                meta["mtime_ns"] = st.st_mtime_ns
                meta["size"] = st.st_size
                entries.append(meta)

        entries.sort(key=lambda e: e["path"])
        return {
            "entries": entries,
            "scanned": scanned,
            "skipped_oversized": skipped_oversized,
            "truncated": truncated or scanned > len(entries),
        }
