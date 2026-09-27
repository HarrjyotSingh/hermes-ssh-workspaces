"""Persistent host/workspace registry for hermes-editor (Stage 5A).

Stored OUTSIDE Hermes core, in the plugin's existing state directory:

    <hermes-home>/hermes-editor-state/workspace-config.json

Hosts and workspaces are separate concepts:
* host    = a machine (provider kind, ssh user, ordered endpoints)
* workspace = a stable ID + label + host + absolute remote root

The frontend can add/edit/remove workspaces at runtime; nothing is
hard-coded per workspace in source. The built-in ``local`` workspace
(provider "local", root = active Hermes home) preserves Stage 2/3
behaviour and is always first.

Security contract: the API layer only ever resolves client requests to
a *configured workspace id*. Arbitrary frontend-supplied absolute roots
are never accepted (the legacy ``root=`` query parameter is mapped onto
configured workspaces only, for backward compatibility).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Optional

from .providers.base import valid_workspace_id

log = logging.getLogger(__name__)

CONFIG_VERSION = 1


def state_dir() -> Path:
    try:
        from hermes_constants import get_hermes_home
        d = Path(get_hermes_home()) / "hermes-editor-state"
    except Exception:
        d = Path.home() / ".hermes" / "hermes-editor-state"
    d.mkdir(parents=True, exist_ok=True)
    return d


def config_path() -> Path:
    return state_dir() / "workspace-config.json"


# No operator-specific machines or filesystem paths are shipped with the plugin.
# Configure SSH hosts and workspaces through the UI or API after installation.
DEFAULT_HOSTS = {}

LOCAL_WORKSPACE_ID = "local"
DEFAULT_CONFIG = {
    "version": CONFIG_VERSION,
    "hosts": {},
    "workspaces": {
        LOCAL_WORKSPACE_ID: {
            "label": "Hermes home",
            "provider": "local",
            "host": None,
            "root": None,
            "enabled": True,
            "index_markdown": True,
        },
    },
}

class RegistryError(ValueError):
    pass


class WorkspaceRegistry:
    """Thread-safe JSON-backed registry with provider construction."""

    def __init__(self):
        self._lock = threading.RLock()
        self._config = self._load()
        self._provider_cache: dict = {}

    # -- persistence -------------------------------------------------------

    def _load(self) -> dict:
        p = config_path()
        if p.is_file():
            try:
                cfg = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(cfg, dict) and isinstance(cfg.get("workspaces"), dict):
                    cfg.setdefault("version", CONFIG_VERSION)
                    # Config files predate the bundled host registry.  Keep
                    # every operator-defined host verbatim, but backfill
                    # shipped machine ids that are absent so the Add workspace
                    # picker does not become permanently empty after upgrade.
                    configured_hosts = cfg.setdefault("hosts", {})
                    if isinstance(configured_hosts, dict):
                        changed = False
                        for host_id, host in DEFAULT_HOSTS.items():
                            if host_id not in configured_hosts:
                                configured_hosts[host_id] = dict(host)
                                changed = True
                        if changed:
                            self._save(cfg)
                    return cfg
            except (OSError, ValueError) as exc:
                log.warning("hermes-editor: bad workspace config (%s); using defaults", exc)
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
        self._save(cfg)
        return cfg

    def _save(self, cfg: Optional[dict] = None) -> None:
        cfg = cfg if cfg is not None else self._config
        p = config_path()
        tmp = p.with_suffix(f".tmp-{os.getpid()}")
        tmp.write_text(json.dumps(cfg, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, p)

    def reload(self) -> None:
        with self._lock:
            self._config = self._load()

    # -- hosts ---------------------------------------------------------------

    def hosts(self) -> dict:
        with self._lock:
            return {k: dict(v) for k, v in self._config["hosts"].items()}

    def upsert_host(self, host_id: str, spec: dict) -> dict:
        """Create or update an SSH host without exposing credentials to clients."""
        with self._lock:
            host_id = str(host_id or "").strip().lower()
            if not valid_workspace_id(host_id):
                raise RegistryError("host id must match [a-z0-9][a-z0-9_-]{0,63}")
            endpoints = spec.get("endpoints")
            if not isinstance(endpoints, list):
                raise RegistryError("host requires at least one endpoint")
            endpoints = [str(endpoint).strip() for endpoint in endpoints if str(endpoint).strip()]
            if not endpoints:
                raise RegistryError("host requires at least one endpoint")
            if any(any(ch.isspace() for ch in endpoint) for endpoint in endpoints):
                raise RegistryError("host endpoints must not contain whitespace")
            existing = self._config["hosts"].get(host_id, {})
            user = str(spec.get("user") or existing.get("user") or os.environ.get("USER") or "").strip()
            if not user:
                raise RegistryError("host requires an SSH user")
            entry = {"provider": "ssh", "user": user, "endpoints": list(dict.fromkeys(endpoints))}
            self._config["hosts"][host_id] = entry
            self._save()
            return {"id": host_id, **entry}

    # -- workspaces ------------------------------------------------------------

    def list_workspaces(self, include_disabled: bool = True) -> list:
        with self._lock:
            out = []
            for wid, ws in self._config["workspaces"].items():
                if not include_disabled and not ws.get("enabled", True):
                    continue
                item = {"id": wid}
                item.update({
                    "label": ws.get("label") or wid,
                    "provider": ws.get("provider")
                                or ("local" if ws.get("host") is None else "ssh"),
                    "host": ws.get("host"),
                    "root": ws.get("root"),
                    "enabled": bool(ws.get("enabled", True)),
                    "index_markdown": bool(ws.get("index_markdown", True)),
                })
                out.append(item)
            # local workspace first, then alphabetical by label
            out.sort(key=lambda w: (w["id"] != LOCAL_WORKSPACE_ID, w["label"].lower()))
            return out

    def get_workspace(self, wid: str) -> Optional[dict]:
        with self._lock:
            ws = self._config["workspaces"].get(wid)
            if ws is None:
                return None
            item = {"id": wid}
            item.update({
                "label": ws.get("label") or wid,
                "provider": ws.get("provider")
                            or ("local" if ws.get("host") is None else "ssh"),
                "host": ws.get("host"),
                "root": ws.get("root"),
                "enabled": bool(ws.get("enabled", True)),
                "index_markdown": bool(ws.get("index_markdown", True)),
            })
            return item

    def default_workspace_id(self) -> str:
        with self._lock:
            enabled = [w for w in self.list_workspaces(include_disabled=False)]
            return enabled[0]["id"] if enabled else LOCAL_WORKSPACE_ID

    def upsert_workspace(self, wid: str, spec: dict) -> dict:
        with self._lock:
            wid = str(wid or "").strip().lower()
            if not valid_workspace_id(wid):
                raise RegistryError(
                    "workspace id must match [a-z0-9][a-z0-9_-]{0,63}")
            existing = self._config["workspaces"].get(wid, {})
            provider = spec.get("provider") or existing.get("provider")
            host = spec.get("host", existing.get("host"))
            root = spec.get("root", existing.get("root"))
            if provider is None:
                provider = "local" if (host is None and root is None) else "ssh"
            if provider == "local":
                provider = "local"
                host = None
                if root is not None:
                    if not isinstance(root, str) or not root.startswith("/") \
                            or any(seg == ".." for seg in root.split("/")) \
                            or "\x00" in root:
                        raise RegistryError(
                            "local workspace requires an absolute local root")
                    root = root.rstrip("/") or "/"
            elif provider == "ssh":
                if not host:
                    raise RegistryError("remote workspace requires a host id")
                if host not in self._config["hosts"]:
                    raise RegistryError(f"unknown host: {host}")
                if not isinstance(root, str) or not root.startswith("/") \
                        or any(seg == ".." for seg in root.split("/")) \
                        or "\x00" in root:
                    raise RegistryError(
                        "remote workspace requires an absolute remote root")
                root = root.rstrip("/") or "/"
            else:
                raise RegistryError(f"unsupported provider: {provider}")

            entry = {
                "label": str(spec.get("label") or existing.get("label") or wid)[:120],
                "provider": provider,
                "host": host,
                "root": root,
                "enabled": bool(spec.get("enabled", existing.get("enabled", True))),
                "index_markdown": bool(spec.get(
                    "index_markdown", existing.get("index_markdown", True))),
            }
            self._config["workspaces"][wid] = entry
            self._save()
            self._provider_cache.pop(wid, None)
            return {"id": wid, **entry}

    def remove_workspace(self, wid: str) -> None:
        with self._lock:
            if wid == LOCAL_WORKSPACE_ID:
                raise RegistryError("the local workspace cannot be removed")
            if wid not in self._config["workspaces"]:
                raise KeyError(wid)
            del self._config["workspaces"][wid]
            self._save()
            self._provider_cache.pop(wid, None)

    def resolve_legacy_root(self, root_param: str) -> Optional[str]:
        """Map a legacy `root=` query value onto a configured workspace.

        Never accepts arbitrary absolute paths from the frontend.
        """
        if not root_param:
            return None
        want = os.path.abspath(os.path.expanduser(root_param))
        with self._lock:
            for w in self.list_workspaces():
                if w["provider"] != "local":
                    continue
                base = w["root"] or str(_hermes_home())
                if os.path.abspath(os.path.expanduser(base)) == want:
                    return w["id"]
        return None


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


# ---------------------------------------------------------------------------
# Provider factory (cached per workspace so SSH mux sockets/policy survive)
# ---------------------------------------------------------------------------

_registry_lock = threading.Lock()
_registry: Optional[WorkspaceRegistry] = None


def get_registry() -> WorkspaceRegistry:
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = WorkspaceRegistry()
        return _registry


def provider_for(wid: str):
    """Build/cache the provider for a configured workspace id."""
    reg = get_registry()
    ws = reg.get_workspace(wid)
    if ws is None:
        raise KeyError(wid)
    with reg._lock:
        cached = reg._provider_cache.get(wid)
        if cached is not None:
            return cached
        if ws["provider"] == "local":
            from .providers.local import LocalProvider
            prov = LocalProvider(root=ws["root"])
        else:
            from .providers.ssh_provider import SshProvider
            host = reg.hosts()[ws["host"]]
            prov = SshProvider(host_id=ws["host"], user=host.get("user", ""),
                               endpoints=host.get("endpoints", []),
                               root=ws["root"])
        reg._provider_cache[wid] = prov
        return prov
