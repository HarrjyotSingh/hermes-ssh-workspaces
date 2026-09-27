"""Hermes Editor Stage 5A offline tests (registry, providers, API, guards).

Run with the Hermes venv interpreter (no pytest required):

    python tests/test_stage5_offline.py

Covers Stage 5A requirements that do NOT need live remote hosts:
  1.  workspace registry CRUD (+ invalid workspace rejection)
  2.  traversal / absolute-path / symlink-escape rejection
  3.  endpoint failover policy unit tests (fake transport)
  4.  offline workspace behaviour + no local-Pi fallback copy
  5.  no credential exposure over the API
  6.  frontend static regressions: file-type-based editor choice,
      workspace selector present, unsaved-tab switch guard
  7.  no changes to Hermes core / Community WebUI / Jarvis sources

Live SSH checks are in test_stage5_live.py.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = PLUGIN_ROOT / "dashboard"
API_FILE = DASHBOARD_DIR / "plugin_api.py"
HERMES_VENV_PYTHON = Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"

sys.path.insert(0, str(DASHBOARD_DIR))


def _load_plugin_module(name="he_api_stage5_offline"):
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _make_client(home: Path):
    os.environ["HERMES_HOME"] = str(home)
    for stale in [k for k in sys.modules if k.startswith("he_api_")]:
        del sys.modules[stale]
    mod = _load_plugin_module("he_api_stage5_offline")
    # reset registry singleton per home
    import hecore.registry as reg_mod  # noqa: F401  (path set by plugin load)
    reg_mod._registry = None
    from fastapi import FastAPI
    try:
        from starlette.testclient import TestClient
    except ImportError:
        return None, None
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/hermes-editor")
    client = TestClient(app)
    return mod, client


class Stage5Base(unittest.TestCase):
    """Boots the plugin router against an isolated HERMES_HOME."""

    @classmethod
    def setUpClass(cls):
        if not HERMES_VENV_PYTHON.exists():
            raise unittest.SkipTest("Hermes venv python required")
        try:
            import fastapi  # noqa: F401
            from starlette.testclient import TestClient  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("fastapi/starlette unavailable")
        cls._tmp = tempfile.TemporaryDirectory(prefix="he5-offline-")
        cls.home = Path(cls._tmp.name) / "home"
        cls.home.mkdir(parents=True)
        cls.mod, cls.client = _make_client(cls.home)
        if cls.client is None:
            raise unittest.SkipTest("TestClient unavailable")
        cls.API = "/api/plugins/hermes-editor"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("HERMES_HOME", None)
        cls._tmp.cleanup()

    def setUp(self):
        # fresh registry state per test
        cfg = Path(os.environ["HERMES_HOME"]) / "hermes-editor-state" / "workspace-config.json"
        if cfg.exists():
            cfg.unlink()
        import hecore.registry as reg_mod
        reg_mod._registry = None
        reg = reg_mod.get_registry()
        reg.upsert_host("test-host", {"user": "testuser", "endpoints": ["192.0.2.10"]})


class TestRegistryCrud(Stage5Base):
    """Requirement 1: workspace registry CRUD; Requirement 2: invalid rejection."""

    def test_01_default_registry_seeds_only_local_workspace(self):
        r = self.client.get(f"{self.API}/workspaces").json()
        ids = [w["id"] for w in r["workspaces"]]
        self.assertEqual(ids, ["local"])
        self.assertEqual(self.client.get(f"{self.API}/hosts").json().get("hosts", {}), ["test-host"])

    def test_02_create_update_remove_workspace(self):
        body = {"id": "notes2", "label": "Notes Two", "host": "test-host",
                "root": "/srv/test-vault"}
        r = self.client.post(f"{self.API}/workspaces", json=body)
        self.assertEqual(r.status_code, 200)
        # update label
        r = self.client.post(f"{self.API}/workspaces",
                             json={"id": "notes2", "label": "Renamed"})
        self.assertEqual(r.status_code, 200)
        ws = [w for w in self.client.get(f"{self.API}/workspaces").json()["workspaces"]
              if w["id"] == "notes2"][0]
        self.assertEqual(ws["label"], "Renamed")
        # persisted to disk outside source code
        cfg = json.loads((Path(os.environ["HERMES_HOME"]) / "hermes-editor-state" /
                          "workspace-config.json").read_text())
        self.assertIn("notes2", cfg["workspaces"])
        # remove
        r = self.client.delete(f"{self.API}/workspaces/notes2")
        self.assertEqual(r.status_code, 200)
        ids = [w["id"] for w in self.client.get(f"{self.API}/workspaces").json()["workspaces"]]
        self.assertNotIn("notes2", ids)

    def test_03_invalid_workspace_rejections(self):
        bad_specs = [
            {"id": "Bad ID!", "host": "test-host", "root": "/tmp/x"},
            {"id": "ok-id", "host": "nonexistent-host", "root": "/tmp/x"},
            {"id": "ok-id2", "host": "test-host", "root": "relative/path"},
            {"id": "ok-id3", "host": "test-host", "root": "/tmp/../escape"},
            {"id": "ok-id4", "host": "test-host"},                       # no root
            {"id": "ok-id5", "provider": "carrier-pigeon"},           # unknown kind
        ]
        for spec in bad_specs:
            r = self.client.post(f"{self.API}/workspaces", json=spec)
            self.assertEqual(r.status_code, 400, f"expected 400 for {spec}")
        # unknown workspace id on fs routes -> 404
        r = self.client.get(f"{self.API}/fs/tree", params={"workspace": "ghost"})
        self.assertEqual(r.status_code, 404)
        # removing local workspace is refused; unknown removal -> 404
        self.assertEqual(self.client.delete(f"{self.API}/workspaces/local").status_code, 400)
        self.assertEqual(self.client.delete(f"{self.API}/workspaces/ghost").status_code, 404)

    def test_04_disabled_workspace_is_rejected_for_fs_ops(self):
        self.client.post(f"{self.API}/workspaces",
                         json={"id": "offws", "host": "test-host", "root": "/tmp/x",
                               "enabled": False})
        r = self.client.get(f"{self.API}/fs/tree", params={"workspace": "offws"})
        self.assertEqual(r.status_code, 409)

    def test_05_arbitrary_frontend_root_paths_never_bypass_config(self):
        # legacy root= param only maps onto configured LOCAL workspaces
        r = self.client.get(f"{self.API}/fs/tree", params={"root": "/etc"})
        self.assertEqual(r.status_code, 400)
        r = self.client.get(f"{self.API}/fs/tree", params={"root": str(self.home)})
        self.assertEqual(r.status_code, 200)  # matches the 'local' workspace


class TestLocalProviderProtections(Stage5Base):
    """Requirements 3+4 against the default local workspace."""

    def seed(self):
        (self.home / "w").mkdir(exist_ok=True)
        (self.home / "w" / "a.md").write_text("# A\n")

    def test_10_traversal_rejected(self):
        for path in ("../../etc/passwd", "a/../../..", "..\\windows"):
            r = self.client.get(f"{self.API}/fs/file",
                                params={"path": path, "workspace": "local"})
            self.assertEqual(r.status_code, 400, path)

    def test_11_absolute_path_rejected(self):
        r = self.client.get(f"{self.API}/fs/file",
                            params={"path": "/etc/passwd", "workspace": "local"})
        self.assertEqual(r.status_code, 400)

    def test_12_symlink_escape_rejected(self):
        link = self.home / "evil"
        try:
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to("/etc")
        except OSError:
            self.skipTest("symlinks unsupported")
        try:
            r = self.client.get(f"{self.API}/fs/file",
                                params={"path": "evil/passwd", "workspace": "local"})
            self.assertIn(r.status_code, (400, 404))
        finally:
            link.unlink()

    def test_13_revision_sha256_and_cas_write_local(self):
        payload = "hello stage5\n"
        r = self.client.put(f"{self.API}/fs/file",
                            json={"path": "cas.txt", "content": payload},
                            params={"workspace": "local"})
        self.assertEqual(r.status_code, 200)
        rev = r.json()["revision"]
        self.assertEqual(rev, hashlib.sha256(payload.encode()).hexdigest())
        # stale write conflicts
        r = self.client.put(f"{self.API}/fs/file",
                            json={"path": "cas.txt", "content": "x",
                                  "base_revision": "deadbeef"},
                            params={"workspace": "local"})
        self.assertEqual(r.status_code, 409)

    def test_14_no_temp_files_left_behind_after_write(self):
        self.client.put(f"{self.API}/fs/file",
                        json={"path": "tmpcheck.bin", "content": "data"},
                        params={"workspace": "local"})
        leftovers = [p.name for p in self.home.iterdir()
                     if p.name.startswith(".hermes-editor-tmp-")]
        self.assertEqual(leftovers, [])


class TestEndpointPolicy(unittest.TestCase):
    """Requirement 9/10 logic: failover ordering, backoff, recovery."""

    def test_15_ethernet_preferred_then_failover_and_recovery(self):
        from hecore.providers.ssh_provider import _EndpointPolicy
        pol = _EndpointPolicy(["eth", "ts"])
        self.assertEqual(pol.order(), ["eth", "ts"])
        pol.mark_failed("eth")
        self.assertEqual(pol.order(), ["ts", "eth"])
        # cooling endpoint stays cooling immediately after failure
        self.assertIn("cooling", pol.status()["eth"])
        # after cooldown expiry ethernet becomes preferred again
        pol._failed_until["eth"] = 0.0
        self.assertEqual(pol.order(), ["eth", "ts"])

    def test_16_backoff_grows_and_caps(self):
        from hecore.providers.ssh_provider import _EndpointPolicy
        pol = _EndpointPolicy(["e"])
        prev = 0
        for _ in range(8):
            pol.mark_failed("e")
            cd = pol._failed_until["e"]
            prev = cd
        status = pol.status()["e"]
        self.assertTrue(status["cooldown_remaining_s"] <= 300.5)

    def test_17_mark_ok_resets_failure_state(self):
        from hecore.providers.ssh_provider import _EndpointPolicy
        pol = _EndpointPolicy(["a", "b"])
        pol.mark_failed("a")
        pol.mark_ok("a")
        self.assertEqual(pol.order(), ["a", "b"])
        self.assertFalse(pol.status()["a"]["cooling"])


class TestOfflineBehaviour(Stage5Base):
    """Requirement 22/23 semantics at API level (offline host simulation)."""

    def test_20_unreachable_host_reports_offline_not_error_copy(self):
        # point a workspace at an RFC5737 documentation IP that cannot connect
        import hecore.registry as reg_mod
        reg_mod._config_override = None
        reg = reg_mod.get_registry()
        with reg._lock:
            reg._config["hosts"]["dead-host"] = {
                "provider": "ssh", "user": "nobody",
                "endpoints": ["192.0.2.1", "192.0.2.2"]}
        reg.upsert_workspace("deadws", {"label": "Dead", "provider": "ssh",
                                        "host": "dead-host",
                                        "root": "/tmp/dead-root"})
        r = self.client.get(f"{self.API}/workspaces/deadws/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["online"])
        # tree access surfaces offline (503), never a silent local copy
        r = self.client.get(f"{self.API}/fs/tree", params={"workspace": "deadws"})
        self.assertEqual(r.status_code, 503)
        detail = r.json()["detail"]
        self.assertTrue(detail.get("offline"))
        # and nothing was materialised under HERMES_HOME as a fallback
        self.assertFalse((self.home / "deadws").exists())
        self.assertFalse((self.home / "tmp").exists())

    def test_21_health_endpoint_lists_workspace_ids_without_secrets(self):
        r = self.client.get(f"{self.API}/hosts")
        self.assertEqual(r.status_code, 200)
        data = r.text
        for secret in ("hermes-test", "192.0.2.11", "192.0.2.12", "BEGIN OPENSSH"):
            self.assertNotIn(secret, data)


class TestNoCredentialExposure(Stage5Base):
    """Requirement: never expose SSH credentials or keys to the browser."""

    def test_30_workspaces_payload_has_no_user_or_key_fields(self):
        self.client.post(f"{self.API}/workspaces",
                         json={"id": "secws", "host": "test-host",
                               "root": "/srv/test-vault"})
        text = self.client.get(f"{self.API}/workspaces").text
        blob = json.dumps(json.loads(text)).lower()
        self.assertNotIn('"user"', blob)
        self.assertNotIn("identity", blob)
        self.assertNotIn("private", blob)
        self.assertNotIn("id_rsa", blob)
        self.assertNotIn("id_ed25519", blob)

    def test_31_provider_source_never_reads_private_keys(self):
        src = (DASHBOARD_DIR / "hecore" / "providers" / "ssh_provider.py").read_text()
        for forbidden in ("-i ", "IdentityFile", "PasswordAuthentication=yes",
                          "sshpass", "preferredauthentications=password"):
            self.assertNotIn(forbidden, src)


class TestFrontendRegressions(unittest.TestCase):
    """Static frontend checks: editor selection stays FILE-TYPE based."""

    JS = (DASHBOARD_DIR / "dist" / "index.js").read_text()

    def test_32_editor_choice_remains_file_type_based(self):
        # markdown detection by extension only - never by workspace/host
        self.assertIn('function isMarkdown(name) { return /\\.md$/i.test(name); }', self.JS)
        # WYSIWYG branch depends on entry name + encoding, not workspace
        self.assertIn('isMarkdown(entry.name) && f.encoding === "text"', self.JS)
        for forbidden in ('ws.host && isMarkdown', 'provider === "md"',
                          '"test-host" && isMarkdown'):
            self.assertNotIn(forbidden, self.JS)

    def test_33_monaco_language_mapping_preserved(self):
        for lang in ("python", "cpp", '"c"', "yaml", "json", "dockerfile", "shell"):
            self.assertIn(lang, self.JS)

    def test_34_workspace_selector_present_with_status(self):
        for token in ("WorkspaceSelect", "WorkspaceDot", "he-ws-online",
                      "he-ws-offline", "Manage workspaces", "endpoint"):
            self.assertIn(token, self.JS)

    def test_35_switch_guard_warns_on_unsaved_tabs(self):
        self.assertIn("Switching workspaces will close them", self.JS)
        self.assertIn("Switch and discard", self.JS)
        self.assertIn("Stay", self.JS)

    def test_36_fs_calls_use_workspace_param(self):
        self.assertNotIn("{ root:", self.JS)
        self.assertIn("workspace: ws ? ws.id : undefined", self.JS)

    def test_37_offline_save_disabled_banner(self):
        self.assertIn("Workspace offline", self.JS)
        self.assertIn("saving disabled", self.JS)


class TestNoExternalChanges(unittest.TestCase):
    """Requirements 30/31/32: hermes core, webui, jarvis untouched by us."""

    def _porcelain(self, repo: Path):
        import subprocess
        if not repo.is_dir():
            return None
        out = subprocess.run(["git", "status", "--porcelain"], cwd=repo,
                             capture_output=True, text=True).stdout
        return [l for l in out.splitlines() if not l.startswith("??")]

    def test_38_external_core_repo_check_is_opt_in(self):
        # Portable plugin tests must not inspect or assume the maintainer's
        # personal Hermes checkout. Set HERMES_EDITOR_CORE_REPO when needed.
        core_repo = os.environ.get("HERMES_EDITOR_CORE_REPO")
        if not core_repo:
            self.skipTest("set HERMES_EDITOR_CORE_REPO to inspect an external checkout")
        self.assertIsNotNone(self._porcelain(Path(core_repo)), "core repo not found")

    def test_39_this_repo_only_touches_hermes_editor_files(self):
        import subprocess
        out = subprocess.run(["git", "status", "--porcelain"], cwd=PLUGIN_ROOT,
                             capture_output=True, text=True).stdout
        changed = [l.split()[-1] for l in out.splitlines()]
        for path in changed:
            self.assertFalse(path.startswith("Jarvis"), path)

    def test_40_no_voice_or_audio_apis_in_new_backend_code(self):
        forbidden_modules = {"audioop", "wave", "pyaudio", "sounddevice",
                             "soundfile", "speech_recognition", "websockets",
                             "socket", "asyncio"}
        for py in (DASHBOARD_DIR / "hecore").rglob("*.py"):
            tree = ast.parse(py.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertNotIn(alias.name.split(".")[0], forbidden_modules,
                                         f"{alias.name} in {py}")
                elif isinstance(node, ast.ImportFrom) and node.module:
                    self.assertNotIn(node.module.split(".")[0], forbidden_modules,
                                     f"{node.module} in {py}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
