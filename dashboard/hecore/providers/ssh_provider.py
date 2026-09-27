"""SSH-backed workspace provider (Stage 5A).

Lightweight OpenSSH-based provider. Reuses Hermes ``SSHEnvironment``
patterns (BatchMode, ControlMaster multiplexing, short control-persist)
but deliberately does NOT instantiate SSHEnvironment, whose constructor
performs unwanted ~/.hermes synchronization side effects.

Endpoint policy:
* Endpoints are tried in configured order (Ethernet first, Tailscale
  fallback) among those whose failure cooldown has expired.
* A failed endpoint gets exponential-backoff cooldown (15s doubling,
  capped at 5 minutes) so a dead Ethernet link is not hammered and
  cannot flap the connection; it becomes eligible again automatically,
  which makes recovery implicit (the next operation is the probe).
* One provider operation == one SSH invocation against ONE endpoint.
  We never switch endpoints mid-operation. After any failover the next
  attempt re-runs the whole operation - including revision validation -
  against the new endpoint, so atomic writes are always revalidated.

All payloads are structured JSON piped through stdin to a small remote
Python helper (see remote_helper.py); filenames are never interpolated
into shell commands.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import threading
import time
import hashlib
from typing import Optional

from .base import (
    MAX_TEXT_BYTES,
    MAX_IMAGE_BYTES,
    ConflictError,
    OfflineError,
    ProviderError,
    WorkspaceProvider,
    validate_rel_path,
)
from .remote_helper import HELPER_SOURCE, helper_remote_path, helper_sha256


def _control_dir() -> str:
    d = os.path.join(tempfile.gettempdir(), "hermes-editor-ssh")
    os.makedirs(d, exist_ok=True)
    return d


class _EndpointPolicy:
    """Ethernet-preferred ordering with exponential-backoff hysteresis."""

    BASE_COOLDOWN = 15.0
    MAX_COOLDOWN = 300.0

    def __init__(self, endpoints: list):
        self.endpoints = list(endpoints)
        self._failures = {e: 0 for e in self.endpoints}
        self._failed_until = {e: 0.0 for e in self.endpoints}

    def order(self) -> list:
        now = time.monotonic()
        healthy = [e for e in self.endpoints if self._failed_until[e] <= now]
        cooling = sorted(
            (e for e in self.endpoints if self._failed_until[e] > now),
            key=lambda e: self._failed_until[e])
        return healthy + cooling

    def mark_ok(self, ep: str) -> None:
        self._failures[ep] = 0
        self._failed_until[ep] = 0.0

    def mark_failed(self, ep: str) -> None:
        n = self._failures.get(ep, 0) + 1
        self._failures[ep] = n
        cd = min(self.MAX_COOLDOWN, self.BASE_COOLDOWN * (2 ** max(0, n - 1)))
        self._failed_until[ep] = time.monotonic() + cd

    def status(self) -> dict:
        now = time.monotonic()
        return {
            e: {
                "cooling": self._failed_until[e] > now,
                "cooldown_remaining_s": round(max(0.0, self._failed_until[e] - now), 1),
                "consecutive_failures": self._failures[e],
            }
            for e in self.endpoints
        }


class SshProvider(WorkspaceProvider):
    kind = "ssh"

    CONNECT_TIMEOUT = 4
    OP_TIMEOUT = 30
    INDEX_TIMEOUT = 180

    _providers_lock = threading.Lock()

    def __init__(self, host_id: str, user: str, endpoints: list, root: str):
        super().__init__(root)
        if not endpoints:
            raise ValueError("host needs at least one endpoint")
        self.host_id = host_id
        self.user = user
        self.policy = _EndpointPolicy([str(e) for e in endpoints])
        self._active: Optional[str] = None
        self._helper_ready: set = set()
        self._helper_lock = threading.Lock()

    # -- availability ------------------------------------------------------

    @property
    def active_endpoint(self) -> Optional[str]:
        return self._active

    def health(self) -> dict:
        started = time.monotonic()
        try:
            resp = self._execute({"op": "ping", "root": self.root},
                                 timeout=12, allow_offline_result=True)
        except OfflineError:
            return {
                "online": False, "endpoint": None, "transport": "ssh",
                "host": self.host_id, "endpoints": self.policy.status(),
            }
        latency_ms = int((time.monotonic() - started) * 1000)
        resp_body = resp.get("response") or {}
        return {
            "online": True,
            "endpoint": resp["endpoint"],
            "transport": "ssh",
            "host": self.host_id,
            "latency_ms": latency_ms,
            "remote_root": self.root,
            "root_exists": bool(resp_body.get("root_exists", True)),
            "hostname": resp_body.get("hostname"),
            "endpoints": self.policy.status(),
        }

    # -- ssh plumbing --------------------------------------------------------

    def _ssh_argv(self, endpoint: str, remote_command: str) -> list:
        sock = os.path.join(_control_dir(), hashlib.sha256(
            f"{self.user}@{endpoint}".encode()).hexdigest()[:16] + ".sock")
        return [
            "ssh",
            "-o", "BatchMode=yes",
            "-o", f"ConnectTimeout={self.CONNECT_TIMEOUT}",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"ControlPath={sock}",
            "-o", "ControlMaster=auto",
            "-o", "ControlPersist=60",
            "-o", "ServerAliveInterval=10",
            "-o", "ServerAliveCountMax=2",
            f"{self.user}@{endpoint}",
            remote_command,
        ]

    def _run(self, endpoint: str, remote_command: str, input_bytes: bytes,
             timeout: int) -> subprocess.CompletedProcess:
        argv = self._ssh_argv(endpoint, remote_command)
        try:
            return subprocess.run(
                argv, input=input_bytes, capture_output=True,
                timeout=timeout, stdin=None)
        except subprocess.TimeoutExpired:
            raise TransportFailure(f"timeout after {timeout}s")
        except OSError as exc:
            raise TransportFailure(str(exc))

    def _ensure_helper(self, endpoint: str) -> None:
        if endpoint in self._helper_ready:
            return
        dest = helper_remote_path()
        with self._helper_lock:
            if endpoint in self._helper_ready:
                return
            # cheap existence/hash check first (also opens the mux socket)
            chk = self._run(endpoint, f"sha256sum {dest} 2>/dev/null || echo MISSING",
                            b"", timeout=20)
            if chk.returncode != 0:
                raise TransportFailure(
                    f"ssh failed rc={chk.returncode}: "
                    f"{chk.stderr.decode(errors='replace')[:200]}")
            out = chk.stdout.decode(errors="replace").strip().splitlines()
            if out and out[-1].strip().startswith(helper_sha256()):
                self._helper_ready.add(endpoint)
                return
            # install atomically via mv; verify hash afterwards
            up = self._run(
                endpoint,
                f"cat > {dest}.new && mv {dest}.new {dest} && sha256sum {dest}",
                HELPER_SOURCE.encode(), timeout=30)
            if up.returncode != 0:
                try:  # best effort cleanup of partial file
                    self._run(endpoint, f"rm -f {dest}.new", b"", timeout=10)
                except Exception:
                    pass
                raise TransportFailure(
                    f"helper upload failed: {up.stderr.decode(errors='replace')[:200]}")
            lines = up.stdout.decode(errors="replace").strip().splitlines()
            if not lines or not lines[-1].strip().startswith(helper_sha256()):
                raise ProviderError(500, "remote helper hash mismatch")
            self._helper_ready.add(endpoint)

    def _execute(self, request: dict, timeout: int = OP_TIMEOUT,
                 allow_offline_result: bool = False):
        """Run one helper op, failing over between endpoints if needed."""
        payload = json.dumps(request).encode()
        dest = helper_remote_path()
        last_err = None
        for endpoint in self.policy.order():
            try:
                self._ensure_helper(endpoint)
                proc = self._run(endpoint, f"python3 {dest}", payload, timeout)
            except TransportFailure as exc:
                last_err = exc
                self.policy.mark_failed(endpoint)
                continue
            if proc.returncode == 255:
                # ssh-level error (auth, refused, dropped)
                last_err = TransportFailure(
                    proc.stderr.decode(errors="replace")[:300])
                self.policy.mark_failed(endpoint)
                # drop a possibly-dead mux socket so the next try reconnects
                self._teardown_mux(endpoint)
                continue
            try:
                text = proc.stdout.decode(errors="replace").strip()
                start = text.rfind("\n{")
                body = text[start + 1:] if start >= 0 else text
                resp = json.loads(body)
            except (ValueError, IndexError):
                last_err = TransportFailure("unparsable helper output")
                self.policy.mark_failed(endpoint)
                continue
            self.policy.mark_ok(endpoint)
            self._active = endpoint
            if not resp.get("ok"):
                err = resp.get("error") or {}
                status = int(err.get("status", 500))
                detail = err.get("detail", "remote error")
                if status == 409 and isinstance(detail, dict) and detail.get("conflict"):
                    raise ConflictError(detail.get("reason", "conflict"),
                                        detail.get("base_revision", ""),
                                        detail.get("current_revision", ""))
                raise ProviderError(status, detail)
            return {"endpoint": endpoint, "response": resp}
        if allow_offline_result:
            raise OfflineError(self.host_id)
        raise OfflineError(self.host_id)

    # -- operations ----------------------------------------------------------

    def stat(self, rel: str) -> dict:
        r = self._exec_op({"op": "stat", "path": validate_rel_path(rel)})
        r.pop("ok", None)
        return r

    def stat_many(self, rels: list, with_revision: bool = False) -> list:
        """One SSH invocation for the whole batch (no recursive scanning)."""
        from .base import validate_rel_path as _vrp
        batch = []
        for rel in rels[:64]:
            try:
                batch.append(_vrp(rel))
            except Exception:
                batch.append("")
        req = {"op": "stat_many", "paths": batch}
        if with_revision:
            req["with_revision"] = True
        r = self._exec_op(req)
        stats = r.get("stats")
        if not isinstance(stats, list):
            raise ProviderError(500, "bad stat_many response")
        return stats

    def list_dir(self, rel: str) -> list:
        r = self._exec_op({"op": "list", "path": validate_rel_path(rel)})
        return r.get("entries", [])

    def read(self, rel: str) -> dict:
        r = self._exec_op({
            "op": "read", "path": validate_rel_path(rel),
            "max_bytes": MAX_TEXT_BYTES})
        r.pop("ok", None)
        return r

    def read_image(self, rel: str) -> bytes:
        r = self._exec_op({
            "op": "read_image", "path": validate_rel_path(rel),
            "max_bytes": MAX_IMAGE_BYTES})
        try:
            return base64.b64decode(r["content_b64"], validate=True)
        except (KeyError, ValueError) as exc:
            raise ProviderError(500, "bad image response") from exc

    def write(self, rel: str, data: bytes, base_revision: str,
              force: bool) -> dict:
        validate_rel_path(rel)
        r = self._exec_op({
            "op": "write", "path": rel,
            "content_b64": base64.b64encode(data).decode("ascii"),
            "base_revision": base_revision, "force": bool(force)},
            timeout=self.OP_TIMEOUT * 2)
        return {"revision": r["revision"], "size": r["size"]}

    def mkdir(self, rel: str) -> None:
        self._exec_op({"op": "mkdir", "path": validate_rel_path(rel)})

    def rename(self, src: str, dst: str) -> dict:
        r = self._exec_op({"op": "rename",
                           "src": validate_rel_path(src),
                           "dst": validate_rel_path(dst)})
        return {"from": r["from"], "to": r["to"]}

    def delete(self, rel: str) -> None:
        self._exec_op({"op": "delete", "path": validate_rel_path(rel)})

    def index_scan(self) -> dict:
        r = self._exec_op({"op": "index"}, timeout=self.INDEX_TIMEOUT)
        return {
            "entries": r.get("entries", []),
            "scanned": r.get("scanned", 0),
            "skipped_oversized": r.get("skipped_oversized", 0),
            "truncated": r.get("truncated", False),
        }

    def _exec_op(self, request: dict, timeout: int = OP_TIMEOUT) -> dict:
        result = self._execute(dict(request, root=self.root), timeout=timeout)
        return result["response"]

    def _control_socket(self, endpoint: str) -> str:
        argv = self._ssh_argv(endpoint, "true")
        for flag in argv:
            if flag.startswith("ControlPath="):
                return flag.split("=", 1)[1]
        return ""

    def _teardown_mux(self, endpoint: str) -> None:
        sock = self._control_socket(endpoint)
        if not sock:
            return
        try:
            subprocess.run(["ssh", "-o", f"ControlPath={sock}",
                            "-O", "exit", f"{self.user}@{endpoint}"],
                           capture_output=True, timeout=5)
        except Exception:
            pass

    def close(self) -> None:
        for endpoint in self.policy.endpoints:
            self._teardown_mux(endpoint)


class TransportFailure(Exception):
    pass


__all__ = ["SshProvider", "TransportFailure", "_EndpointPolicy", "ConflictError"]
