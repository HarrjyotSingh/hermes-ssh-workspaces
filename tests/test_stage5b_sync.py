"""Hermes Editor Stage 5B offline tests (live synchronization core).

Run with the Hermes venv interpreter (no pytest required):

    /home/testuser/.hermes/hermes-agent/venv/bin/python tests/test_stage5b_sync.py -v

Covers the Stage 5B requirements that do NOT need remote hosts:
  1.  WebSocket connect/hello/disconnect (plugin-scoped /events channel)
  2.  Subscription validation (configured workspaces only; traversal,
      absolute paths and unknown/disabled workspaces are rejected)
  3.  First subscriber starts polling; final unsubscribe stops it
      (grace) and drops tracked state -> zero remote polling
  4.  External modification detected on the LOCAL workspace -> protocol
      event with revision metadata (SSH hosts covered by the live suite)
  5.  File deletion event; never recreated
  6.  Rename confidence: same-batch equal-size delete+create pairs
  7.  Multi-client fan-out (two subscribers both hear one save)
  8.  Mass-change debounce -> single git.changed + resync.required
  9.  Endpoint failover/offline/online event semantics
  10. Bounded queues degrade to resync.required, never unbounded growth
  11. /fs/revisions bounded probe (metadata + revision only)
  12. Incremental markdown index update (create/modify/delete/rename)
  13. Derived backlinks/broken-link data
  14. Event schema versioning
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = PLUGIN_ROOT / "dashboard"
API_FILE = DASHBOARD_DIR / "plugin_api.py"
HERMES_VENV_PYTHON = Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"

# Small poll interval BEFORE hecore.sync is first imported anywhere here.
os.environ["HERMES_EDITOR_SYNC_POLL_INTERVAL"] = "0.5"

sys.path.insert(0, str(DASHBOARD_DIR))


def _load_plugin_module(name="he_api_stage5b"):
    spec = importlib.util.spec_from_file_location(name, API_FILE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class SyncTestBase(unittest.TestCase):
    """Boots the plugin router against an isolated HERMES_HOME."""

    @classmethod
    def setUpClass(cls):
        if not HERMES_VENV_PYTHON.exists():
            raise unittest.SkipTest("Hermes venv python required")
        try:
            import fastapi  # noqa: F401
            from starlette.testclient import TestClient  # noqa: F401
            import anyio  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("fastapi/starlette/anyio unavailable")
        cls._tmp = tempfile.TemporaryDirectory(prefix="he5b-")
        cls.home = Path(cls._tmp.name) / "home"
        (cls.home / "wsroot").mkdir(parents=True)
        cls.mod = None
        cls.API = "/api/plugins/hermes-editor"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("HERMES_HOME", None)
        try:
            cls._tmp.cleanup()
        except OSError:
            pass

    def setUp(self):
        os.environ["HERMES_HOME"] = str(self.home)
        for stale in [k for k in sys.modules if k.startswith("he_api_")]:
            del sys.modules[stale]
        # reset singletons per test
        import hecore.registry as reg_mod
        import hecore.sync as sync_mod
        reg_mod._registry = None
        sync_mod.reset_sync_manager()
        self.mod = _load_plugin_module("he_api_stage5b")
        from fastapi import FastAPI
        from starlette.testclient import TestClient
        app = FastAPI()
        app.include_router(self.mod.router, prefix=self.API)
        self.client = TestClient(app)
        self.ws_root = self.home / "wsroot"
        # point the 'local' workspace at the scratch dir for determinism
        cfg_path = self.home / "hermes-editor-state" / "workspace-config.json"
        cfg = {
            "version": 1,
            "hosts": {},
            "workspaces": {
                "local": {"label": "Local", "provider": "local", "host": None,
                          "root": str(self.ws_root), "enabled": True,
                          "index_markdown": True},
                "offws": {"label": "Off", "provider": "ssh", "host": "server",
                          "root": "/tmp/x", "enabled": False,
                          "index_markdown": True},
            },
        }
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(json.dumps(cfg))
        reg_mod.get_registry().reload()

    def tearDown(self):
        import hecore.sync as sync_mod
        sync_mod.reset_sync_manager()

    def sync(self):
        return self.mod.get_sync_manager()

    def make_client_id(self, cid):
        return self.sync().register_client(cid)


class TestWebSocketProtocol(SyncTestBase):
    """Requirements 1+2: connect, hello, subscribe acks, disconnect."""

    def test_01_connect_hello_ping(self):
        with self.client.websocket_connect(f"{self.API}/events") as ws:
            hello = ws.receive_json()
            self.assertEqual(hello["type"], "hello")
            self.assertEqual(hello["v"], 1)
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            self.assertEqual(pong["type"], "pong")

    def test_02_client_registered_and_disconnected(self):
        with self.client.websocket_connect(f"{self.API}/events") as ws:
            ws.receive_json()
            deadline = time.time() + 2
            while self.sync().client_count() == 0 and time.time() < deadline:
                time.sleep(0.05)
            self.assertEqual(self.sync().client_count(), 1)
        deadline = time.time() + 2
        while self.sync().client_count() > 0 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.sync().client_count(), 0)

    def test_03_subscribe_ack_and_rejection(self):
        (self.ws_root / "a.txt").write_text("hello\n")
        with self.client.websocket_connect(f"{self.API}/events") as ws:
            ws.receive_json()
            ws.send_json({"type": "subscribe", "workspace": "local",
                          "path": "a.txt", "revision": ""})
            ack = ws.receive_json()
            self.assertEqual(ack["type"], "subscribed")
            self.assertTrue(ack["ok"])
            # traversal / absolute / unknown workspace rejected
            for bad in ("/etc/passwd", "../../etc/passwd", "a/../../x"):
                ws.send_json({"type": "subscribe", "workspace": "local",
                              "path": bad})
                res = ws.receive_json()
                self.assertFalse(res["ok"], bad)
            ws.send_json({"type": "subscribe", "workspace": "ghost",
                          "path": "a.txt"})
            self.assertFalse(ws.receive_json()["ok"])
            ws.send_json({"type": "subscribe", "workspace": "offws",
                          "path": "x.txt"})
            self.assertFalse(ws.receive_json()["ok"])

    def test_04_status_endpoint_reports_subscriptions(self):
        with self.client.websocket_connect(f"{self.API}/events") as ws:
            ws.receive_json()
            ws.send_json({"type": "subscribe", "workspace": "local",
                          "path": "a.txt"})
            ws.receive_json()
            deadline = time.time() + 2
            st = {}
            while time.time() < deadline:
                st = self.client.get(f"{self.API}/sync/status").json()
                if st["subscriptions"] == 1:
                    break
                time.sleep(0.05)
            self.assertEqual(st["clients"], 1)
            self.assertEqual(st["subscriptions"], 1)
            self.assertTrue(st["polling_active"])
            self.assertEqual(st["protocol"], 1)


class TestSyncCore(SyncTestBase):
    """Change detection, fan-out, debouncing, lifecycle (manager level)."""

    def test_10_first_subscriber_polls_last_disconnect_stops(self):
        mgr = self.sync()
        f = self.ws_root / "poll.txt"
        f.write_text("v1\n")
        mgr.register_client("c1")
        self.assertTrue(mgr.subscribe("c1", "local", "poll.txt"))
        self.assertTrue(mgr.status()["polling_active"])
        # baseline established by first cycle; no synthetic event
        q = mgr._clients["c1"].queue
        time.sleep(1.4)
        self.assertTrue(q.empty())
        # external modification -> exactly one modified event
        f.write_text("v2 external\n")
        ev = q.get(timeout=5)
        self.assertEqual(ev["type"], "file.modified")
        self.assertEqual(ev["workspace"], "local")
        self.assertEqual(ev["revision"],
                         hashlib.sha256(b"v2 external\n").hexdigest())
        # final disconnect -> polling flag clears after grace + state drop
        mgr.unregister_client("c1")
        mgr._last_disconnect -= 20  # age past the grace window
        time.sleep(1.6)
        self.assertFalse(mgr.status()["polling_active"])
        self.assertEqual(mgr._known, {})   # tracked revisions dropped
        self.assertEqual(mgr._ws_state, {})

    def test_11_no_clients_means_zero_provider_calls(self):
        from hecore.sync import SyncManager

        calls = {"n": 0}

        class FakeProv:
            def stat_many(self, rels, with_revision=False):
                calls["n"] += 1
                return []

            def read(self, rel):
                raise AssertionError("should not read")

        class FakeReg:
            def get_workspace(self, wid):
                return {"id": wid, "enabled": True}

        mgr = SyncManager(FakeReg(), lambda wid: FakeProv(), poll_interval=0.2)
        mgr.register_client("cx")
        mgr.subscribe("cx", "w", "f.txt")
        time.sleep(0.7)          # at least one cycle with a client
        self.assertGreaterEqual(calls["n"], 1)
        n_with_client = calls["n"]
        mgr.unregister_client("cx")
        time.sleep(0.8)
        self.assertEqual(calls["n"], n_with_client)   # zero further polls
        mgr.shutdown()

    def test_12_deletion_event(self):
        mgr = self.sync()
        f = self.ws_root / "doomed.txt"
        f.write_text("bye\n")
        mgr.register_client("c1")
        mgr.subscribe("c1", "local", "doomed.txt")
        time.sleep(1.2)                       # baseline
        f.unlink()
        ev = mgr._clients["c1"].queue.get(timeout=5)
        self.assertEqual(ev["type"], "file.deleted")
        self.assertEqual(ev["path"], "doomed.txt")

    def test_13_two_clients_both_hear_api_save(self):
        mgr = self.sync()
        ca = mgr.register_client("client-a")
        cb = mgr.register_client("client-b")
        # subscribe to a not-yet-existing path; first poll records the
        # baseline (nonexistent) without emitting anything
        self.assertTrue(mgr.subscribe("client-a", "local", "shared.md"))
        self.assertTrue(mgr.subscribe("client-b", "local", "shared.md"))
        time.sleep(1.2)
        r = self.client.put(
            f"{self.API}/fs/file",
            json={"path": "shared.md", "content": "# shared v2\n"},
            params={"workspace": "local"})
        self.assertEqual(r.status_code, 200)
        ea = ca.queue.get(timeout=5)
        eb = cb.queue.get(timeout=5)
        for ev in (ea, eb):
            # baseline was "missing" so this save is the file's creation
            self.assertEqual(ev["type"], "file.created")
            self.assertEqual(ev["revision"],
                             hashlib.sha256(b"# shared v2\n").hexdigest())
            self._assert_schema(ev)

    def test_14_mass_change_debounces_to_git_changed(self):
        mgr = self.sync()
        for i in range(6):
            (self.ws_root / f"burst{i}.txt").write_text("x\n")
        mgr.register_client("c1")
        for i in range(6):
            mgr.subscribe("c1", "local", f"burst{i}.txt")
        time.sleep(1.2)
        q = mgr._clients["c1"].queue
        # mass external modification (checkout/reset simulation)
        for i in range(6):
            (self.ws_root / f"burst{i}.txt").write_text(f"changed {i}\n")
        kinds = [q.get(timeout=5)["type"] for _ in range(2)]
        self.assertIn("git.changed", kinds)
        self.assertIn("resync.required", kinds)
        self.assertTrue(q.empty())     # individual events suppressed

    def test_15_burst_register_threshold(self):
        mgr = self.sync()
        self.assertFalse(mgr._register_burst("w", 2)[0])
        self.assertFalse(mgr._register_burst("w", 2)[0])
        started, total = mgr._register_burst("w", 2)   # 6 >= threshold(5)
        self.assertTrue(started)
        self.assertEqual(total, 6)

    def test_16_rename_pairs_only_confident_matches(self):
        pair = SyncTestBaseHelpers.pair([{"path": "new.md", "size": 10}],
                                        [{"path": "old.md", "size": 10}])
        self.assertEqual(pair, [("old.md", "new.md")])
        none = SyncTestBaseHelpers.pair([{"path": "new.md", "size": 99}],
                                        [{"path": "old.md", "size": 10}])
        self.assertEqual(none, [])

    def test_17_queue_overflow_degrades_to_resync(self):
        mgr = self.sync()
        slow = mgr.register_client("slow", maxsize=2)
        for i in range(10):
            mgr.emit(None, {"type": "file.modified", "workspace": "w",
                            "path": f"p{i}.txt"})
        got = []
        while not slow.queue.empty():
            got.append(slow.queue.get_nowait())
        self.assertLess(len(got), 10)
        self.assertTrue(any(g["type"] == "resync.required" and
                            g.get("reason") == "queue_overflow" for g in got))

    def test_18_offline_online_and_endpoint_events(self):
        mgr = self.sync()
        c = mgr.register_client("c1")
        wid = "somews"
        mgr._subs[wid] = {"a.txt": {"c1"}}     # ensure fan-out targets exist
        mgr._mark_offline(wid)
        ev = c.queue.get(timeout=5)
        self.assertEqual(ev["type"], "workspace.offline")
        mgr._mark_online(wid, endpoint="100.x", previous_endpoint=None)
        online = c.queue.get(timeout=5)
        self.assertEqual(online["type"], "workspace.online")
        resync = c.queue.get(timeout=5)
        self.assertEqual(resync["type"], "resync.required")
        mgr._mark_online(wid, endpoint="10.y", previous_endpoint="100.x")
        ep = c.queue.get(timeout=5)
        self.assertEqual(ep["type"], "endpoint.changed")
        self.assertEqual(ep["endpoint"], "10.y")
        rs2 = c.queue.get(timeout=5)
        self.assertEqual(rs2["type"], "resync.required")

    def _assert_schema(self, ev):
        self.assertEqual(ev["v"], 1)
        self.assertIn(ev["type"], {
            "hello", "file.created", "file.modified", "file.deleted",
            "file.renamed", "workspace.online", "workspace.offline",
            "endpoint.changed", "git.changed", "resync.required", "pong"})
        self.assertIsInstance(ev["timestamp"], int)


class SyncTestBaseHelpers:
    @staticmethod
    def pair(created, deleted):
        from hecore.sync import SyncManager
        created = [dict(c) for c in created]
        deleted = [dict(d) for d in deleted]
        return SyncManager._pair_renames(created, deleted)


class TestRevisionsEndpoint(SyncTestBase):
    """Requirement 12 backend half: bounded OPEN-file revision probing."""

    def test_20_revisions_metadata_only_with_hash(self):
        payload = "rev probe\n"
        (self.ws_root / "probe.txt").write_text(payload)
        want = hashlib.sha256(payload.encode()).hexdigest()
        r = self.client.get(f"{self.API}/fs/revisions",
                            params={"paths": "probe.txt,missing.txt",
                                    "workspace": "local"})
        self.assertEqual(r.status_code, 200)
        stats = {s["path"]: s for s in r.json()["stats"]}
        self.assertTrue(stats["probe.txt"]["exists"])
        self.assertEqual(stats["probe.txt"]["revision"], want)
        self.assertFalse(stats["missing.txt"]["exists"])
        blob = json.dumps(r.json())
        self.assertNotIn("content", blob.split("revision")[0])

    def test_21_revisions_rejects_bad_input(self):
        r = self.client.get(f"{self.API}/fs/revisions",
                            params={"paths": "", "workspace": "local"})
        self.assertEqual(r.status_code, 400)
        r = self.client.get(f"{self.API}/fs/revisions",
                            params={"paths": "x.txt", "workspace": "ghost"})
        self.assertEqual(r.status_code, 404)


class TestIncrementalIndex(SyncTestBase):
    """Requirement: incremental wikilink/index updates (no full rescans)."""

    def seed_index(self):
        (self.ws_root / "Alpha.md").write_text("# Alpha\n\nsee [[Beta]]\n")
        entries = [{
            "path": "Alpha.md", "title": "Alpha",
            "aliases": [], "headings": [{"level": 1, "text": "Alpha"}],
            "outgoing": ["Beta"], "size": 20, "mtime_ns": 1,
        }]
        r = self.client.put(f"{self.API}/index/state",
                            json={"entries": entries},
                            params={"workspace": "local"})
        self.assertEqual(r.status_code, 200)
        return entries

    def get_entries(self):
        return self.client.get(f"{self.API}/index/state",
                               params={"workspace": "local"}).json()["entries"]

    def test_30_create_updates_index_incrementally(self):
        self.seed_index()
        text = ("---\ntitle: Beta Page\n---\n\n# Beta Top\n\nlinks [[Alpha]]\n")
        r = self.client.put(f"{self.API}/fs/file",
                            json={"path": "docs/Beta.md", "content": text},
                            params={"workspace": "local"})
        self.assertEqual(r.status_code, 200)
        entries = self.get_entries()
        beta = [e for e in entries if e["path"] == "docs/Beta.md"]
        self.assertEqual(len(beta), 1)
        self.assertEqual(beta[0]["title"], "Beta Page")
        self.assertIn("Alpha", beta[0]["outgoing"])
        alpha = entries[0] if entries[0]["path"] == "Alpha.md" else entries[1]
        self.assertEqual(alpha["outgoing"], ["Beta"])   # untouched entry intact

    def test_31_delete_removes_entry(self):
        self.seed_index()
        r = self.client.post(f"{self.API}/fs/delete",
                             json={"path": "Alpha.md"},
                             params={"workspace": "local"})
        self.assertEqual(r.status_code, 200)
        entries = self.get_entries()
        self.assertEqual([e for e in entries if e["path"] == "Alpha.md"], [])

    def test_32_rename_repaths_entry_without_rescan(self):
        self.seed_index()
        r = self.client.post(f"{self.API}/fs/move",
                             json={"from": "Alpha.md", "to": "Zeta.md"},
                             params={"workspace": "local"})
        self.assertEqual(r.status_code, 200)
        entries = self.get_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["path"], "Zeta.md")
        self.assertEqual(entries[0]["outgoing"], ["Beta"])  # metadata preserved

    def test_33_backlinks_derived_and_broken_links_visible(self):
        from hecore.index_store import backlinks_for
        entries = [
            {"path": "A.md", "outgoing": ["B"]},
            {"path": "C.md", "outgoing": ["Ghost"]},
            {"path": "B.md", "outgoing": []},
        ]
        self.assertEqual(backlinks_for(entries, "B.md"), ["A.md"])
        # broken-link state is DERIVED from outgoing targets vs existing
        # notes (same stem resolution the frontend uses for [[wikilinks]])
        def resolve(target):
            tl = target.lower()
            for e in entries:
                p = e["path"].lower()
                if p == tl or p[:-3] == tl or \
                        p.rsplit("/", 1)[-1][:-3] == tl.rsplit("/", 1)[-1]:
                    return e
            return None
        broken = [t for e in entries for t in e["outgoing"]
                  if resolve(t) is None]
        self.assertEqual(broken, ["Ghost"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
