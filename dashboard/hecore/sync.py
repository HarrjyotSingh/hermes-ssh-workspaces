"""Live workspace synchronization manager for hermes-editor (Stage 5B).

Provider-aware change detection + event fan-out. Deliberately THREADING
only (no asyncio, no sockets): the WebSocket transport lives in
``plugin_api.py`` where it rides the dashboard process's existing uvicorn
event loop. This module only detects changes and hands events to
per-client bounded queues.

Design rules (Stage 5B contract):

* Change detection is separate from event delivery.
* For SSH providers there is NO remote inotify and NO recursive rescan.
  Polling stats ONLY actively subscribed (open) files - one batched
  ``stat_many`` operation per workspace per cycle, with a follow-up
  single-file read only when mtime/size actually changed.
* No connected clients -> no remote I/O at all. After the final client
  disconnects the poller keeps a short grace window (so an immediate
  reconnect does not lose state) and then drops all tracked state and
  sleeps without touching SSH.
* One shared poller thread total; bounded per-client event queues
  (overflow degrades to a single resync.required, never unbounded memory).
* Events carry metadata only - never file contents.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Optional

log = logging.getLogger(__name__)

PROTOCOL_VERSION = 1

EVENT_TYPES = {
    "hello", "file.created", "file.modified", "file.deleted",
    "file.renamed", "workspace.online", "workspace.offline",
    "endpoint.changed", "git.changed", "resync.required", "pong",
}

# Tunables (kept small enough to feel live, large enough to stay cheap).
DEFAULT_POLL_INTERVAL = float(
    __import__("os").environ.get("HERMES_EDITOR_SYNC_POLL_INTERVAL", "3"))
GRACE_SECONDS = 10.0          # idle grace before dropping tracked state
OFFLINE_PROBE_INTERVAL = 20.0  # bounded reconnect probing while offline
BURST_THRESHOLD = 5            # changes within BURST_WINDOW -> git.changed
BURST_WINDOW = 10.0
MAX_PATHS_PER_POLL = 64        # hard cap on subscribed paths polled/cycle


class SyncClient:
    """One connected editor client with a bounded outbound event queue."""

    def __init__(self, client_id: str, maxsize: int = 256):
        self.client_id = client_id
        self.queue: "queue.Queue[Optional[dict]]" = queue.Queue(maxsize=maxsize)
        self.overflowed = False
        self.connected_at = time.time()

    def send(self, event: dict) -> None:
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            # Degrade gracefully: drop everything queued and ask the client
            # to revalidate. Never block the poller, never grow unbounded.
            self.overflowed = True
            drained = []
            try:
                while True:
                    drained.append(self.queue.get_nowait())
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait({
                    "v": PROTOCOL_VERSION, "type": "resync.required",
                    "workspace": None, "path": None,
                    "reason": "queue_overflow",
                    "timestamp": int(time.time()),
                })
            except queue.Full:  # pragma: no cover - single-element queue
                pass


class SyncManager:
    """Tracks subscriptions, polls subscribed files, emits protocol events."""

    def __init__(self, registry, provider_for,
                 poll_interval: Optional[float] = None):
        self._registry = registry
        self._provider_for = provider_for
        self.poll_interval = max(0.5, float(
            poll_interval or DEFAULT_POLL_INTERVAL))

        self._lock = threading.RLock()
        self._clients: dict = {}          # client_id -> SyncClient
        # wid -> {rel_path: set(client_id)}; ordered by first subscription
        self._subs: dict = {}
        # (wid, path) -> {"exists": bool, "mtime_ns": int, "size": int}
        self._known: dict = {}
        # wid -> {"online": bool|None, "endpoint": str|None, "offline_since": ts|None}
        self._ws_state: dict = {}
        self._burst: dict = {}            # wid -> list[timestamps]
        self._poller: Optional[threading.Thread] = None
        # Condition bound to the manager lock: notify_all() is always called
        # while holding self._lock.
        self._wake = threading.Condition(self._lock)
        self._stop = False
        self._last_disconnect = 0.0
        self._dropped_state = False

    # -- client lifecycle ---------------------------------------------------

    def register_client(self, client_id: str,
                        maxsize: int = 256) -> SyncClient:
        with self._lock:
            existing = self._clients.get(client_id)
            if existing is not None:
                return existing
            client = SyncClient(client_id, maxsize=maxsize)
            self._clients[client_id] = client
            self._ensure_poller()
            return client

    def unregister_client(self, client_id: str) -> None:
        with self._lock:
            self._clients.pop(client_id, None)
            for wid in list(self._subs.keys()):
                paths = self._subs[wid]
                for path in list(paths.keys()):
                    ids = paths[path]
                    ids.discard(client_id)
                    if not ids:
                        del paths[path]
                if not paths:
                    del self._subs[wid]
            if not self._clients:
                self._last_disconnect = time.monotonic()
            self._wake.notify_all()

    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)

    # -- subscriptions --------------------------------------------------------

    def subscribe(self, client_id: str, wid: str, path: str,
                  known_revision: str = "") -> bool:
        """Subscribe one client to one file. Returns False if rejected.

        Rejection reasons: unknown/disabled workspace or a path that is not
        a valid workspace-relative path (traversal/absolute/escape). The
        client can therefore NEVER point the poller outside configured
        workspace roots.
        """
        from .providers.base import validate_rel_path
        try:
            rel = validate_rel_path(path)
        except Exception:
            return False
        if not rel:
            return False
        ws = self._registry.get_workspace(wid)
        if ws is None or not ws.get("enabled", True):
            return False
        with self._lock:
            if client_id not in self._clients:
                return False
            self._subs.setdefault(wid, {}).setdefault(rel, set()).add(client_id)
            if (wid, rel) not in self._known:
                # Baseline established on the first poll cycle (silently -
                # no synthetic created/modified event for pre-existing files).
                self._known[(wid, rel)] = None
            self._wake.notify_all()
            return True

    def unsubscribe(self, client_id: str, wid: str, path: str) -> None:
        from .providers.base import validate_rel_path
        try:
            rel = validate_rel_path(path)
        except Exception:
            return
        with self._lock:
            paths = self._subs.get(wid)
            if not paths:
                return
            ids = paths.get(rel)
            if not ids:
                return
            ids.discard(client_id)
            if not ids:
                del paths[rel]
                if not paths:
                    self._subs.pop(wid, None)
            self._wake.notify_all()

    def subscription_count(self) -> int:
        with self._lock:
            return sum(len(ids) for paths in self._subs.values()
                       for ids in paths.values())

    def status(self) -> dict:
        with self._lock:
            return {
                "protocol": PROTOCOL_VERSION,
                "clients": len(self._clients),
                "subscriptions": sum(
                    len(ids) for paths in self._subs.values()
                    for ids in paths.values()),
                "workspaces": {
                    wid: {
                        "paths": sorted(paths.keys()),
                        **self._ws_state.get(wid, {}),
                    }
                    for wid, paths in self._subs.items()
                },
                "poll_interval": self.poll_interval,
                "polling_active": bool(self._subs),
            }

    # -- local-change notifications (API writes) ------------------------------

    def notify_local_change(self, wid: str, path: str, kind: str,
                            revision: str = "", size: int = None,
                            mtime_ns: int = None,
                            old_path: str = None) -> None:
        """Emit an event for a change made through this API itself."""
        if kind not in ("file.created", "file.modified", "file.deleted",
                        "file.renamed"):
            return
        with self._lock:
            if mtime_ns is None and kind != "file.deleted":
                # We do not learn the write's mtime; drop the tracked
                # signature so the next poll re-baselines silently instead
                # of emitting a duplicate change event.
                self._known.pop((wid, path), None)
                if old_path is not None:
                    self._known.pop((wid, old_path), None)
            else:
                exists = kind != "file.deleted"
                self._known[(wid, path)] = {
                    "exists": exists,
                    "mtime_ns": mtime_ns if mtime_ns is not None else 0,
                    "size": size if size is not None else 0,
                }
                if old_path is not None:
                    self._known.pop((wid, old_path), None)
        self.emit(wid, {
            "type": kind, "workspace": wid, "path": path,
            "old_path": old_path, "revision": revision,
            "size": size, "mtime_ns": mtime_ns,
        })

    # -- event emission ---------------------------------------------------------

    def emit(self, wid: Optional[str], event: dict) -> None:
        """Fan one event out to interested clients (bounded queues)."""
        ev = {"v": PROTOCOL_VERSION, "timestamp": int(time.time())}
        ev.update(event)
        with self._lock:
            if wid is None:
                targets = [c for c in self._clients.values()]
            else:
                paths = self._subs.get(wid, {})
                path = event.get("path")
                sub_ids = paths.get(path, set()) if path else set()
                if event.get("old_path"):
                    sub_ids = set(sub_ids) | paths.get(
                        event["old_path"], set())
                workspace_level = event.get("type") in (
                    "workspace.online", "workspace.offline",
                    "endpoint.changed", "git.changed", "resync.required")
                targets = [
                    c for cid, c in self._clients.items()
                    if workspace_level or cid in sub_ids
                ]
                if workspace_level and not paths:
                    # nobody subscribes here right now; still fine to skip
                    targets = []
        for client in targets:
            client.send(ev)

    # -- poller thread -----------------------------------------------------------

    def _ensure_poller(self) -> None:
        with self._lock:
            if self._poller is not None and self._poller.is_alive():
                return
            self._stop = False
            t = threading.Thread(target=self._poll_loop, name="he-sync-poller",
                                 daemon=True)
            self._poller = t
            t.start()

    def shutdown(self) -> None:
        with self._lock:
            self._stop = True
            self._clients.clear()
            self._subs.clear()
        with self._wake:
            self._wake.notify_all()

    def _poll_loop(self) -> None:
        while not self._stop:
            with self._lock:
                has_subs = bool(self._subs)
            if not has_subs:
                now = time.monotonic()
                with self._lock:
                    past_grace = (now - self._last_disconnect) > GRACE_SECONDS
                    if past_grace and (self._known or self._ws_state):
                        self._known.clear()
                        self._ws_state.clear()
                        self._burst.clear()
                        self._dropped_state = True
                        log.info("hermes-editor sync: no clients; polling stopped")
                with self._wake:
                    self._wake.wait(timeout=min(1.0, self.poll_interval))
                continue
            started = time.monotonic()
            try:
                self._poll_once()
            except Exception:  # never kill the poller
                log.exception("hermes-editor sync: poll cycle failed")
            elapsed = time.monotonic() - started
            delay = max(0.2, self.poll_interval - elapsed)
            with self._wake:
                self._wake.wait(timeout=delay)

    def _subscribed_paths_by_wid(self) -> dict:
        with self._lock:
            out = {}
            for wid, paths in self._subs.items():
                out[wid] = list(paths.keys())[:MAX_PATHS_PER_POLL]
            return out

    def _poll_once(self) -> None:
        plan = self._subscribed_paths_by_wid()
        for wid, paths in plan.items():
            if self._stop:
                return
            try:
                prov = self._provider_for(wid)
            except Exception:
                continue
            ws = self._registry.get_workspace(wid)
            if ws is None or not ws.get("enabled", True):
                continue
            self._poll_workspace(prov, wid, paths)

    def _poll_workspace(self, prov, wid: str, paths: list) -> None:
        ep_before = getattr(prov, "active_endpoint", None)
        try:
            stats = prov.stat_many(paths)
        except Exception as exc:
            offline = "offline" in str(type(exc).__name__).lower() or \
                      getattr(exc, "status_code", 0) == 503
            if offline:
                self._mark_offline(wid)
            else:
                log.debug("hermes-editor sync: stat_many failed on %s: %s",
                          wid, exc)
            return
        online = True
        self._mark_online(wid, getattr(prov, "active_endpoint", None),
                          ep_before)

        created, modified, deleted = [], [], []
        for st in stats:
            rel = st.get("path")
            key = (wid, rel)
            with self._lock:
                prev = self._known.get(key)
            sig = {"exists": bool(st.get("exists")),
                   "mtime_ns": st.get("mtime_ns") or 0,
                   "size": st.get("size") or 0}
            if prev is None:
                # first sight after subscribe: silent baseline
                with self._lock:
                    self._known[key] = sig
                continue
            if sig == prev:
                continue
            if not sig["exists"]:
                # keep previous size so rename pairing stays possible
                deleted.append({"path": rel,
                                "size": (prev or {}).get("size") or 0})
                with self._lock:
                    self._known[key] = sig
                continue
            entry_kind = "file.created" if prev and prev.get("exists") is False \
                else "file.modified"
            rev_info = self._read_revision(prov, rel, sig)
            if rev_info is None:
                # vanished between stat and read; treat as deleted next cycle
                continue
            revision, mtime_ns = rev_info[0], rev_info[1]
            text = rev_info[2] if len(rev_info) > 2 else None
            sig["mtime_ns"] = mtime_ns or sig["mtime_ns"]
            # NOTE: ``sig`` stays exactly {exists, mtime_ns, size} - it is
            # the comparison key. Revisions travel on events only.
            with self._lock:
                self._known[key] = sig
            ev = {
                "type": entry_kind, "workspace": wid, "path": rel,
                "revision": revision, "size": sig["size"],
                "mtime_ns": sig["mtime_ns"],
            }
            if text is not None:
                ev["_text"] = text   # consumed by the index updater below
            (created if entry_kind == "file.created" else modified).append(ev)

        renamed_pairs = self._pair_renames(created, deleted)
        created = [c for c in created if not c.get("_paired")]
        deleted = [d["path"] for d in deleted if not d.get("_paired")]

        # strip fetched text before any event leaves this module; it is
        # used only for the incremental index patch below
        md_texts = {}
        for ev in created + modified:
            t = ev.pop("_text", None)
            if t is not None:
                md_texts[ev["path"]] = t

        burst, window_count = self._register_burst(
            wid, len(created) + len(modified))
        if burst:
            changed_paths = [e["path"] for e in created + modified][:25]
            self.emit(wid, {
                "type": "git.changed", "workspace": wid,
                "changed_count": window_count,
                "paths": changed_paths,
            })
            self.emit(wid, {"type": "resync.required", "workspace": wid,
                            "reason": "mass_change"})
        else:
            for ev in created + modified:
                self.emit(wid, ev)
        for old, new in renamed_pairs:
            self.emit(wid, {
                "type": "file.renamed", "workspace": wid, "path": new,
                "old_path": old, "revision": "",
            })
        for rel in deleted:
            self.emit(wid, {
                "type": "file.deleted", "workspace": wid, "path": rel,
            })

        # Requirement: incremental single-entry index updates also cover
        # EXTERNAL markdown changes (never a full rescan).
        try:
            from . import index_store
        except Exception:
            index_store = None
        if index_store is not None:
            try:
                ws_cfg = self._registry.get_workspace(wid)
                do_index = bool(ws_cfg and ws_cfg.get("index_markdown", True))
            except Exception:
                do_index = True
            if do_index:
                for ev in created + modified:
                    if ev["path"].lower().endswith(".md"):
                        try:
                            index_store.apply_change(
                                wid, prov, ev["path"],
                                text=md_texts.get(ev["path"]),
                                stat_info={"size": ev.get("size"),
                                           "mtime_ns": ev.get("mtime_ns")})
                        except Exception:
                            log.exception("he-sync: index update failed %s",
                                          ev["path"])
                for old, new in renamed_pairs:
                    try:
                        index_store.apply_change(wid, prov, old,
                                                 renamed_to=new)
                    except Exception:
                        log.exception("he-sync: index rename failed %s", old)
                for rel in deleted:
                    if rel.lower().endswith(".md"):
                        try:
                            index_store.apply_change(wid, prov, rel,
                                                     deleted=True)
                        except Exception:
                            log.exception("he-sync: index delete failed %s",
                                          rel)

    @staticmethod
    def _read_revision(prov, rel: str, sig: dict):
        """Fetch the real SHA-256 for a detected change (metadata only).

        Returns (revision, mtime_ns, text|None); text is included for
        indexable markdown so the incremental index can be patched from
        the same single read.
        """
        try:
            f = prov.read(rel)
        except Exception:
            return None
        revision = f.get("revision") or ""
        text = None
        if rel.lower().endswith(".md") and f.get("encoding") == "text" \
                and (sig.get("size") or 0) <= 512_000:
            text = f.get("content")
        return revision, f.get("mtime_ns"), text

    @staticmethod
    def _pair_renames(created: list, deleted: list) -> list:
        """Confident rename identification only: same batch, same size.

        Anything ambiguous stays a delete+create pair - we never guess.
        """
        pairs = []
        remaining = list(deleted)
        for crev in created:
            if crev.get("_paired") or not remaining:
                continue
            match = None
            for d in remaining:
                if d["size"] and d["size"] == crev.get("size"):
                    match = d
                    break
            if match is not None:
                pairs.append((match["path"], crev["path"]))
                remaining.remove(match)
                match["_paired"] = True
                crev["_paired"] = True
        return pairs

    def _register_burst(self, wid: str, count: int) -> tuple:
        """Record detections in a rolling window.

        Returns (burst_started_now, total_in_window). git.changed fires on
        the transition into burst mode only - one collapsed event instead
        of a per-cycle storm for a long checkout/pull.
        """
        now = time.monotonic()
        with self._lock:
            window = [t for t in self._burst.get(wid, [])
                      if now - t < BURST_WINDOW]
            was_active = len(window) >= BURST_THRESHOLD
            if count > 0:
                window.extend([now] * count)
            self._burst[wid] = window[-200:]
            active = bool(window) and len(window) >= BURST_THRESHOLD
            return (active and not was_active and count > 0), len(window)

    # -- endpoint / availability tracking -------------------------------------

    def _mark_online(self, wid: str, endpoint: Optional[str],
                     previous_endpoint: Optional[str]) -> None:
        with self._lock:
            state = self._ws_state.setdefault(
                wid, {"online": None, "endpoint": None})
            was_online = state.get("online")
            old_ep = state.get("endpoint")
            state["online"] = True
            state["endpoint"] = endpoint
            state.pop("offline_since", None)
        if was_online is False:
            self.emit(wid, {"type": "workspace.online", "workspace": wid,
                            "endpoint": endpoint})
            self.emit(wid, {"type": "resync.required", "workspace": wid,
                            "reason": "back_online"})
        elif endpoint and old_ep and endpoint != old_ep:
            self.emit(wid, {"type": "endpoint.changed", "workspace": wid,
                            "endpoint": endpoint, "previous": old_ep})
            self.emit(wid, {"type": "resync.required", "workspace": wid,
                            "reason": "endpoint_changed"})

    def _mark_offline(self, wid: str) -> None:
        with self._lock:
            state = self._ws_state.setdefault(
                wid, {"online": None, "endpoint": None})
            was_online = state.get("online")
            state["online"] = False
            state["endpoint"] = None
            state.setdefault("offline_since", time.monotonic())
        if was_online is not False:
            self.emit(wid, {"type": "workspace.offline", "workspace": wid})


_manager: Optional[SyncManager] = None
_manager_lock = threading.Lock()


def get_sync_manager() -> SyncManager:
    """Process-wide singleton wired to the workspace registry."""
    global _manager
    with _manager_lock:
        if _manager is None:
            from . import registry as reg_mod
            _manager = SyncManager(reg_mod.get_registry(), reg_mod.provider_for)
        return _manager


def reset_sync_manager() -> None:
    global _manager
    with _manager_lock:
        if _manager is not None:
            _manager.shutdown()
        _manager = None
