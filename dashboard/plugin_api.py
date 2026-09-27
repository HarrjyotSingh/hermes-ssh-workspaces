"""Hermes Editor dashboard plugin - backend API routes.

Mounted at ``/api/plugins/hermes-editor/`` by the Hermes dashboard plugin
system (``hermes_cli/web_server.py:_mount_plugin_api_routes``).

Stage 5A scope: the filesystem layer is now *workspace based*. Every
``/fs/*`` call addresses a configured **workspace id** from the persistent
registry (see ``registry.py``); a workspace is either Pi-local
(``providers/local.py``) or SSH-backed on a remote host
(``providers/ssh_provider.py``). The frontend never knows or cares which.

Routes:

* ``GET    /health``                  - liveness/version probe
* ``GET    /workspaces``              - list configured workspaces (+health)
* ``POST   /workspaces``              - create/update a workspace config
* ``DELETE /workspaces/{wid}``        - remove a workspace config
* ``GET    /hosts``                   - list configured host ids (no secrets)
* ``GET    /workspaces/{wid}/health`` - availability + active endpoint
* ``GET    /fs/tree``                 - lazy directory listing
* ``GET    /fs/file``                 - read + revision + binary/oversized guard
* ``PUT    /fs/file``                 - CAS atomic write w/ conflict detection
* ``POST   /fs/move``                 - rename within a workspace
* ``POST   /fs/mkdir``, ``POST /fs/delete``
* ``POST   /fs/index``, ``GET/PUT /index/state``
* ``GET    /fs/revisions``            - bounded revision probe for OPEN files
                                        only (frontend polling fallback)
* ``GET    /sync/status``             - subscription/poller observability
* ``WS     /events``                  - Stage 5B synchronization event channel
                                        (plugin-scoped; metadata only)

Update-safety contract (unchanged since Stage 1): no NEW listening ports
(the WebSocket rides the existing dashboard uvicorn app under this
plugin's mounted prefix), no microphone/audio capture, no wake-word APIs,
and nothing touching /api/events, /api/ws or any Jarvis/audio channel.
Stdlib plus FastAPI only.

Security notes
--------------
* Paths arrive as *relative* paths under a CONFIGURED workspace root;
  absolute paths and traversal are rejected before any I/O. Arbitrary
  frontend-supplied absolute roots are never accepted (the legacy
  ``root=`` parameter maps onto configured local workspaces only).
* Symlink escapes rejected on both local and remote providers.
* Revisions are SHA-256 of raw bytes; writes are compare-and-swap with
  explicit-only force overwrite (409 otherwise).
* No SSH credentials, keys, users, or private config ever cross the API
  boundary to the browser.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

# plugin_api.py is loaded standalone (spec_from_file_location) by the
# dashboard, so the backend core is imported through an explicit path
# insert. "hecore" is unique enough to avoid sys.path collisions with
# other plugins.
_DASH_DIR = str(Path(__file__).resolve().parent)
if _DASH_DIR not in sys.path:
    sys.path.insert(0, _DASH_DIR)

from hecore.registry import (  # noqa: E402
    LOCAL_WORKSPACE_ID,
    RegistryError,
    get_registry,
    provider_for,
    state_dir as registry_state_dir,
)
from hecore.providers.base import (  # noqa: E402
    INDEX_MAX_FILES,
    MAX_TEXT_BYTES,
    MAX_IMAGE_BYTES,
    ConflictError,
    OfflineError,
    ProviderError,
)
from hecore.sync import PROTOCOL_VERSION, get_sync_manager  # noqa: E402
from remote_mount import hermes_home_str, machines, mount_status, start_host_mount, start_mount, unmount_workspace  # noqa: E402


log = logging.getLogger(__name__)

PLUGIN_NAME = "hermes-editor"
PLUGIN_VERSION = "0.5.0"

router = APIRouter()


def _http(exc: ProviderError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


def _local_display_root(root: Optional[str]) -> str:
    """Runtime-resolved display path for a local workspace."""
    if root:
        return str(os.path.expanduser(root))
    try:
        from hermes_constants import get_hermes_home
        return str(get_hermes_home())
    except Exception:
        return str(Path.home() / ".hermes")


# ---------------------------------------------------------------------------
# Workspace selection helpers
# ---------------------------------------------------------------------------

def _select_workspace(workspace: Optional[str], root: Optional[str]) -> str:
    """Resolve query params to a configured workspace id.

    ``workspace`` wins; legacy ``root`` is mapped onto configured local
    workspaces only; anything else falls back to the default workspace.
    """
    reg = get_registry()
    if workspace:
        if not reg.get_workspace(workspace):
            raise HTTPException(status_code=404, detail=f"unknown workspace: {workspace}")
        ws = reg.get_workspace(workspace)
        if not ws["enabled"]:
            raise HTTPException(status_code=409, detail={
                "conflict": True, "reason": "workspace_disabled"})
        return workspace
    if root:
        wid = reg.resolve_legacy_root(root)
        if wid is None:
            raise HTTPException(
                status_code=400,
                detail="root does not match any configured workspace")
        return wid
    return reg.default_workspace_id()


def _provider(workspace: Optional[str] = None, root: Optional[str] = None):
    wid = _select_workspace(workspace, root)
    try:
        prov = provider_for(wid)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    except RegistryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return wid, prov


# Last-known workspace health, refreshed in the background. Listing all
# workspaces must never block on SSH probes (a cold or cooling endpoint
# costs up to 12s each, which starves every picker/tree in the desktop
# app); the explicit per-workspace /health endpoint stays live.
_HEALTH_CACHE: dict = {}
_HEALTH_INFLIGHT: set = set()
_HEALTH_LOCK = threading.Lock()


def _refresh_health_async(wid: str, provider_key: str) -> None:
    with _HEALTH_LOCK:
        if wid in _HEALTH_INFLIGHT:
            return
        _HEALTH_INFLIGHT.add(wid)

    def _run() -> None:
        try:
            prov = provider_for(wid)
            h = prov.health()
            health = {"online": bool(h.get("online")),
                      "endpoint": h.get("endpoint"),
                      "transport": h.get("transport", provider_key)}
        except Exception:
            health = {"online": False, "endpoint": None}
        with _HEALTH_LOCK:
            _HEALTH_CACHE[wid] = health
            _HEALTH_INFLIGHT.discard(wid)

    threading.Thread(target=_run, name=f"he-health-{wid}", daemon=True).start()


def _workspace_summary(wid: str) -> dict:
    """Workspace metadata + last-known health (never credentials).

    Health comes from the background cache; a cache miss reports offline
    and kicks a refresh, so the first call after startup is instant and
    the truth arrives a moment later."""
    reg = get_registry()
    ws = reg.get_workspace(wid)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    out = dict(ws)
    root_display = ws["root"]
    if ws["provider"] == "local":
        root_display = _local_display_root(ws["root"])
    out["root_display"] = root_display
    health = {"online": False, "endpoint": None}
    if ws["enabled"]:
        with _HEALTH_LOCK:
            cached = _HEALTH_CACHE.get(wid)
        if cached is not None:
            health = dict(cached)
        else:
            _refresh_health_async(wid, ws["provider"])
    out.update(health)
    # strip anything sensitive-looking before it reaches the browser
    for k in ("user",):
        out.pop(k, None)
    return out


@router.get("/health")
def health() -> dict:
    """Plugin liveness/version probe."""
    return {
        "ok": True,
        "plugin": PLUGIN_NAME,
        "version": PLUGIN_VERSION,
        "status": "active",
        "stage": 5,
        "time": int(time.time()),
    }


# ---------------------------------------------------------------------------
# Hosts + workspace registry CRUD
# ---------------------------------------------------------------------------

class WorkspaceBody(BaseModel):
    id: str
    label: Optional[str] = None
    provider: Optional[str] = None   # "local" | "ssh" (default inferred)
    host: Optional[str] = None
    root: Optional[str] = None       # absolute path on the HOST (config-side)
    enabled: bool = True
    index_markdown: bool = True


class HostBody(BaseModel):
    id: str
    user: str
    endpoints: list[str]


@router.get("/hosts")
def hosts() -> dict:
    """Configured host ids only - no users, keys, or endpoints exposed."""
    return {"hosts": sorted(get_registry().hosts().keys())}


@router.post("/hosts")
def upsert_host(body: HostBody) -> dict:
    try:
        saved = get_registry().upsert_host(body.id, body.model_dump(exclude={"id"}))
    except RegistryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log.info("hermes-editor: host %s upserted", saved["id"])
    # Never return the SSH user or endpoint addresses to the Desktop client.
    return {"ok": True, "host": saved["id"]}


@router.get("/workspaces")
def workspaces(include_disabled: bool = False) -> dict:
    ids = [w["id"] for w in get_registry().list_workspaces(
        include_disabled=True)]
    out = []
    for wid in ids:
        ws = get_registry().get_workspace(wid)
        if not include_disabled and not ws["enabled"]:
            continue
        try:
            out.append(_workspace_summary(wid))
        except HTTPException:
            continue
    return {"workspaces": out}


@router.post("/workspaces")
def upsert_workspace(body: WorkspaceBody) -> dict:
    try:
        saved = get_registry().upsert_workspace(body.id, body.model_dump(
            exclude={"id"}, exclude_none=True))
    except RegistryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log.info("hermes-editor: workspace %s upserted", saved["id"])
    return {"ok": True, "workspace": saved}


@router.delete("/workspaces/{wid}")
def delete_workspace(wid: str) -> dict:
    try:
        get_registry().remove_workspace(wid)
    except RegistryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    return {"ok": True}


@router.get("/workspaces/{wid}/health")
def workspace_health(wid: str) -> dict:
    reg = get_registry()
    ws = reg.get_workspace(wid)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    if not ws["enabled"]:
        return {"workspace": wid, "enabled": False,
                "online": False, "endpoint": None}
    try:
        prov = provider_for(wid)
        h = prov.health()
    except OfflineError as exc:
        return {"workspace": wid, "online": False, "endpoint": None,
                "host": exc.host_id, "offline": True}
    except ProviderError as exc:
        raise _http(exc)
    return {"workspace": wid, **h}


# ---------------------------------------------------------------------------
# Legacy roots listing (Stage 3 shape, now derived from local workspaces)
# ---------------------------------------------------------------------------

@router.post("/workspaces/{wid}/mount")
def ws_mount(wid: str) -> dict:
    """Mount an SSH workspace's root at the backend anchor folder.

    <hermes-home>/remote-workspaces/<wid> becomes a live view of the remote
    machine's files, so the Hermes agent's file tools, chats anchored to this
    workspace, and the native project folder picker all reach remote files
    through ordinary backend paths.
    """
    reg = get_registry()
    ws = reg.get_workspace(wid)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    if ws["provider"] != "ssh":
        raise HTTPException(status_code=400, detail="only ssh workspaces mount")
    try:
        result = start_mount(wid, ws, reg.hosts())
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=f"mount failed: {exc}")
    return {"ok": True, "workspace": wid, **result}


@router.get("/workspaces/{wid}/mount")
def ws_mount_status(wid: str) -> dict:
    reg = get_registry()
    ws = reg.get_workspace(wid)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    return {"workspace": wid, **mount_status(wid)}


@router.delete("/workspaces/{wid}/mount")
def ws_unmount(wid: str) -> dict:
    reg = get_registry()
    ws = reg.get_workspace(wid)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"unknown workspace: {wid}")
    try:
        result = unmount_workspace(wid)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=f"unmount failed: {exc}")
    return {"ok": True, "workspace": wid, **result}


@router.get("/machines")
def machines_list() -> dict:
    """All registered SSH machines (id + login user) and the backend hermes
    home, for machine-centric folder browsing."""
    try:
        return {"ok": True, "machines": machines(), "hermes_home": hermes_home_str()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/hosts/{host}/mount")
def host_mount_status_route(host: str) -> dict:
    reg = get_registry()
    if host not in reg.hosts():
        raise HTTPException(status_code=404, detail=f"unknown host: {host}")
    return {"host": host, **mount_status(host)}


@router.post("/hosts/{host}/mount")
def host_mount(host: str) -> dict:
    """Mount a machine's FULL filesystem (root /) at
    ~/.hermes/remote-workspaces/<host> - any directory on the machine becomes
    reachable for projects and the agent. Idempotent."""
    reg = get_registry()
    hosts = reg.hosts()
    if host not in hosts:
        raise HTTPException(status_code=404, detail=f"unknown host: {host}")
    try:
        result = start_host_mount(host, hosts)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"mount failed: {exc}")
    return {"ok": True, "host": host, **result}


@router.get("/fs/roots")
def fs_roots() -> dict:
    out = []
    for w in get_registry().list_workspaces():
        if w["provider"] != "local":
            continue
        p = _local_display_root(w["root"])
        ok = os.path.isdir(p)
        out.append({"path": p, "label": w["label"], "exists": ok,
                    "workspace": w["id"]})
    return {"roots": out}


# ---------------------------------------------------------------------------
# File operations (workspace-addressed)
# ---------------------------------------------------------------------------

@router.get("/fs/tree")
def fs_tree(
    path: str = Query("", description="Relative directory path; empty = root"),
    workspace: Optional[str] = Query(None),
    root: Optional[str] = Query(None, description="legacy: local workspace root"),
) -> dict:
    wid, prov = _provider(workspace, root)
    try:
        entries = prov.list_dir(path)
    except ProviderError as exc:
        raise _http(exc)
    return {
        "workspace": wid,
        "path": path.lstrip("/"),
        "entries": entries,
        "skipped": sorted([
            ".git", ".hg", ".svn", "node_modules", "__pycache__",
            "venv", ".venv", ".tox", ".mypy_cache", ".ruff_cache",
            ".pytest_cache", ".idea", ".vscode"]),
    }


@router.get("/fs/file")
def fs_file_read(
    path: str = Query(..., description="Relative file path"),
    workspace: Optional[str] = Query(None),
    root: Optional[str] = Query(None),
) -> dict:
    wid, prov = _provider(workspace, root)
    try:
        f = prov.read(path)
    except ProviderError as exc:
        raise _http(exc)
    f["path"] = path
    f["workspace"] = wid
    return f


_IMAGE_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".bmp": "image/bmp", ".svg": "image/svg+xml",
}


@router.get("/fs/image")
def fs_image_read(
    path: str = Query(..., description="Workspace-relative image path"),
    workspace: Optional[str] = Query(None),
) -> dict:
    """Serve bounded workspace images as data URLs to the Desktop plugin."""
    kind = _IMAGE_TYPES.get(Path(path).suffix.lower())
    if not kind:
        raise HTTPException(status_code=415, detail="unsupported image type")
    wid, prov = _provider(workspace)
    try:
        data = prov.read_image(path)
    except ProviderError as exc:
        raise _http(exc)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image is too large")
    return {"workspace": wid, "path": path,
            "data_url": f"data:{kind};base64,{base64.b64encode(data).decode('ascii')}"}


class FileWriteBody(BaseModel):
    path: str
    content: str
    # SHA-256 the client last saw; "" means "I believe this is a new file".
    base_revision: str = ""
    # Explicit override for the conflict dialog's "overwrite anyway".
    force: bool = False


@router.put("/fs/file")
def fs_file_write(body: FileWriteBody,
                  workspace: Optional[str] = Query(None),
                  root: Optional[str] = Query(None)) -> dict:
    """CAS write through the provider; conflicts return 409 with detail."""
    wid, prov = _provider(workspace, root)
    data = body.content.encode("utf-8")

    # created-vs-modified classification for the sync event (cheap stat;
    # a 404 simply means the CAS write is creating the file)
    existed_before = True
    try:
        prov.stat(body.path)
    except ProviderError as exc:
        existed_before = exc.status_code != 404
    except Exception:
        pass

    try:
        r = prov.write(body.path, data, body.base_revision, body.force)
    except ConflictError as exc:
        raise _http(exc)
    except OfflineError as exc:
        # offline workspaces never fall back to a local copy
        raise _http(exc)
    except ProviderError as exc:
        raise _http(exc)
    log.info("hermes-editor: wrote %s/%s (%d bytes)", wid, body.path, len(data))
    # Stage 5B: notify live subscribers + patch only this index entry
    _notify_change(wid, prov, body.path,
                   kind="file.created" if not existed_before else "file.modified",
                   revision=r["revision"], size=r["size"],
                   text=body.content if _is_indexable_md(body.path, len(data)) else None)
    return {
        "ok": True,
        "workspace": wid,
        "path": body.path,
        "revision": r["revision"],
        "size": r["size"],
    }


def _is_indexable_md(rel_path: str, size: int) -> bool:
    from hecore.providers.base import INDEX_MAX_FILE_BYTES
    return rel_path.lower().endswith(".md") and size <= INDEX_MAX_FILE_BYTES


def _notify_change(wid: str, prov, rel_path: str, kind: str,
                   revision: str = "", size=None, mtime_ns=None,
                   old_path: str = None, text: Optional[str] = None) -> None:
    """Best-effort sync event + incremental single-entry index update.

    Must never fail the originating filesystem operation.
    """
    try:
        get_sync_manager().notify_local_change(
            wid, rel_path, kind, revision=revision, size=size,
            mtime_ns=mtime_ns, old_path=old_path)
    except Exception:
        log.exception("hermes-editor: sync notify failed (%s/%s)", wid, rel_path)
    if not rel_path.lower().endswith(".md"):
        return
    try:
        ws_cfg = get_registry().get_workspace(wid)
        if ws_cfg is None or not ws_cfg.get("index_markdown", True):
            return
        from hecore import index_store
        stat_info = {"size": size, "mtime_ns": mtime_ns} \
            if size is not None or mtime_ns is not None else None
        if kind == "file.renamed" and old_path:
            # re-path the existing entry; content metadata stays valid
            index_store.apply_change(wid, prov, old_path,
                                     renamed_to=rel_path)
        elif kind == "file.deleted":
            index_store.apply_change(wid, prov, rel_path, deleted=True)
        else:
            index_store.apply_change(wid, prov, rel_path, text=text,
                                     stat_info=stat_info)
    except Exception:
        log.exception("hermes-editor: incremental index update failed (%s)", wid)


class MoveBody(BaseModel):
    # Stage-4 frontend sends {"from": ..., "to": ...}; tests use src/dst.
    src: str = Field("", alias="from")
    dst: str = Field("", alias="to")

    model_config = {"populate_by_name": True}


def _move_fields(body: MoveBody) -> tuple:
    return body.src, body.dst


@router.post("/fs/move")
def fs_move(body: MoveBody,
            workspace: Optional[str] = Query(None),
            root: Optional[str] = Query(None)) -> dict:
    src, dst = _move_fields(body)
    wid, prov = _provider(workspace, root)
    try:
        r = prov.rename(src, dst)
    except ProviderError as exc:
        raise _http(exc)
    log.info("hermes-editor: moved %s: %s -> %s", wid, r["from"], r["to"])
    # Rewrite inbound [[wikilinks]]/![[embeds]] BEFORE the index re-paths the
    # renamed entry: resolution must run against pre-rename titles/paths.
    # Best-effort - never fails the move itself.
    rewritten: list = []
    if r["from"].lower().endswith(".md"):
        try:
            rewritten = _rewrite_inbound_links(wid, prov, r["from"], r["to"])
        except Exception:
            log.exception("hermes-editor: inbound-link rewrite failed (%s)", wid)
    # Stage 5B: rename event + single-entry index re-path
    _notify_change(wid, prov, r["to"], kind="file.renamed",
                   old_path=r["from"])
    return {"ok": True, "workspace": wid, "from": r["from"], "to": r["to"],
            "rewritten": rewritten}


# Inbound-link rewrite budget per rename (low-memory host guard).
_REWRITE_MAX_FILES = 200


def _rewrite_inbound_links(wid: str, prov, old_path: str, new_path: str) -> list:
    """Follow-on rename rewrite: update every note whose outgoing targets
    resolve to ``old_path`` so links keep working after a rename.

    Bounded for low-memory hosts: only indexed referencers are read (max 200),
    writes go through provider CAS with the revision just read.
    """
    from hecore import index_store, wiki_links
    entries = index_store.load_entries(wid)
    if not entries:
        return []
    new_stem = new_path.rsplit("/", 1)[-1]
    if new_stem.lower().endswith(".md"):
        new_stem = new_stem[:-3]
    out = []
    for cand in wiki_links.inbound_referencers(entries, old_path)[:_REWRITE_MAX_FILES]:
        try:
            f = prov.read(cand)
        except Exception:
            continue
        if f.get("encoding") != "text":
            continue
        content = f.get("content") or ""
        new_content, changed, _touched = wiki_links.rewrite_links_for_rename(
            content, entries, old_path, new_stem)
        if not changed or new_content == content:
            continue
        data = new_content.encode("utf-8")
        try:
            prov.write(cand, data, f.get("revision") or "", False)
        except Exception as exc:
            log.warning("hermes-editor: link rewrite skipped %s: %s", cand, exc)
            continue
        _notify_change(wid, prov, cand, kind="file.modified",
                       text=new_content if _is_indexable_md(cand, len(data)) else None)
        out.append({"path": cand, "changes": changed})
        log.info("hermes-editor: rewrote %d link(s) in %s (%s rename)",
                 changed, cand, old_path)
    return out


class PathBody(BaseModel):
    path: str


@router.post("/fs/mkdir")
def fs_mkdir(body: PathBody,
             workspace: Optional[str] = Query(None)) -> dict:
    wid, prov = _provider(workspace, None)
    try:
        prov.mkdir(body.path)
    except ProviderError as exc:
        raise _http(exc)
    return {"ok": True, "workspace": wid, "path": body.path}


@router.post("/fs/delete")
def fs_delete(body: PathBody,
              workspace: Optional[str] = Query(None)) -> dict:
    wid, prov = _provider(workspace, None)
    try:
        prov.delete(body.path)
    except ProviderError as exc:
        raise _http(exc)
    _notify_change(wid, prov, body.path, kind="file.deleted")
    return {"ok": True, "workspace": wid, "path": body.path}


# ---------------------------------------------------------------------------
# Workspace markdown index (bounded, on-demand), persisted state
# ---------------------------------------------------------------------------

@router.post("/fs/index")
def fs_index(workspace: Optional[str] = Query(None),
             root: Optional[str] = Query(None)) -> dict:
    """Build the bounded workspace markdown index (on demand only)."""
    wid, prov = _provider(workspace, root)
    scan = None
    # Fast path: a mounted SSH workspace is walked through its local rclone
    # anchor (~/.hermes/remote-workspaces/<wid>) — instant, while the SSH
    # index op costs ~10s per directory and routinely times out on vaults.
    if type(prov).__name__ == "SshProvider":
        try:
            from hecore.providers.local import LocalProvider
            from remote_mount import anchor_for, is_mounted
            if is_mounted(wid):
                anchor = anchor_for(wid)
                if anchor.is_dir():
                    scan = LocalProvider(root=str(anchor)).index_scan()
        except Exception:
            log.exception("hermes-editor: mounted fast-path index failed (%s)", wid)
            scan = None
    if scan is None:
        try:
            scan = prov.index_scan()
        except ProviderError as exc:
            raise _http(exc)
    return {
        "ok": True,
        "workspace": wid,
        "entries": scan["entries"],
        "scanned": scan["scanned"],
        "skipped_oversized": scan["skipped_oversized"],
        "truncated": scan["truncated"],
    }


def _index_key(workspace: Optional[str], root: Optional[str]) -> tuple:
    wid = _select_workspace(workspace, root)
    return wid, hashlib.sha256(f"ws:{wid}".encode()).hexdigest()[:12]


@router.get("/index/state")
def index_state_get(workspace: Optional[str] = Query(None),
                    root: Optional[str] = Query(None)) -> dict:
    wid, key = _index_key(workspace, root)
    d = _index_state_dir()
    f = d / f"index-{key}.json"
    if not f.is_file():
        return {"ok": True, "workspace": wid, "entries": None}
    try:
        return {"ok": True, "workspace": wid,
                "entries": json.loads(f.read_text())}
    except (OSError, ValueError):
        return {"ok": True, "workspace": wid, "entries": None}


@router.put("/index/state")
def index_state_put(payload: dict,
                    workspace: Optional[str] = Query(None),
                    root: Optional[str] = Query(None)) -> dict:
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        raise HTTPException(status_code=400, detail="entries list required")
    if len(entries) > INDEX_MAX_FILES * 2:
        raise HTTPException(status_code=413, detail="index too large")
    wid, key = _index_key(workspace, root)
    f = _index_state_dir() / f"index-{key}.json"
    tmp = f.with_suffix(f".tmp-{os.getpid()}")
    try:
        tmp.write_text(json.dumps(entries), encoding="utf-8")
        os.replace(tmp, f)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"persist failed: {exc}")
    return {"ok": True, "workspace": wid}


def _index_state_dir():
    return registry_state_dir()


# ---------------------------------------------------------------------------
# Stage 5B: live synchronization
# ---------------------------------------------------------------------------

@router.get("/fs/revisions")
def fs_revisions(paths: str = Query(...,
                 description="Comma-separated relative paths (OPEN files only)"),
                 workspace: Optional[str] = Query(None)) -> dict:
    """Batched revision probe for the frontend's polling fallback.

    Deliberately bounded to 64 paths and metadata-only: the frontend is
    expected to send only its currently OPEN tabs, never workspace trees.
    """
    wid, prov = _provider(workspace, None)
    rels = [p.strip() for p in paths.split(",") if p.strip()][:64]
    if not rels:
        raise HTTPException(status_code=400, detail="no paths requested")
    try:
        stats = prov.stat_many(rels, with_revision=True)
    except ProviderError as exc:
        raise _http(exc)
    return {"workspace": wid, "stats": stats}


@router.get("/sync/status")
def sync_status() -> dict:
    """Subscription/poller observability. No credentials, no secrets."""
    try:
        return get_sync_manager().status()
    except Exception:
        return {"protocol": PROTOCOL_VERSION, "clients": 0,
                "subscriptions": 0, "workspaces": {}, "polling_active": False}


def _ws_authorized(ws: WebSocket) -> bool:
    """Same credential policy as the dashboard's own WS endpoints.

    Unauthenticated deployments (loopback dev, TestClient) pass through;
    when the host app has auth engaged we defer to its validator and fail
    CLOSED if it cannot be consulted.
    """
    state = getattr(ws.app, "state", None)
    if not bool(getattr(state, "auth_required", False)):
        return True
    try:
        from hermes_cli.web_server import _ws_auth_ok
        return bool(_ws_auth_ok(ws))
    except Exception:
        log.warning("hermes-editor: ws auth validator unavailable; rejecting")
        return False


@router.websocket("/events")
async def sync_events(ws: WebSocket):
    """Plugin-scoped synchronization channel: /api/plugins/hermes-editor/events.

    Client -> server messages (JSON):
      {"type":"hello","client_id":"..."}          optional id (else generated)
      {"type":"subscribe","workspace":W,"path":P,"revision":R}
      {"type":"unsubscribe","workspace":W,"path":P}
      {"type":"ping"}

    Server -> client messages carry ``v`` (protocol version), ``type`` and
    minimal metadata. Full file contents are NEVER transmitted here.

    Concurrency note: events flow from the threading-domain sync manager
    into this coroutine through its bounded queue.Queue, drained here via
    anyio (the concurrency layer Starlette itself runs on). No extra
    threads, no sockets, no new listeners.
    """
    import queue as _queue

    try:
        import anyio
    except ImportError:  # pragma: no cover - starlette always ships anyio
        await ws.close(code=1011)
        return

    if not _ws_authorized(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    sync = get_sync_manager()
    client_id = f"he-{os.getpid()}-{int(time.time()*1000)}-{id(ws):x}"
    client = sync.register_client(client_id)

    async def _sender():
        while True:
            try:
                ev = client.queue.get_nowait()
            except _queue.Empty:
                await anyio.sleep(0.05)
                continue
            if ev is None:          # sentinel: connection closing
                break
            try:
                await ws.send_json(ev)
            except Exception:
                break

    async with anyio.create_task_group() as tg:
        tg.start_soon(_sender)
        try:
            await ws.send_json({"v": PROTOCOL_VERSION, "type": "hello",
                                "protocol": PROTOCOL_VERSION})
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                mtype = msg.get("type", "")
                if mtype == "hello":
                    cid = msg.get("client_id")
                    if isinstance(cid, str) and cid and cid != client_id \
                            and len(cid) <= 80:
                        # adopt a stable client-supplied id (one-time)
                        sync.unregister_client(client_id)
                        client_id = cid
                        client = sync.register_client(client_id)
                    await ws.send_json({"v": PROTOCOL_VERSION,
                                        "type": "hello",
                                        "protocol": PROTOCOL_VERSION})
                elif mtype == "subscribe":
                    ok = sync.subscribe(
                        client_id, str(msg.get("workspace", "")),
                        str(msg.get("path", "")),
                        str(msg.get("revision", "")))
                    await ws.send_json({
                        "v": PROTOCOL_VERSION, "type": "subscribed",
                        "ok": bool(ok),
                        "workspace": msg.get("workspace"),
                        "path": msg.get("path"),
                    })
                elif mtype == "unsubscribe":
                    sync.unsubscribe(client_id,
                                     str(msg.get("workspace", "")),
                                     str(msg.get("path", "")))
                elif mtype == "ping":
                    await ws.send_json({"v": PROTOCOL_VERSION,
                                        "type": "pong"})
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            log.exception("hermes-editor: events websocket error")
        finally:
            sync.unregister_client(client_id)
            # end the sender loop; the bounded queue absorbs the sentinel
            try:
                client.queue.put_nowait(None)
            except _queue.Full:
                pass
