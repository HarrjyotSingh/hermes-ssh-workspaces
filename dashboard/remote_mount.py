import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

log = logging.getLogger("hermes.editor.remote_mount")

_JOBS: dict = {}
_JOBS_LOCK = threading.Lock()
_UNIT_PREFIX = "hermes-ws"


def _hermes_home() -> Path:
    return Path.home() / ".hermes"


def _state_dir() -> Path:
    return _hermes_home() / "hermes-editor-state" / "mounts"


def anchor_for(key: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", key)
    return _hermes_home() / "remote-workspaces" / safe


def _unit_name(key: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", key)
    return f"{_UNIT_PREFIX}-{safe}"


def is_mounted(key: str) -> bool:
    anchor = anchor_for(key)
    try:
        return os.path.ismount(str(anchor))
    except OSError:
        return False


def _read_state(key: str) -> dict:
    try:
        return json.loads((_state_dir() / f"{key}.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def _write_state(key: str, data: dict) -> None:
    _state_dir().mkdir(parents=True, exist_ok=True)
    (_state_dir() / f"{key}.json").write_text(json.dumps(data, indent=2))


def _clear_state(key: str) -> None:
    try:
        (_state_dir() / f"{key}.json").unlink()
    except FileNotFoundError:
        pass


def _set_job(key: str, status: str, detail: str = "") -> None:
    with _JOBS_LOCK:
        _JOBS[key] = {"status": status, "detail": detail, "at": time.time()}


def mount_status(key: str) -> dict:
    with _JOBS_LOCK:
        job = dict(_JOBS.get(key) or {})
    mounted = is_mounted(key)
    if not job and mounted:
        state = _read_state(key)
        return {
            "key": key,
            "mounted": True,
            "anchor": str(anchor_for(key)),
            "endpoint": state.get("endpoint"),
            "root": state.get("root"),
        }
    out = {
        "key": key,
        "mounted": mounted,
        "anchor": str(anchor_for(key)),
        "endpoint": (_read_state(key) or {}).get("endpoint"),
        "root": (_read_state(key) or {}).get("root"),
    }
    if job and time.time() - job.get("at", 0) < 300:
        out["job"] = job["status"]
        if job.get("detail"):
            out["job_detail"] = job["detail"]
    return out


def _systemd_available() -> bool:
    if shutil.which("systemd-run") is None or shutil.which("systemctl") is None:
        return False
    if not os.environ.get("XDG_RUNTIME_DIR"):
        return False
    probe = subprocess.run(
        ["systemctl", "--user", "is-system-running"],
        capture_output=True, text=True, timeout=10,
    )
    return probe.returncode == 0 or "degraded" in probe.stdout


def _stop_unit(key: str) -> None:
    subprocess.run(
        ["systemctl", "--user", "stop", _unit_name(key)],
        capture_output=True, text=True, timeout=20, check=False,
    )


def _rclone_base(rclone: str, endpoint: str, user: str, root: str, anchor: Path, log_file: Path) -> list:
    cmd = [
        rclone, "mount", f":sftp:{root}", str(anchor),
        "--sftp-host", endpoint, "--sftp-user", user,
        "--dir-cache-time", "5s", "--attr-timeout", "5s",
        "--log-file", str(log_file), "--log-level", "INFO",
        # Do not hold a Pi/SFTP connection open indefinitely. A short idle
        # timeout makes the mount on-demand and discards a stale socket before
        # the next file-tree read can spend minutes waiting for TCP recovery.
        "--sftp-idle-timeout", "1m",
        "--contimeout", "10s", "--timeout", "15s",
        "--vfs-cache-mode", "writes",
        "--retries", "2", "--low-level-retries", "2",
        "--sftp-key-file", str(Path.home() / ".ssh" / "id_ed25519"),
    ]
    return cmd


def _mount_via_systemd(key: str, endpoint: str, user: str, root: str, anchor: Path, log_file: Path) -> bool:
    rclone = _rclone_bin()
    cmd = _rclone_base(rclone, endpoint, user, root, anchor, log_file)
    unit = _unit_name(key)
    _stop_unit(key)
    subprocess.run(["fusermount3", "-uz", str(anchor)], check=False, capture_output=True, timeout=30)
    # A backend/service restart can terminate rclone cleanly (exit 0), which
    # is not an "on-failure" condition. Keep the independent workspace unit
    # alive in either case; an explicit `systemctl stop` during unmount still
    # suppresses Restart=always.
    launch = ["systemd-run", "--user", "--unit", unit, "--collect",
              "--property", "Restart=always", "--property", "RestartSec=5"] + cmd
    proc = subprocess.run(launch, capture_output=True, text=True, timeout=20)
    if proc.returncode != 0:
        raise RuntimeError(f"systemd-run failed: {(proc.stderr or proc.stdout).strip()[:160]}")
    for _ in range(24):
        if is_mounted(key):
            return True
        state = subprocess.run(
            ["systemctl", "--user", "is-active", unit],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if state == "failed":
            return False
        time.sleep(0.5)
    return is_mounted(key)


def _mount_blocking(key: str, ws: dict, hosts: dict) -> dict:
    if not shutil.which("fusermount3") and not shutil.which("fusermount"):
        raise RuntimeError("fusermount3 not available")
    rclone = _rclone_bin()
    if not rclone:
        raise RuntimeError("rclone not installed on the backend (~/.local/bin/rclone)")
    anchor = anchor_for(key)
    if is_mounted(key):
        return {"mounted": True, "anchor": str(anchor), "already": True}

    host_entry = hosts.get(ws.get("host")) or {}
    endpoints = list(host_entry.get("endpoints") or [])
    user = host_entry.get("user") or os.environ.get("USER") or ""
    root = str(ws.get("root") or "/")
    if not endpoints:
        raise RuntimeError(f"host '{ws.get('host')}' has no endpoints configured")

    anchor.mkdir(parents=True, exist_ok=True)
    log_dir = _state_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{key}.mount.log"

    use_systemd = _systemd_available()
    last_err = "no endpoints attempted"
    for endpoint in endpoints:
        try:
            if use_systemd:
                ok = _mount_via_systemd(key, endpoint, user, root, anchor, log_file)
            else:
                ok = _mount_via_daemon(key, endpoint, user, root, anchor, log_file)
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)[:200]
            continue
        if ok:
            _write_state(key, {"endpoint": endpoint, "root": root, "mounted_at": time.time()})
            log.info("remote workspace %s mounted via %s at %s", key, endpoint, anchor)
            return {"mounted": True, "anchor": str(anchor), "endpoint": endpoint}
        last_err = f"{endpoint}: mount did not appear"
        _stop_unit(key)
        subprocess.run(["fusermount3", "-uz", str(anchor)], check=False, capture_output=True)

    raise RuntimeError(last_err)


def _mount_via_daemon(key: str, endpoint: str, user: str, root: str, anchor: Path, log_file: Path) -> bool:
    rclone = _rclone_bin()
    cmd = _rclone_base(rclone, endpoint, user, root, anchor, log_file)
    cmd += ["--daemon", "--daemon-wait", "10s"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
    except subprocess.TimeoutExpired:
        subprocess.run(["fusermount3", "-uz", str(anchor)], check=False, capture_output=True)
        return False
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "rclone failed").strip()[:200])
    for _ in range(12):
        if is_mounted(key):
            return True
        time.sleep(0.5)
    return False


def _mount_thread(key: str, ws: dict, hosts: dict) -> None:
    try:
        result = _mount_blocking(key, ws, hosts)
        if result.get("mounted"):
            _set_job(key, "mounted")
        else:
            _set_job(key, "failed", "mount failed")
    except Exception as exc:  # noqa: BLE001
        _set_job(key, "failed", str(exc)[:200])


def start_mount(key: str, ws: dict, hosts: dict) -> dict:
    if is_mounted(key):
        return {"mounting": False, "mounted": True}
    _set_job(key, "mounting")
    thread = threading.Thread(target=_mount_thread, args=(key, ws, hosts), daemon=True)
    thread.start()
    return {"mounting": True}


def unmount_workspace(key: str) -> dict:
    anchor = anchor_for(key)
    _stop_unit(key)
    if not is_mounted(key):
        _clear_state(key)
        return {"mounted": False}
    fusermount = shutil.which("fusermount3") or shutil.which("fusermount")
    if not fusermount:
        raise RuntimeError("fusermount3 not available")
    subprocess.run([fusermount, "-uz", str(anchor)], check=False,
                   capture_output=True, text=True, timeout=30)
    time.sleep(0.3)
    if is_mounted(key):
        raise RuntimeError("unmount did not take effect")
    _clear_state(key)
    return {"mounted": False}


def _rclone_bin() -> str:
    local = Path.home() / ".local" / "bin" / "rclone"
    if local.is_file():
        return str(local)
    return shutil.which("rclone") or ""


def _load_hosts() -> dict:
    try:
        from hecore.registry import get_registry
        return get_registry().hosts()
    except Exception:  # noqa: BLE001
        cfg = _hermes_home() / "hermes-editor-state" / "workspace-config.json"
        try:
            return json.loads(cfg.read_text()).get("hosts", {})
        except Exception:  # noqa: BLE001
            return {}


def hermes_home_str() -> str:
    return str(_hermes_home())


def machines() -> list:
    hosts = _load_hosts()
    out = []
    for host_id, entry in hosts.items():
        out.append({"id": host_id, "host": entry.get("host") or host_id,
                    "user": entry.get("user") or os.environ.get("USER") or ""})
    return out


def start_host_mount(host_id: str, hosts: dict) -> dict:
    entry = hosts.get(host_id)
    if not entry:
        raise RuntimeError(f"unknown host '{host_id}'")
    user = entry.get("user") or os.environ.get("USER") or ""
    ws = {"id": f"{host_id}-host", "provider": "ssh", "host": host_id, "root": f"/home/{user}"}
    return start_mount(f"{host_id}-host", ws, hosts)
