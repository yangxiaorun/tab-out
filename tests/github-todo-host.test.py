"""Native helper tests use mocked Keychain/API responses, never real secrets."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location(
    "github_todo_host", Path(__file__).resolve().parents[1] / "scripts/github-todo-host.py"
)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def keychain():
    return subprocess.CompletedProcess([], 0, "fake-token\n", "")


def reply(value):
    return io.BytesIO(json.dumps(value).encode())


class NativeHostTests(unittest.TestCase):
    def test_installer_uses_stable_app_support_copy_and_path_based_extension_id(self):
        extension = Path(host.__file__).resolve().parents[1] / "extension"
        extension_id = host.unpacked_extension_id(extension)
        self.assertRegex(extension_id, r"^[a-p]{32}$")

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.object(host.Path, "home", return_value=home):
                host.install([extension_id])

            installed = home / "Library/Application Support/Tab Out/github-todo-host.py"
            manifest = home / (
                "Library/Application Support/Google/Chrome/NativeMessagingHosts/"
                "com.tab_out.github_keychain.json"
            )
            settings = json.loads(manifest.read_text())
            self.assertEqual(settings["path"], str(installed))
            self.assertEqual(settings["allowed_origins"], [f"chrome-extension://{extension_id}/"])
            self.assertEqual(installed.stat().st_mode & 0o777, 0o755)
            self.assertEqual(manifest.stat().st_mode & 0o777, 0o644)

    def test_creates_only_private_repository_and_returns_no_token_in_files(self):
        requests = []

        def api(request, **_):
            requests.append(request)
            if request.full_url.endswith("/user"):
                return reply({"login": host.ACCOUNT})
            if request.full_url.endswith("/user/repos"):
                body = json.loads(request.data)
                self.assertTrue(body["private"])
                self.assertTrue(body["auto_init"])
                self.assertEqual(body["name"], host.REPO)
                return reply({"private": True, "html_url": "https://github.com/account/private"})
            raise HTTPError(request.full_url, 404, "missing", {}, None)

        with patch.object(host.subprocess, "run", return_value=keychain()), patch.object(host.urllib.request, "urlopen", side_effect=api):
            result = host.bootstrap()
        self.assertEqual(result["config"]["token"], "fake-token")
        self.assertEqual(len(requests), 3)

    def test_rejects_public_repository_and_wrong_account(self):
        with patch.object(host.subprocess, "run", return_value=keychain()), patch.object(host.urllib.request, "urlopen", return_value=reply({"login": "someone-else"})):
            with self.assertRaisesRegex(ValueError, "different GitHub account"):
                host.bootstrap()
        with patch.object(host.subprocess, "run", return_value=keychain()), patch.object(host.urllib.request, "urlopen", side_effect=[reply({"login": host.ACCOUNT}), reply({"private": False})]):
            with self.assertRaisesRegex(ValueError, "must be private"):
                host.bootstrap()

    def test_missing_keychain_is_a_clear_nonsecret_error(self):
        with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 44, "", "")):
            with self.assertRaisesRegex(ValueError, "token not found"):
                host.bootstrap()

    def test_native_protocol_is_framed_and_returns_safe_errors(self):
        payload = json.dumps({"action": "bootstrap"}).encode()

        class Stream:
            def __init__(self, value=b""):
                self.buffer = io.BytesIO(value)

        stdin = Stream(struct.pack("<I", len(payload)) + payload)
        stdout = Stream()
        with patch.object(host.sys, "stdin", stdin), patch.object(host.sys, "stdout", stdout), patch.object(host, "bootstrap", side_effect=ValueError("missing token")):
            host.native_main()
        output = stdout.buffer.getvalue()
        length = struct.unpack("<I", output[:4])[0]
        self.assertEqual(length, len(output[4:]))
        self.assertEqual(json.loads(output[4:]), {"ok": False, "error": "missing token"})


if __name__ == "__main__":
    unittest.main()
