"""Shared helpers for the safe-refactor scanners (stdlib only)."""

from __future__ import annotations

import fnmatch
import os
import subprocess
from pathlib import Path
from typing import Iterable, Iterator, Sequence

IGNORE_DIRS = {
    ".git", "node_modules", "bower_components", "vendor", "dist", "build", "out",
    "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
    "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
    "target", ".gradle", ".idea", ".vscode", ".refactor", "storybook-static",
}

GENERATED_HINTS = (".min.", ".bundle.", ".generated.", ".gen.", "-lock.", ".d.ts")


def is_generated(path: str) -> bool:
    name = os.path.basename(path)
    return any(h in name for h in GENERATED_HINTS)


def _git_files(root: Path) -> list[str] | None:
    try:
        out = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root, capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    files = [f for f in out.decode("utf-8", "replace").split("\0") if f]
    return files or None


SKILL_DIR = Path(__file__).resolve().parent.parent


def matches_exclude(rel: str, pattern: str) -> bool:
    """Match a posix relative path against one --exclude pattern.

    * A pattern without "/" (``dist``, ``*.stories.tsx``, ``legacy*``) matches any single
      path segment, so a bare folder name excludes that folder wherever it appears.
    * A pattern with "/" (``src/legacy``, ``packages/*/fixtures``) matches the whole path
      or any path below it.
    """
    pat = pattern.replace("\\", "/").strip().rstrip("/")
    if pat.startswith("./"):
        pat = pat[2:]
    if not pat:
        return False
    if "/" not in pat:
        return any(fnmatch.fnmatch(seg, pat) for seg in rel.split("/"))
    return fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat + "/*")


def iter_files(scopes: str | Sequence[str], extensions: Iterable[str], exclude: Iterable[str] = (),
               include_hidden: bool = False) -> Iterator[Path]:
    """Yield files under one or more scopes (files, directories, or globs) with matching extensions.

    Uses `git ls-files` when available so .gitignore is respected; falls back to a
    filesystem walk. Always skips dependency/build directories, generated files, this
    skill's own folder, and (unless include_hidden) dot-directories such as .claude/ and
    .github/. Exclude patterns are tested against the path relative to the current
    directory and relative to the scope. A scope that doesn't exist is an error.
    """
    if isinstance(scopes, str):
        scopes = [scopes]
    exts = tuple(e.lower() for e in extensions)
    exclude = [e for e in exclude if e]
    cwd = Path.cwd()
    skill_dir = str(SKILL_DIR) + os.sep
    seen: set[str] = set()

    def keep(p: Path, rel_scope: str) -> bool:
        if not rel_scope.lower().endswith(exts) or is_generated(rel_scope):
            return False
        dirs = rel_scope.split("/")[:-1]
        if any(d in IGNORE_DIRS for d in dirs):
            return False
        if not include_hidden and any(d.startswith(".") and d not in (".", "..") for d in dirs):
            return False
        resolved = str(p.resolve())
        if resolved.startswith(skill_dir) or resolved in seen:
            return False
        try:
            rel_cwd = Path(os.path.relpath(p, cwd)).as_posix()
        except ValueError:  # different drive on Windows
            rel_cwd = rel_scope
        if any(matches_exclude(rel_cwd, pat) or matches_exclude(rel_scope, pat) for pat in exclude):
            return False
        seen.add(resolved)
        return True

    for scope in scopes:
        scope_path = Path(scope)
        if any(ch in scope for ch in "*?["):
            for p in sorted(Path(".").glob(scope)):
                if p.is_file() and keep(p, p.as_posix()):
                    yield p
            continue
        if not scope_path.exists():
            raise SystemExit(f"scope not found: {scope}")
        if scope_path.is_file():
            if keep(scope_path, scope_path.name):
                yield scope_path
            continue
        root = scope_path
        git = _git_files(root)
        if git is not None:
            for rel in sorted(git):
                p = root / rel
                if p.is_file() and keep(p, rel):
                    yield p
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORE_DIRS
                                 and (include_hidden or not d.startswith(".")))
            for fn in sorted(filenames):
                p = Path(dirpath) / fn
                if keep(p, p.relative_to(root).as_posix()):
                    yield p


def read_text(path: Path) -> str | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:4096]:
        return None
    return data.decode("utf-8", "replace")


GENERATED_MARKERS = ("@generated", "do not edit", "auto-generated", "autogenerated", "code generated by",
                     "this file is generated", "emscripten")


def looks_generated(text: str) -> bool:
    """True when the file header says it is generated (skip it: refactoring generated code is pointless)."""
    head = text[:800].lower()
    return any(m in head for m in GENERATED_MARKERS)


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1
