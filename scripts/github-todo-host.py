#!/usr/bin/python3
"""Chrome native host: read the GitHub PAT from Keychain, create a private
repository, and return credentials only through Chrome's native message pipe.
No tokens or todo data are written to files."""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import sys
import urllib.error
import urllib.request

HOST = "com.tab_out.github_keychain"
ACCOUNT = "yangxiaorun"
REPO = "tab-out-todo-private"


def bootstrap(repository=REPO):
    if not isinstance(repository, str) or repository != REPO:
        raise ValueError("This helper only creates the dedicated private todo repository.")
    result = subprocess.run(
        ["security", "find-internet-password", "-a", ACCOUNT, "-s", "github.com", "-w"],
        capture_output=True, text=True, timeout=15,
    )
    token = result.stdout.strip()
    if result.returncode or not token:
        raise ValueError("GitHub token not found in this Mac's Keychain (github.com / yangxiaorun). Restore it, or connect with a repository token in Sync settings.")

    def api(route, body=None):
        request = urllib.request.Request(
            "https://api.github.com" + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "tab-out-keychain",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    try:
        user = api("/user")
        if user.get("login") != ACCOUNT:
            raise ValueError("Keychain token belongs to a different GitHub account.")
        try:
            repo = api("/repos/" + ACCOUNT + "/" + REPO)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            repo = api("/user/repos", {
                "name": REPO, "private": True, "auto_init": True,
                "description": "Private daily todo event history for Tab Out",
            })
        if repo.get("private") is not True:
            raise ValueError("The todo repository must be private. No history was uploaded.")
        return {"ok": True, "config": {"owner": ACCOUNT, "repo": REPO, "token": token},
                "url": repo["html_url"]}
    except urllib.error.HTTPError as error:
        raise ValueError("GitHub authorization failed (HTTP %s). Check token permissions." % error.code) from None
    except urllib.error.URLError:
        raise ValueError("Cannot reach GitHub. Check your network and try again.") from None


def extension_ids():
    base = Path.home() / "Library/Application Support/Google/Chrome"
    ids = set()
    for profile in [base / "Default", *base.glob("Profile *")]:
        for filename in ["Preferences", "Secure Preferences"]:
            try:
                settings = json.loads((profile / filename).read_text()).get("extensions", {}).get("settings", {})
            except (OSError, ValueError):
                continue
            for ext_id, details in settings.items():
                ext_path = details.get("path", "")
                local_extension = Path(__file__).resolve().parent.parent / "extension"
                if ext_path and Path(ext_path).resolve() == local_extension:
                    ids.add(ext_id)
    return sorted(ids)


def install(ids):
    import re
    ids = ids or extension_ids()
    if not ids:
        raise ValueError("Tab Out extension ID was not found. Install the extension, then run this script with --install --extension-id <ID>.")
    if any(not re.fullmatch("[a-p]{32}", ext_id) for ext_id in ids):
        raise ValueError("Invalid Chrome extension ID.")
    script = Path(__file__).resolve()
    script.chmod(0o755)
    folder = Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    folder.mkdir(parents=True, exist_ok=True)
    manifest = folder / (HOST + ".json")
    manifest.write_text(json.dumps({
        "name": HOST,
        "description": "Tab Out GitHub Keychain connection",
        "path": str(script),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://" + ext_id + "/" for ext_id in ids],
    }, indent=2) + "\n")
    manifest.chmod(0o600)
    print("Installed GitHub Keychain helper for Tab Out: " + ", ".join(ids))
    print("Reload Tab Out, then click Sync settings > Use this Mac's GitHub key.")


def native_main():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return
    length = struct.unpack("<I", header)[0]
    if length > 4096:
        return
    try:
        message = json.loads(sys.stdin.buffer.read(length))
        if message.get("action") != "bootstrap":
            raise ValueError("Unsupported native operation.")
        reply = bootstrap(message.get("repo", REPO))
    except ValueError as error:
        reply = {"ok": False, "error": str(error)}
    except Exception:
        reply = {"ok": False, "error": "Could not connect GitHub from Keychain. Check network and authorization."}
    payload = json.dumps(reply).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--extension-id", action="append", default=[])
    parser.add_argument("--check", action="store_true",
                        help="Verify/create the private repository without printing credentials")
    args, _chrome_args = parser.parse_known_args()
    try:
        if args.install:
            install(args.extension_id)
        elif args.check:
            result = bootstrap()
            print("Private repository ready: " + result["url"])
        else:
            native_main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
