"""Hermes Editor Stage 5A LIVE remote tests (both hosts, both endpoints).

Gated: only runs when HERMES_EDITOR_STAGE5_LIVE=1 is set, e.g.

    HERMES_EDITOR_STAGE5_LIVE=1 python \
        tests/test_stage5_live.py

Safety:
* All destructive operations happen under the scratch roots
  ``~/.local/share/hermes-editor-stage5-test/he5-live-<pid>/`` on each host.
* The real Obsidian vault is only ever READ (index scan), never written.
* Endpoint "failover" is exercised against an unreachable documentation IP,
  never by taking interfaces down.
"""

from __future__ import annotations

import base64
import hashlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dashboard"))

from hecore.providers.base import ConflictError, OfflineError, ProviderError
from hecore.providers.ssh_provider import SshProvider
from hecore.providers.remote_helper import HELPER_SOURCE, helper_sha256

SERVER_ETH = "192.0.2.10"
SERVER_TS = "192.0.2.11"
PULSE_ETH = "192.0.2.12"
PULSE_TS = "192.0.2.13"
USER = os.environ.get("HERMES_EDITOR_TEST_SSH_USER", "hermes-test")
SCRATCH_BASE = ".local/share/hermes-editor-stage5-test"
UNREACHABLE = "192.0.2.77"  # RFC5737 - guaranteed unroutable, safe to probe

LIVE = os.environ.get("HERMES_EDITOR_STAGE5_LIVE") == "1"


def _scratch(host_label: str) -> str:
    return f"/home/{USER}/{SCRATCH_BASE}/he5-live-{os.getpid()}-{host_label}"


class LiveBase(unittest.TestCase):
    host_label = "server"
    endpoints = [SERVER_ETH, SERVER_TS]

    @classmethod
    def setUpClass(cls):
        if not LIVE:
            raise unittest.SkipTest("set HERMES_EDITOR_STAGE5_LIVE=1 for live SSH tests")
        cls.root = _scratch(cls.host_label)
        cls.prov = SshProvider(
            host_id=cls.host_label, user=USER,
            endpoints=cls.endpoints, root=cls.root)
        # create scratch root via a throwaway provider at the parent dir
        parent_prov = SshProvider(
            host_id=cls.host_label, user=USER, endpoints=cls.endpoints[:1],
            root=f"/home/{USER}/{SCRATCH_BASE.rsplit('/', 2)[0]}")
        # simpler: mkdir through the main provider itself
        cls.prov.mkdir("")

    @classmethod
    def tearDownClass(cls):
        try:
            cls.prov.delete("")
        except ProviderError:
            pass
        cls.prov.close()


class TestServerEthernet(LiveBase):
    """Requirement 5."""

    def test_00_health_ethernet(self):
        h = self.prov.health()
        self.assertTrue(h["online"])
        self.assertEqual(h["endpoint"], SERVER_ETH)


class TestServerTailscale(unittest.TestCase):
    """Requirement 6."""

    def test_01_health_tailscale(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        p = SshProvider("server-ts", USER, [SERVER_TS], _scratch("ts"))
        try:
            h = p.health()
            self.assertTrue(h["online"])
            self.assertEqual(h["endpoint"], SERVER_TS)
        finally:
            p.close()


class TestPulseEthernet(LiveBase):
    host_label = "pulse"
    endpoints = [PULSE_ETH, PULSE_TS]

    def test_02_health_ethernet(self):
        h = self.prov.health()
        self.assertTrue(h["online"])
        self.assertEqual(h["endpoint"], PULSE_ETH)


class TestPulseTailscale(unittest.TestCase):
    """Requirement 7/8."""

    def test_03_health_tailscale(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        p = SshProvider("pulse-ts", USER, [PULSE_TS], _scratch("pts"))
        try:
            h = p.health()
            self.assertTrue(h["online"])
            self.assertEqual(h["endpoint"], PULSE_TS)
        finally:
            p.close()


class TestFailoverAndRecovery(unittest.TestCase):
    """Requirements 9+10: fallback to second endpoint, then recovery of first."""

    def test_04_fallback_when_preferred_unreachable(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        prov = SshProvider("server", USER, [UNREACHABLE, SERVER_TS],
                           _scratch("failover"))
        try:
            prov.mkdir("")
            r = prov.write("f.txt", b"data\n", "", False)
            self.assertEqual(r["revision"],
                             hashlib.sha256(b"data\n").hexdigest())
            self.assertEqual(prov.active_endpoint, SERVER_TS)
        finally:
            prov.close()

    def test_05_recovery_preferred_regains_priority(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        prov = SshProvider("server", USER, [SERVER_ETH, SERVER_TS],
                           _scratch("recover"))
        try:
            prov.mkdir("")
            # force the preferred endpoint into cooldown as if it had failed
            prov.policy.mark_failed(SERVER_ETH)
            prov.write("r.txt", b"v1\n", "", False)
            self.assertEqual(prov.active_endpoint, SERVER_TS)
            # once its cooldown expires it is preferred again (recovery)
            prov.policy._failed_until[SERVER_ETH] = 0.0
            prov.policy._failures[SERVER_ETH] = 0
            prov.write("r.txt", b"v2\n", hashlib.sha256(b"v1\n").hexdigest(), False)
            self.assertEqual(prov.active_endpoint, SERVER_ETH)
        finally:
            prov.close()

    def test_06_write_revalidates_revision_after_failover(self):
        """Requirement 4b: CAS runs on whichever endpoint actually writes."""
        if not LIVE:
            raise unittest.SkipTest("live gate")
        prov = SshProvider("server", USER, [UNREACHABLE, SERVER_ETH],
                           _scratch("cas"))
        try:
            prov.mkdir("")
            prov.write("c.txt", b"original\n", "", False)
            stale_rev = hashlib.sha256(b"outdated\n").hexdigest()
            with self.assertRaises(ConflictError):
                prov.write("c.txt", b"mine\n", stale_rev, False)
        finally:
            prov.close()


class TestFileOps(LiveBase):
    """Requirements 11-21 against the live server scratch root."""

    def test_10_mkdir_list_stat_read_revision(self):
        self.prov.mkdir("sub dir/nested")
        entries = {e["name"] for e in self.prov.list_dir("")}
        self.assertIn("sub dir", entries)
        st = self.prov.stat("sub dir")
        self.assertEqual(st["type"], "dir")

        payload = "hello spaces & unicode ✓\n"
        w = self.prov.write("dir with späce/file name.txt",
                            payload.encode(), "", False)
        rev = w["revision"]
        self.assertEqual(rev, hashlib.sha256(payload.encode()).hexdigest())
        f = self.prov.read("dir with späce/file name.txt")
        self.assertEqual(f["content"], payload)
        self.assertEqual(f["revision"], rev)          # requirement 12
        st = self.prov.stat("dir with späce/file name.txt")
        self.assertEqual(st["size"], len(payload.encode()))
        self.assertEqual(st["mtime_ns"], f["mtime_ns"])   # stat/read agree

    def test_11_atomic_write_and_no_temp_leftovers(self):
        data = ("x" * 4096 + "\n").encode()
        self.prov.write("atomic/big.txt", data, "", False)
        names = [e["name"] for e in self.prov.list_dir("atomic")]
        self.assertEqual([n for n in names if n.startswith(".hermes-editor-tmp-")], [])
        self.assertEqual(names, ["big.txt"])

    def test_12_stale_revision_conflict_then_explicit_force_only(self):
        path = "conflict/live.txt"
        v1 = "one\n"
        r1 = self.prov.write(path, v1.encode(), "", False)
        # external change behind our back
        v2 = "two (external)\n"
        self.prov.write(path, v2.encode(), "", force=True)
        with self.assertRaises(ConflictError) as cm:
            self.prov.write(path, b"three\n", r1["revision"], False)
        self.assertEqual(cm.exception.reason, "modified_on_disk")
        self.assertEqual(cm.exception.detail["current_revision"],
                         hashlib.sha256(v2.encode()).hexdigest())
        # explicit-only force overwrite succeeds
        r3 = self.prov.write(path, b"three\n", "", force=True)
        self.assertEqual(r3["revision"],
                         hashlib.sha256(b"three\n").hexdigest())

    def test_13_deleted_on_disk_conflict(self):
        path = "conflict/vanish.txt"
        r1 = self.prov.write(path, b"bye\n", "", False)
        self.prov.delete(path)
        with self.assertRaises(ConflictError) as cm:
            self.prov.write(path, b"back\n", r1["revision"], False)
        self.assertEqual(cm.exception.reason, "deleted_on_disk")

    def test_14_binary_file_detected_not_decoded(self):
        blob = b"\x00\x01\x02binary\xff" * 10
        self.prov.write("blob.bin", blob, "", False)
        f = self.prov.read("blob.bin")
        self.assertEqual(f["encoding"], "binary")
        self.assertIsNone(f["content"])

    def test_15_oversized_file_withheld(self):
        big = b"x" * (2_000_001)
        self.prov.write("big.log", big, "", False)
        f = self.prov.read("big.log")
        self.assertEqual(f["encoding"], "oversized")
        self.assertIsNone(f["content"])
        self.assertEqual(f["size"], len(big))

    def test_16_rename_never_overwrites(self):
        self.prov.write("mv/src.txt", b"move me\n", "", False)
        r = self.prov.rename("mv/src.txt", "mv/dst two.txt")
        self.assertEqual(r["to"], "mv/dst two.txt")
        self.assertRaises(ProviderError, self.prov.stat, "mv/src.txt")
        self.prov.write("mv/blocker.txt", b"occupied\n", "", False)
        with self.assertRaises(ProviderError) as cm:
            self.prov.rename("mv/dst two.txt", "mv/blocker.txt")
        self.assertEqual(cm.exception.status_code, 409)

    def test_17_delete_file_and_tree(self):
        self.prov.write("del/a.txt", b"a\n", "", False)
        self.prov.mkdir("del/sub")
        self.prov.write("del/sub/b.txt", b"b\n", "", False)
        self.prov.delete("del")
        self.assertRaises(ProviderError, self.prov.stat, "del")

    def test_18_traversal_and_symlink_escape_rejected_remotely(self):
        from hecore.providers.base import PathRejected
        for bad in ("../../etc/passwd", "/etc/passwd"):
            with self.assertRaises((PathRejected, ProviderError)):
                self.prov.read(bad)
        # symlink pointing outside the workspace
        self.prov.write("linker/inside.txt", b"x\n", "", False)
        req = {"op": "ping"}  # placeholder; use helper directly via ssh exec
        # create /etc-targeting symlink using a controlled local dir instead:
        # point outside WITHIN allowed space: link to /tmp via absolute target
        import subprocess
        cmd = ["ssh", "-o", "BatchMode=yes",
               "-o", f"ConnectTimeout={SshProvider.CONNECT_TIMEOUT}",
               f"{USER}@{self.endpoints[0]}",
               f"ln -sfn /tmp {self.root}/linker/outside"]
        subprocess.run(cmd, capture_output=True, timeout=20)
        with self.assertRaises(ProviderError) as cm:
            self.prov.stat("linker/outside")
        self.assertEqual(cm.exception.status_code, 400)

    def test_19_index_scan_extracts_wikilinks(self):
        self.prov.write("wiki/Alpha.md",
                        b"---\ntitle: Alpha Page\naliases: [First]\n---\n\n"
                        b"# Alpha Top\n\n## Section A\n\nsee [[Beta]] and [[Gamma|g]]\n",
                        "", False)
        scan = self.prov.index_scan()
        entry = [e for e in scan["entries"] if e["path"] == "wiki/Alpha.md"][0]
        self.assertEqual(entry["title"], "Alpha Page")
        self.assertIn("First", entry["aliases"])
        self.assertIn("Beta", entry["outgoing"])

    def test_20_markdown_served_as_text_for_wysiwyg(self):
        """Requirement 27/28 backend half: .md on either host reads as text."""
        self.prov.write("note.md", "# Note\n\ntext\n".encode(), "", False)
        f = self.prov.read("note.md")
        self.assertEqual(f["encoding"], "text")
        self.assertIsNotNone(f["content"])


class TestOfflineLive(unittest.TestCase):
    """Requirements 22+23: all endpoints dead -> clean offline, no local copy."""

    def test_30_offline_workspace_raises_and_creates_nothing_local(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        hermes_home = Path(tempfile.mkdtemp(prefix="he5-offline-home-"))
        old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(hermes_home)
        try:
            before = {p.name for p in hermes_home.iterdir()}
            prov = SshProvider("dead", USER, [UNREACHABLE, UNREACHABLE],
                               "/tmp/he5-should-never-exist")
            try:
                with self.assertRaises(OfflineError):
                    prov.health() if False else prov.list_dir("")
                with self.assertRaises(OfflineError):
                    prov.write("x.txt", b"data", "", False)
            finally:
                prov.close()
            after = {p.name for p in hermes_home.iterdir()}
            # no workspace content materialised locally
            self.assertNotIn("he5-should-never-exist", after | (after - before))
            self.assertFalse(any(p.is_dir() and p.name.startswith("he5-")
                                 for p in hermes_home.iterdir()))
        finally:
            if old_home is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = old_home
            import shutil
            shutil.rmtree(hermes_home, ignore_errors=True)


class TestObsidianReadOnly(unittest.TestCase):
    """Stage 4 index preservation against the REAL vault (read-only!)."""

    def test_31_index_obsidian_readonly_bounded(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        vault_root = os.environ.get("HERMES_EDITOR_TEST_VAULT_ROOT")
        if not vault_root:
            self.skipTest("set HERMES_EDITOR_TEST_VAULT_ROOT for a read-only vault scan")
        prov = SshProvider("server", USER, [SERVER_ETH], vault_root)
        try:
            scan = prov.index_scan()
            self.assertGreater(len(scan["entries"]), 0)
            self.assertLessEqual(len(scan["entries"]), 5000)  # cap respected
            paths = {e["path"] for e in scan["entries"]}
            self.assertTrue(all(p.endswith(".md") for p in paths))
            # read one file, never write
            sample = sorted(paths)[0]
            f = prov.read(sample)
            self.assertEqual(f["encoding"], "text")
        finally:
            prov.close()

    def test_32_helper_temp_files_cleaned_on_server_scratch(self):
        if not LIVE:
            raise unittest.SkipTest("live gate")
        prov = SshProvider("server", USER, [SERVER_ETH], _scratch("temp"))
        try:
            prov.mkdir("")
            prov.write("t/f.txt", b"d\n", "", False)
            import subprocess
            out = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", f"{USER}@{SERVER_ETH}",
                 f"find {prov.root} -name '.hermes-editor-tmp-*' 2>/dev/null"],
                capture_output=True, text=True, timeout=20).stdout.strip()
            self.assertEqual(out, "")
        finally:
            prov.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
