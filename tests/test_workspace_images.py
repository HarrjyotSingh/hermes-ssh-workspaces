"""Bounded, workspace-addressed image reads for local and SSH providers."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))


class ImageRouteTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="he-images-")
        self.root = Path(self.temp.name)
        (self.root / "plot.png").write_bytes(b"\x89PNG\r\n\x1a\nbytes")

    def tearDown(self):
        self.temp.cleanup()

    def test_local_route_returns_data_url_and_rejects_traversal(self):
        from fastapi import FastAPI
        from starlette.testclient import TestClient
        from hecore.providers.local import LocalProvider

        spec = importlib.util.spec_from_file_location("he_images_api", ROOT / "dashboard" / "plugin_api.py")
        api = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = api
        spec.loader.exec_module(api)
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/hermes-editor")
        client = TestClient(app)
        with patch.object(api, "_provider", return_value=("local", LocalProvider(str(self.root)))):
            good = client.get("/api/plugins/hermes-editor/fs/image", params={"workspace": "local", "path": "plot.png"})
            self.assertEqual(good.status_code, 200)
            self.assertTrue(good.json()["data_url"].startswith("data:image/png;base64,"))
            bad = client.get("/api/plugins/hermes-editor/fs/image", params={"workspace": "local", "path": "../plot.png"})
            self.assertEqual(bad.status_code, 400)
            unsupported = client.get("/api/plugins/hermes-editor/fs/image", params={"workspace": "local", "path": "text.txt"})
            self.assertEqual(unsupported.status_code, 415)

    def test_remote_helper_returns_bounded_binary(self):
        from hecore.providers.remote_helper import HELPER_SOURCE

        req = {"root": str(self.root), "op": "read_image", "path": "plot.png", "max_bytes": 100}
        result = subprocess.run([sys.executable, "-c", HELPER_SOURCE], input=json.dumps(req), text=True, capture_output=True, check=True)
        self.assertTrue(json.loads(result.stdout)["content_b64"])
        req["max_bytes"] = 4
        result = subprocess.run([sys.executable, "-c", HELPER_SOURCE], input=json.dumps(req), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)["error"]["status"], 413)


if __name__ == "__main__":
    unittest.main()
