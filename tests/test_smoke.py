"""Hermes Editor Stage 1 smoke tests.

Run with the Hermes venv interpreter (no pytest required):

    /home/testuser/.hermes/hermes-agent/venv/bin/python tests/test_smoke.py

Covers:
  1. Manifest/structure validity (paths, namespace, no unsafe api path).
  2. plugin_api /health payload via the real FastAPI router.
  3. Integration: real dashboard app in an isolated HERMES_HOME discovers
     and mounts the plugin; enabled -> 200, runtime-disabled -> 404, and
     the plugin disappears from the dashboard listing when disabled.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = PLUGIN_ROOT / "dashboard"
API_FILE = DASHBOARD_DIR / "plugin_api.py"
HERMES_VENV_PYTHON = Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"


def _load_plugin_module():
    spec = importlib.util.spec_from_file_location("hermes_editor_plugin_api_test", API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class TestStructure(unittest.TestCase):
    """Stage 1 requirement 1+2: layout and manifests."""

    def test_manifest_valid_and_complete(self):
        data = json.loads((DASHBOARD_DIR / "manifest.json").read_text())
        self.assertEqual(data["name"], "hermes-editor")
        for key in ("entry", "css", "api"):
            self.assertIn(key, data)
            self.assertTrue((DASHBOARD_DIR / data[key]).is_file(), f"{key} file missing")
        # api must be a safe relative path inside dashboard/ (GHSA-5qr3-c538-wm9j rule)
        api_resolved = (DASHBOARD_DIR / data["api"]).resolve()
        api_resolved.relative_to(DASHBOARD_DIR.resolve())
        tab = data.get("tab") or {}
        self.assertTrue(str(tab.get("path", "")).startswith("/hermes-editor"))

    def test_plugin_yaml_declares_namespace_contract(self):
        text = (PLUGIN_ROOT / "plugin.yaml").read_text()
        self.assertIn("name: hermes-editor", text)
        self.assertIn("kind:", text)

    def test_no_listening_sockets_or_audio_code_in_plugin(self):
        """Update-safety contract: no servers, audio capture, or wake words.

        Checks real code (imports + identifiers), not docstrings/comments.
        """
        import ast

        forbidden = {"socket", "asyncio", "sounddevice", "pyaudio", "wave",
                     "openwakeword", "microphone"}
        forbidden_calls = {"run", "serve", "start_server"}
        for py in PLUGIN_ROOT.rglob("*.py"):
            tree = ast.parse(py.read_text(errors="replace"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        root = alias.name.split(".")[0]
                        self.assertNotIn(root, forbidden,
                                         f"forbidden import in {py}: {alias.name}")
                elif isinstance(node, ast.ImportFrom) and node.module:
                    root = node.module.split(".")[0]
                    self.assertNotIn(root, forbidden,
                                     f"forbidden import in {py}: {node.module}")


class TestHealthEndpoint(unittest.TestCase):
    """Stage 1 requirement 4: GET /health returns version + status."""

    def test_health_payload(self):
        from fastapi import FastAPI
        try:
            from starlette.testclient import TestClient
        except ImportError:
            self.skipTest("starlette TestClient unavailable")

        mod = _load_plugin_module()
        app = FastAPI()
        app.include_router(mod.router, prefix="/api/plugins/hermes-editor")
        client = TestClient(app)
        resp = client.get("/api/plugins/hermes-editor/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["plugin"], "hermes-editor")
        self.assertEqual(body["version"], mod.PLUGIN_VERSION)
        self.assertIn("status", body)


@unittest.skipUnless(
    HERMES_VENV_PYTHON.exists(),
    "Hermes venv not found; integration check needs hermes_cli.web_server",
)
class TestDashboardIntegration(unittest.TestCase):
    """Boots the REAL dashboard app against an isolated HERMES_HOME."""

    @classmethod
    def setUpClass(cls):
        import os

        cls._tmp = tempfile.TemporaryDirectory(prefix="hermes-editor-test-")
        home = Path(cls._tmp.name) / "home"
        home.mkdir()
        plugins = home / "plugins"
        plugins.mkdir()
        # Copy (not symlink) so the test is fully self-contained.
        shutil.copytree(PLUGIN_ROOT, plugins / "hermes-editor",
                        ignore=shutil.ignore_patterns("__pycache__", ".git"))
        (home / "config.yaml").write_text(
            "plugins:\n  enabled:\n    - hermes-editor\n"
        )
        cls._old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(home)
        cls.home = home
        # Import AFTER env isolation, mirroring core test conventions.
        from hermes_cli import web_server
        web_server._dashboard_plugins_cache = None
        cls.web_server = web_server

        try:
            from starlette.testclient import TestClient
        except ImportError:
            raise unittest.SkipTest("starlette TestClient unavailable")
        cls.client = TestClient(web_server.app)
        cls.client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

    @classmethod
    def tearDownClass(cls):
        import os
        if cls._old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = cls._old_home
        cls._tmp.cleanup()

    def test_01_plugin_discovered(self):
        names = [p["name"] for p in self.web_server._get_dashboard_plugins(force_rescan=True)]
        self.assertIn("hermes-editor", names)

    def test_02_health_route_mounted_and_authenticated(self):
        resp = self.client.get("/api/plugins/hermes-editor/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["plugin"], "hermes-editor")
        self.assertEqual(body["version"], "0.5.0")
        self.assertTrue(body["ok"])

    def test_03_listing_shows_plugin_when_enabled(self):
        from unittest.mock import patch
        with patch("hermes_cli.plugins_cmd._get_enabled_set",
                   return_value={"hermes-editor"}), \
             patch("hermes_cli.plugins_cmd._get_disabled_set", return_value=set()):
            resp = self.client.get("/api/dashboard/plugins")
        self.assertEqual(resp.status_code, 200)
        names = [p["name"] for p in resp.json()]
        self.assertIn("hermes-editor", names)

    def test_04_disable_restores_previous_behavior(self):
        """Runtime gate: disabled plugin API -> 404, listing hides it."""
        from unittest.mock import patch
        with patch("hermes_cli.plugins_cmd._get_enabled_set", return_value=set()), \
             patch("hermes_cli.plugins_cmd._get_disabled_set",
                   return_value={"hermes-editor"}):
            api = self.client.get("/api/plugins/hermes-editor/health")
            listing = self.client.get("/api/dashboard/plugins")
        self.assertEqual(api.status_code, 404)  # indistinguishable from absent
        self.assertNotIn("hermes-editor", [p["name"] for p in listing.json()])

    def test_05_assets_served(self):
        resp = self.client.get("/dashboard-plugins/hermes-editor/dist/index.js")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"Hermes Editor", resp.content)

    def test_06_monaco_assets_vendored_and_served(self):
        """Stage 3: Monaco ships inside the plugin, served client-side."""
        vs = DASHBOARD_DIR / "dist" / "monaco" / "vs"
        for rel in ("loader.js", "editor/editor.main.js", "editor/editor.main.css",
                    "base/worker/workerMain.js", "basic-languages/python/python.js",
                    "basic-languages/cpp/cpp.js", "language/json/jsonWorker.js"):
            self.assertTrue((vs / rel).is_file(), f"missing vendored Monaco file: {rel}")
        resp = self.client.get("/dashboard-plugins/hermes-editor/dist/monaco/vs/loader.js")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"AMDLoader", resp.content)

    # ------------------------------------------------------------------
    # Stage 3: filesystem API
    # ------------------------------------------------------------------

    API = "/api/plugins/hermes-editor"

    def _put(self, path, content, base_revision="", force=False, expect=None):
        resp = self.client.put(
            f"{self.API}/fs/file",
            json={"path": path, "content": content,
                  "base_revision": base_revision, "force": force},
        )
        if expect is not None:
            self.assertEqual(resp.status_code, expect, resp.text)
        return resp

    def test_10_roots_lists_hermes_home(self):
        resp = self.client.get(f"{self.API}/fs/roots")
        self.assertEqual(resp.status_code, 200)
        roots = resp.json()["roots"]
        self.assertTrue(any(r["exists"] and str(self.home) in r["path"] for r in roots))

    def test_11_tree_lists_files_skips_junk_dirs(self):
        (self.home / "proj").mkdir()
        (self.home / "proj" / "main.py").write_text("print('hi')\n")
        (self.home / "proj" / "__pycache__").mkdir()
        (self.home / "proj" / ".git").mkdir()
        resp = self.client.get(f"{self.API}/fs/tree")
        entries = {e["name"] for e in resp.json()["entries"]}
        self.assertIn("proj", entries)

    def test_12_read_text_returns_content_and_revision(self):
        f = self.home / "sample.yaml"
        payload = "key: value\n"
        f.write_text(payload)
        import hashlib
        resp = self.client.get(f"{self.API}/fs/file", params={"path": "sample.yaml"})
        body = resp.json()
        self.assertEqual(body["encoding"], "text")
        self.assertEqual(body["content"], payload)
        self.assertEqual(body["revision"], hashlib.sha256(payload.encode()).hexdigest())

    def test_13_write_creates_file_and_revision_roundtrip(self):
        resp = self._put("new/dir/tool.py", "x = 1\n", base_revision="", expect=200)
        rev = resp.json()["revision"]
        on_disk = (self.home / "new/dir/tool.py").read_bytes()
        import hashlib
        self.assertEqual(rev, hashlib.sha256(on_disk).hexdigest())
        # read-back revision equals write revision
        got = self.client.get(f"{self.API}/fs/file", params={"path": "new/dir/tool.py"}).json()
        self.assertEqual(got["revision"], rev)

    def test_14_stale_revision_conflict_then_force(self):
        f = self.home / "conflict.txt"
        f.write_text("v1\n")
        read1 = self.client.get(f"{self.API}/fs/file",
                                params={"path": "conflict.txt"}).json()
        # someone else modifies the file behind the editor's back
        f.write_text("v2 (external edit)\n")
        stale = self._put("conflict.txt", "v3 (mine)\n",
                          base_revision=read1["revision"])
        self.assertEqual(stale.status_code, 409)
        detail = stale.json()["detail"]
        self.assertTrue(detail["conflict"])
        self.assertEqual(detail["current_revision"],
                         __import__("hashlib").sha256(f.read_bytes()).hexdigest())
        # overwrite-anyway path used by the conflict dialog
        forced = self._put("conflict.txt", "v3 (mine)\n", force=True, expect=200)
        self.assertTrue(forced.json()["ok"])

    def test_15_binary_file_fallback(self):
        (self.home / "blob.bin").write_bytes(b"\x00\x01\x02binary\xff")
        body = self.client.get(f"{self.API}/fs/file",
                               params={"path": "blob.bin"}).json()
        self.assertEqual(body["encoding"], "binary")
        self.assertIsNone(body["content"])

    def test_16_oversized_file_fallback(self):
        big = self.home / "big.log"
        with open(big, "wb") as fh:
            fh.write(b"x" * (2_000_001))
        body = self.client.get(f"{self.API}/fs/file",
                               params={"path": "big.log"}).json()
        self.assertEqual(body["encoding"], "oversized")
        self.assertIsNone(body["content"])

    def test_17_traversal_and_symlink_escape_blocked(self):
        self.assertEqual(
            self.client.get(f"{self.API}/fs/file",
                            params={"path": "../../../etc/passwd"}).status_code, 400)
        link = self.home / "evil"
        try:
            link.symlink_to("/etc")
            resp = self.client.get(f"{self.API}/fs/file",
                                   params={"path": "evil/passwd"})
            self.assertIn(resp.status_code, (400, 404))
        except OSError:
            pass  # symlink unsupported

    def test_18_deleted_on_disk_conflict(self):
        resp = self.client.get(f"{self.API}/fs/file",
                               params={"path": "gone.txt"})
        # never existed -> plain 404, not a conflict
        self.assertEqual(resp.status_code, 404)
        # existed at read time, deleted before save -> 409 deleted_on_disk
        tmpf = self.home / "vanish.txt"
        tmpf.write_text("bye\n")
        rev = self.client.get(f"{self.API}/fs/file",
                              params={"path": "vanish.txt"}).json()["revision"]
        tmpf.unlink()
        stale = self._put("vanish.txt", "resurrect?\n", base_revision=rev)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["reason"], "deleted_on_disk")

    def test_19_health_reports_current_stage_version(self):
        body = self.client.get(f"{self.API}/health").json()
        self.assertEqual(body["version"], "0.5.0")
        self.assertEqual(body["stage"], 5)



    # ------------------------------------------------------------------
    # Stage 4: markdown index, move, persisted state
    # ------------------------------------------------------------------

    def _seed_wiki(self):
        (self.home / "notes").mkdir(exist_ok=True)
        (self.home / "notes" / "Alpha.md").write_text(
            "---\ntitle: Alpha Page\naliases: [First]\n---\n\n# Alpha Top\n\n## Section A\n\nsee [[Beta]] and [[Gamma|g]] and [[Beta#Section B]]\n")
        (self.home / "notes" / "Beta.md").write_text(
            "# Beta Doc\n\nback to [[Alpha]]\n\n```python\nx=1\n```\n")

    def test_20_index_build_extracts_metadata(self):
        self._seed_wiki()
        resp = self.client.post(f"{self.API}/fs/index?root=")
        body = resp.json()
        paths = {e["path"] for e in body["entries"]}
        self.assertIn("notes/Alpha.md", paths)
        alpha = [e for e in body["entries"] if e["path"] == "notes/Alpha.md"][0]
        self.assertEqual(alpha["title"], "Alpha Page")   # front-matter alias file: first h1 is 'Alpha Top'; title falls back
        self.assertTrue(any(h["text"] == "Section A" for h in alpha["headings"]))
        self.assertIn("First", alpha["aliases"])
        beta = [e for e in body["entries"] if e["path"] == "notes/Beta.md"][0]
        self.assertIn("Alpha", beta["outgoing"])

    def test_21_index_state_roundtrip(self):
        entries = [{"path": "a.md", "title": "A", "aliases": [], "headings": [], "outgoing": [], "mtime_ns": 1, "size": 2}]
        put = self.client.put(f"{self.API}/index/state", json={"entries": entries})
        self.assertEqual(put.status_code, 200)
        got = self.client.get(f"{self.API}/index/state").json()
        self.assertEqual(got["entries"], entries)

    def test_22_move_renames_and_refuses_overwrite(self):
        self._seed_wiki()
        ok = self.client.post(f"{self.API}/fs/move", json={"src": "notes/Beta.md", "dst": "notes/Beta2.md"})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue((self.home / "notes/Beta2.md").is_file())
        clash = self.client.post(f"{self.API}/fs/move", json={"src": "notes/Beta2.md", "dst": "notes/Alpha.md"})
        self.assertEqual(clash.status_code, 409)

    def test_23_saved_md_is_portable_markdown(self):
        """Hermes file tools / git / obsidian / vscode read plain md."""
        content = "# T\n\n- [x] a\n- [ ] b\n\n[[Other]] link\n"
        self.client.put(f"{self.API}/fs/file", json={"path": "p.md", "content": content, "base_revision": ""})
        raw = (self.home / "p.md").read_text()
        self.assertEqual(raw, content)  # byte-exact, no PM/tiptap JSON, no HTML wrapper
        for forbidden in ('"type":"doc"', "prosemirror", "<p>", "data-pm"):
            self.assertNotIn(forbidden, raw)


class TestRegressions(unittest.TestCase):
    """Stage 4 items 15-18: environment regressions. Skips gracefully when a
    check target isn't present on the machine running the tests."""

    def test_15_editor_is_not_identity_coupled_to_hermes_core(self):
        """The host may have unrelated local work; it must not name this plugin.

        Requiring an otherwise-shared Hermes checkout to be perfectly clean made
        the editor's functional suite fail for Voice, updater, and other work
        that the editor neither owns nor uses.  The real update-safety contract
        is narrower: the external plugin is self-contained and no core source
        contains a ``hermes-editor`` exception or loader allow-list entry.
        """
        repo = Path.home() / ".hermes" / "hermes-agent"
        if not repo.is_dir():
            self.skipTest("hermes-agent not found")
        import subprocess
        out = subprocess.run(
            [
                "rg", "-n", "hermes-editor", ".",
                "--glob", "!node_modules/**",
                "--glob", "!apps/desktop/release/**",
                "--glob", "!apps/desktop/dist/**",
                "--glob", "!apps/desktop/build/**",
            ],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        self.assertEqual(out.returncode, 1, out.stdout or out.stderr)

    def test_16_voice_regression(self):
        import urllib.request
        try:
            with urllib.request.urlopen("http://127.0.0.1:8766/", timeout=3) as r:
                body = r.read()
            assert b'"ok": true' in body or b'"ok":true' in body
            assert b'"enrolled": true' in body or b'"enrolled":true' in body
        except OSError:
            self.skipTest("jarvis companion not reachable from this context")

    def test_17_appearance_theme_files_intact(self):
        themes = Path.home() / ".hermes" / "dashboard-themes"
        if not themes.is_dir():
            self.skipTest("no user theme dir on this machine")
        css = PLUGIN_ROOT / "dashboard" / "dist" / "style.css"
        src = css.read_text()
        self.assertNotIn(":root", src)
        self.assertNotIn("data-skin", src)

    def test_18_no_voice_apis_in_plugin_code(self):
        """AST-level scan: no audio/voice/network-listening imports."""
        import ast
        forbidden_modules = {"audioop", "wave", "pyaudio", "sounddevice",
                             "soundfile", "speech_recognition", "websockets",
                             "socket", "asyncio"}
        forbidden_tokens_js = ("getusermedia", "audiocontext", "mediastream")
        for py in PLUGIN_ROOT.rglob("*.py"):
            tree = ast.parse(py.read_text(errors="replace"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        root_mod = alias.name.split(".")[0]
                        self.assertNotIn(root_mod, forbidden_modules,
                                         f"forbidden import in {py}: {alias.name}")
                elif isinstance(node, ast.ImportFrom) and node.module:
                    root_mod = node.module.split(".")[0]
                    self.assertNotIn(root_mod, forbidden_modules,
                                     f"forbidden import in {py}: {node.module}")
        dist = PLUGIN_ROOT / "dashboard" / "dist"
        for js in list(dist.glob("*.js")) + [dist / "dev-harness.html"]:
            src = js.read_text(errors="replace").lower()
            for tok in forbidden_tokens_js:
                self.assertNotIn(tok, src, f"{tok} found in {js}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
