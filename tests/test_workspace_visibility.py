"""Directory browsing includes dotfiles and dotfolders on local and SSH providers."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))

from hecore.providers.local import LocalProvider
from hecore.providers.remote_helper import HELPER_SOURCE


class HiddenEntryListingTest(unittest.TestCase):
    def test_local_and_remote_helpers_list_dot_entries(self):
        with tempfile.TemporaryDirectory(prefix="he-hidden-") as temp:
            root = Path(temp)
            (root / ".env").write_text("secret", encoding="utf-8")
            (root / ".config").mkdir()
            (root / ".git").mkdir()
            (root / "notes.md").write_text("note", encoding="utf-8")

            local = {entry["name"] for entry in LocalProvider(str(root)).list_dir("")}
            remote = subprocess.run(
                [sys.executable, "-c", HELPER_SOURCE],
                input=json.dumps({"op": "list", "root": str(root), "path": ""}),
                text=True, capture_output=True, check=True,
            )
            result = json.loads(remote.stdout)
            self.assertTrue(result["ok"], result)
            remote_names = {entry["name"] for entry in result["entries"]}
            self.assertTrue({".env", ".config", ".git", "notes.md"}.issubset(local))
            self.assertTrue({".env", ".config", ".git", "notes.md"}.issubset(remote_names))


if __name__ == "__main__":
    unittest.main()
