"""Hermes Editor Stage 5B LIVE synchronization tests (both hosts).

Gated: only runs when HERMES_EDITOR_STAGE5B_LIVE=1 is set:

    HERMES_EDITOR_STAGE5B_LIVE=1 \
    python tests/test_stage5b_live.py -v

Safety (identical contract to Stage 5A live tests):
* All destructive operations happen under the scratch roots
  ``~/.local/share/hermes-editor-stage5-test/he5b-<pid>-<label>/`` on each
  host - NEVER in the real Obsidian vault.
* External modifications are performed through independent ssh commands,
  exactly as a user's second machine would.
* Endpoint "failover" uses an unreachable documentation IP, never by
  touching interfaces/firewalls.
"""

from __future__ import annotations

import hashlib
import os
import queue
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dashboard"))

from hecore.providers.base import OfflineError
from hecore.providers.ssh_provider import SshProvider
from hecore.sync import SyncManager

SERVER_ETH = "192.0.2.10"
SERVER_TS = "192.0.2.11"
PULSE_ETH = "192.0.2.12"
PULSE_TS = "192.0.2.13"
USER = os.environ.get("HERMES_EDITOR_TEST_SSH_USER", "hermes-test")
UNREACHABLE = "192.0.2.88"

LIVE = os.environ.get("HERMES_EDITOR_STAGE5B_LIVE") == "1"


def _scratch(label: str) -> str:
    return f"/home/{USER}/.local/share/hermes-editor-stage5-test/he5b-{os.getpid()}-{label}"


def _ssh_write(endpoint: str, root: str, rel: str, content: str) -> None:
    """Independent external modification through plain ssh (no helper)."""
    cmd = ["ssh", "-o", "BatchMode=yes",
           "-o", f"ConnectTimeout={SshProvider.CONNECT_TIMEOUT}",
           f"{USER}@{endpoint}",
           f"mkdir -p '{root}/$(dirname '{rel}')' && "
           f"printf '%s' '{content}' > '{root}/{rel}'"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        raise RuntimeError(f"ssh write failed: {p.stderr[:200]}")


class _RegistryStub:
    def __init__(self, mapping):
        self.mapping = mapping

    def get_workspace(self, wid):
        if wid in self.mapping:
            return {"id": wid, "enabled": True}
        return None


class SyncLiveBase(unittest.TestCase):
    host_label = "server"
    endpoints = [SERVER_ETH, SERVER_TS]

    @classmethod
    def setUpClass(cls):
        if not LIVE:
            raise unittest.SkipTest("set HERMES_EDITOR_STAGE5B_LIVE=1 for live tests")
        cls.root = _scratch(cls.host_label)
        cls.prov = SshProvider(host_id=cls.host_label, user=USER,
                               endpoints=cls.endpoints, root=cls.root)
        cls.prov.mkdir("")
        cls.mgr = SyncManager(_RegistryStub({"ws": True}),
                              lambda wid: cls.prov, poll_interval=1.0)
        cls.mgr.register_client("live-client")
        cls.client = cls.mgr._clients["live-client"]

    @classmethod
    def tearDownClass(cls):
        if not LIVE:
            return
        cls.mgr.shutdown()
        try:
            cls.prov.delete("")
        except OfflineError:
            pass
        cls.prov.close()

    def subscribe(self, rel):
        self.assertTrue(self.mgr.subscribe("live-client", "ws", rel))

    def next_event(self, want_type, timeout=15):
        deadline = time.time() + timeout
        seen = []
        while time.time() < deadline:
            try:
                ev = self.client.queue.get(timeout=1)
            except queue.Empty:
                continue
            seen.append(ev["type"])
            if ev["type"] == want_type:
                return ev
        raise AssertionError(
            f"no {want_type} within {timeout}s; saw {seen}")


class TestServerExternalChanges(SyncLiveBase):
    """Requirements: external modification / deletion / rename detection."""

    def test_10_external_modification_detected(self):
        rel = "ext/live.txt"
        content = "external v1\n"
        self.prov.write(rel, content.encode(), "", False)
        self.subscribe(rel)
        time.sleep(2.0)                       # baseline cycle
        new = "external v2 (independent ssh)\n"
        _ssh_write(SERVER_ETH, self.root, rel, new)
        ev = self.next_event("file.modified")
        self.assertEqual(ev["path"], rel)
        self.assertEqual(ev["revision"],
                         hashlib.sha256(new.encode()).hexdigest())

    def test_11_external_deletion_detected(self):
        rel = "ext/vanish.txt"
        self.prov.write(rel, b"gone soon\n", "", False)
        self.subscribe(rel)
        time.sleep(2.0)
        subprocess.run(["ssh", "-o", "BatchMode=yes",
                        f"{USER}@{SERVER_ETH}",
                        f"rm '{self.root}/{rel}'"],
                       capture_output=True, timeout=30)
        ev = self.next_event("file.deleted")
        self.assertEqual(ev["path"], rel)

    def test_12_mass_change_debounces(self):
        rels = [f"mass/f{i}.txt" for i in range(6)]
        for i, rel in enumerate(rels):
            self.prov.write(rel, f"m{i}\n".encode(), "", False)
            self.subscribe(rel)
        time.sleep(2.0)
        for i, rel in enumerate(rels):
            _ssh_write(SERVER_ETH, self.root, rel, f"burst-{i}\n")
        ev = self.next_event("git.changed")
        self.assertGreaterEqual(ev["changed_count"], 5)

    def test_13_pulseai_external_modification_detected(self):
        if self.host_label != "server":
            self.skipTest("server-scoped variant")
        # cross-host sanity: pulseai scratch behaves identically
        root = _scratch("pulse")
        prov = SshProvider("pulse", USER, [PULSE_ETH], root)
        try:
            prov.mkdir("")
            rel = "p/live.txt"
            c1 = "pulse v1\n"
            prov.write(rel, c1.encode(), "", False)
            mgr = SyncManager(_RegistryStub({"pw": True}),
                              lambda wid: prov, poll_interval=1.0)
            cli = mgr.register_client("pc")
            mgr.subscribe("pc", "pw", rel)
            time.sleep(2.0)
            c2 = "pulse v2 external\n"
            _ssh_write(PULSE_ETH, root, rel, c2)
            deadline = time.time() + 15
            got = None
            while time.time() < deadline and got is None:
                try:
                    ev = cli.queue.get(timeout=1)
                except queue.Empty:
                    continue
                if ev["type"] == "file.modified":
                    got = ev
            self.assertIsNotNone(got)
            self.assertEqual(got["revision"], hashlib.sha256(c2.encode()).hexdigest())
            mgr.shutdown()
        finally:
            try:
                prov.delete("")
            finally:
                prov.close()


class TestEndpointFailoverWhileSubscribed(SyncLiveBase):
    """Requirements: Ethernet->Tailscale failover emits endpoint.changed +
    resync.required; subscribed revisions revalidate on the new endpoint."""

    def test_20_failover_emits_endpoint_changed_and_resync(self):
        rel = "fail/over.txt"
        self.prov.write(rel, b"before\n", "", False)
        self.subscribe(rel)
        time.sleep(2.0)                      # baseline on ethernet
        prev_ep = self.prov.active_endpoint
        # preferred endpoint becomes unavailable (policy-level simulation;
        # never touches interfaces or firewalls)
        self.prov.policy.mark_failed(prev_ep)
        # external modification now lands via the fallback endpoint
        other = SERVER_TS if prev_ep == SERVER_ETH else SERVER_ETH
        _ssh_write(other, self.root, rel, "after failover\n")
        ev = self.next_event("endpoint.changed")
        self.assertNotEqual(ev["endpoint"], prev_ep)
        rs = self.next_event("resync.required")
        self.assertEqual(rs["reason"], "endpoint_changed")
        mod = self.next_event("file.modified")
        self.assertEqual(mod["revision"],
                         hashlib.sha256(b"after failover\n").hexdigest())
        # recovery: preferred endpoint becomes eligible again
        self.prov.policy._failed_until[prev_ep] = 0.0
        self.prov.policy._failures[prev_ep] = 0
        deadline = time.time() + 30
        recovered = False
        while time.time() < deadline:
            self.prov.stat_many([rel])
            if self.prov.active_endpoint == prev_ep:
                recovered = True
                break
            time.sleep(1)
        self.assertTrue(recovered)

    def test_21_both_endpoints_offline_marks_workspace_offline(self):
        dead = SshProvider("dead", USER, [UNREACHABLE, UNREACHABLE],
                           "/tmp/he5b-should-not-exist")
        mgr = SyncManager(_RegistryStub({"dw": True}),
                          lambda wid: dead, poll_interval=0.6)
        cli = mgr.register_client("dc")
        mgr._subs["dw"] = {"x.txt": {"dc"}}
        try:
            with self.assertRaises(OfflineError):
                dead.stat_many(["x.txt"])
            deadline = time.time() + 10
            got = None
            while time.time() < deadline and got is None:
                try:
                    ev = cli.queue.get(timeout=1)
                except queue.Empty:
                    continue
                if ev["type"] == "workspace.offline":
                    got = ev
            self.assertIsNotNone(got)
            # no local Pi copy was materialised as a "fallback"
            self.assertFalse(Path("/tmp/he5b-should-not-exist").exists())
        finally:
            mgr.shutdown()
            dead.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
