#!/usr/bin/env python3
"""Lock baseline characterization tests and verify they were not modified.

Commands:
  lock FILE... [--update]   record SHA-256 of each file in .refactor/baseline.lock.json
                            (adds to the existing lock; --update re-hashes files already locked,
                            for a logged, mechanical import-path change only)
  verify                    exit 1 if any locked file changed or is missing
  status                    list locked files and whether each still matches

The lock file lives in .refactor/ under the git repo root (or the current directory).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def repo_root() -> Path:
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
        return Path(out.stdout.strip())
    except (OSError, subprocess.CalledProcessError):
        return Path.cwd()


ROOT = repo_root()
LOCK = ROOT / ".refactor" / "baseline.lock.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load() -> dict:
    if LOCK.exists():
        return json.loads(LOCK.read_text(encoding="utf-8"))
    return {"files": {}}


def save(data: dict) -> None:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT.resolve()))
    except ValueError:
        return str(path.resolve())


def cmd_lock(files: list[str], update: bool) -> int:
    data = load()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    errors = 0
    for f in files:
        p = Path(f)
        if not p.is_file():
            print(f"missing: {f}", file=sys.stderr)
            errors += 1
            continue
        key = rel(p)
        if key in data["files"] and not update:
            if data["files"][key]["sha256"] != sha256(p):
                print(f"refusing to re-lock modified file without --update: {key}", file=sys.stderr)
                errors += 1
            continue
        entry = {"sha256": sha256(p), "locked_at": now}
        if key in data["files"]:
            entry["updates"] = data["files"][key].get("updates", 0) + 1
        data["files"][key] = entry
        print(f"locked: {key}")
    save(data)
    return 1 if errors else 0


def check() -> list[tuple[str, str]]:
    results = []
    for key, entry in sorted(load()["files"].items()):
        p = ROOT / key if not Path(key).is_absolute() else Path(key)
        if not p.is_file():
            results.append((key, "MISSING"))
        elif sha256(p) != entry["sha256"]:
            results.append((key, "MODIFIED"))
        else:
            results.append((key, "ok"))
    return results


def cmd_verify() -> int:
    results = check()
    if not results:
        print("no baseline files locked")
        return 1
    bad = [(k, s) for k, s in results if s != "ok"]
    for k, s in bad:
        print(f"{s}: {k}")
    if bad:
        print(f"FAIL: {len(bad)} of {len(results)} baseline files changed. Revert the refactor, not the tests.")
        return 1
    print(f"OK: {len(results)} baseline files unchanged")
    return 0


def cmd_status() -> int:
    for k, s in check():
        print(f"{s:8} {k}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lk = sub.add_parser("lock")
    lk.add_argument("files", nargs="+")
    lk.add_argument("--update", action="store_true")
    sub.add_parser("verify")
    sub.add_parser("status")
    args = ap.parse_args()
    if args.cmd == "lock":
        return cmd_lock(args.files, args.update)
    if args.cmd == "verify":
        return cmd_verify()
    return cmd_status()


if __name__ == "__main__":
    raise SystemExit(main())
