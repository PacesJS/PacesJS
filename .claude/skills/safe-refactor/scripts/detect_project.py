#!/usr/bin/env python3
"""Profile a repository for a safe-refactor run.

Prints JSON describing languages, frameworks, styling approach, test tooling,
lint/format configs, likely design-token files, git state, and the commands to
run tests, lint, typecheck, and build.

Usage: detect_project.py [ROOT]
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import iter_files  # noqa: E402

LANG_BY_EXT = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
    ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".vue": "Vue", ".svelte": "Svelte",
    ".css": "CSS", ".scss": "SCSS", ".sass": "Sass", ".less": "Less", ".html": "HTML",
}

FRAMEWORKS = {
    "react": "React", "next": "Next.js", "@remix-run/react": "Remix", "react-native": "React Native",
    "vue": "Vue", "nuxt": "Nuxt", "@angular/core": "Angular", "svelte": "Svelte",
    "@sveltejs/kit": "SvelteKit", "solid-js": "Solid", "express": "Express", "fastify": "Fastify",
    "@nestjs/core": "NestJS", "koa": "Koa", "electron": "Electron", "astro": "Astro",
    "redux": "Redux", "@reduxjs/toolkit": "Redux Toolkit", "zustand": "Zustand", "mobx": "MobX",
    "@tanstack/react-query": "TanStack Query", "babel-plugin-react-compiler": "React Compiler",
}

STYLING = {
    "tailwindcss": "Tailwind", "styled-components": "styled-components", "@emotion/react": "Emotion",
    "@emotion/styled": "Emotion", "sass": "Sass", "node-sass": "Sass", "less": "Less",
    "@vanilla-extract/css": "vanilla-extract", "@stitches/react": "Stitches",
    "@mui/material": "MUI", "@chakra-ui/react": "Chakra UI", "postcss": "PostCSS",
    "autoprefixer": "Autoprefixer",
}

TESTING = {
    "jest": "Jest", "vitest": "Vitest", "mocha": "Mocha", "ava": "AVA", "jasmine": "Jasmine",
    "@playwright/test": "Playwright", "cypress": "Cypress", "@testing-library/react": "React Testing Library",
    "@testing-library/user-event": "user-event", "@testing-library/vue": "Vue Testing Library",
    "@storybook/react": "Storybook", "storybook": "Storybook", "@storybook/test-runner": "Storybook test-runner",
    "chromatic": "Chromatic", "msw": "MSW", "nock": "nock", "supertest": "supertest",
    "fast-check": "fast-check", "@vitest/coverage-v8": "Vitest coverage (v8)", "c8": "c8", "nyc": "nyc",
}

LINT_CONFIG_GLOBS = [
    ".eslintrc*", "eslint.config.*", ".stylelintrc*", "stylelint.config.*", "biome.json*",
    ".prettierrc*", "prettier.config.*", "knip.json*", ".dependency-cruiser*", "tsconfig*.json",
    "ruff.toml", ".ruff.toml", "setup.cfg", "tox.ini", ".pylintrc", "mypy.ini", ".editorconfig",
    ".browserslistrc", "CLAUDE.md", "CONTRIBUTING.md", "ARCHITECTURE.md", "docs/adr", "adr",
]

TOKEN_NAME_RE = re.compile(r"(token|theme|variables|vars|design-system|palette|spacing|typography)", re.I)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def git_state(root: Path) -> dict:
    def run(*args: str) -> str | None:
        try:
            return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    if run("rev-parse", "--is-inside-work-tree") != "true":
        return {"is_repo": False}
    status = run("status", "--porcelain") or ""
    return {
        "is_repo": True,
        "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(status),
        "changed_files": len(status.splitlines()),
    }


def package_manager(root: Path) -> str | None:
    for lock, pm in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"),
                     ("bun.lock", "bun"), ("package-lock.json", "npm")):
        if (root / lock).exists():
            return pm
    return "npm" if (root / "package.json").exists() else None


def js_commands(pkg: dict, pm: str | None) -> dict:
    scripts = pkg.get("scripts", {}) or {}
    runner = {"npm": "npm run", "yarn": "yarn", "pnpm": "pnpm", "bun": "bun run"}.get(pm or "npm", "npm run")
    found: dict[str, str] = {}
    for kind, names in {
        "test": ["test", "test:unit", "unit", "test:ci"],
        "lint": ["lint", "lint:js", "eslint"],
        "lint_css": ["lint:css", "lint:styles", "stylelint"],
        "typecheck": ["typecheck", "type-check", "tsc", "check-types", "types"],
        "build": ["build"],
        "e2e": ["test:e2e", "e2e", "test:visual", "test-storybook"],
        "coverage": ["coverage", "test:coverage", "test:cov"],
    }.items():
        for name in names:
            if name in scripts:
                found[kind] = f"{runner} {name}"
                break
    return found


def workspace_dirs(root: Path, pkg: dict) -> list[Path]:
    patterns = pkg.get("workspaces") or []
    if isinstance(patterns, dict):
        patterns = patterns.get("packages", [])
    pnpm = root / "pnpm-workspace.yaml"
    if pnpm.exists():
        patterns += re.findall(r"^\s*-\s*['\"]?([^'\"\n#]+)['\"]?", pnpm.read_text(encoding="utf-8"), re.M)
    dirs: list[Path] = []
    for pat in patterns:
        if pat.startswith("!"):
            continue
        dirs += [d for d in sorted(root.glob(pat.rstrip("/"))) if (d / "package.json").is_file()]
    return dirs


def describe_package(pkg: dict) -> dict:
    deps: dict = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        deps.update(pkg.get(key, {}) or {})
    exports = pkg.get("exports")
    subpaths = sorted(k for k in exports if k.startswith("./")) if isinstance(exports, dict) else []
    return {
        "name": pkg.get("name"),
        "published": not pkg.get("private", False) and bool(exports or pkg.get("main") or pkg.get("module") or pkg.get("types")),
        "public_subpaths": subpaths,
        "frameworks": sorted({v for k, v in FRAMEWORKS.items() if k in deps}),
        "styling": sorted({v for k, v in STYLING.items() if k in deps}),
        "testing": sorted({v for k, v in TESTING.items() if k in deps}),
    }


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    langs: Counter[str] = Counter()
    token_files: list[str] = []
    css_modules = 0
    for p in iter_files(str(root), tuple(LANG_BY_EXT)):
        langs[LANG_BY_EXT[p.suffix.lower()]] += 1
        rel = p.relative_to(root).as_posix() if p.is_absolute() else p.as_posix()
        if ".module." in p.name:
            css_modules += 1
        if p.suffix.lower() in {".css", ".scss", ".less", ".ts", ".js", ".json"} and TOKEN_NAME_RE.search(p.name):
            token_files.append(rel)

    result: dict = {"root": str(root), "languages": dict(langs.most_common()), "git": git_state(root)}

    pkg_path = root / "package.json"
    if pkg_path.exists():
        pkg = read_json(pkg_path)
        deps = {}
        for key in ("dependencies", "devDependencies", "peerDependencies"):
            deps.update(pkg.get(key, {}) or {})
        pm = package_manager(root)
        result["javascript"] = {
            "package_manager": pm,
            "workspaces": bool(pkg.get("workspaces")) or (root / "pnpm-workspace.yaml").exists(),
            "published_library": bool(pkg.get("exports") or pkg.get("main") or pkg.get("types")) and not pkg.get("private", False),
            "exports_field": pkg.get("exports") is not None,
            "typescript": (root / "tsconfig.json").exists() or "typescript" in deps,
            "frameworks": sorted({v for k, v in FRAMEWORKS.items() if k in deps}),
            "styling": sorted({v for k, v in STYLING.items() if k in deps} | ({"CSS Modules"} if css_modules else set())),
            "testing": sorted({v for k, v in TESTING.items() if k in deps}),
            "browserslist": pkg.get("browserslist") or ((root / ".browserslistrc").exists() or None),
            "engines": pkg.get("engines"),
            "commands": js_commands(pkg, pm),
            "dependency_count": len(deps),
        }
        packages = []
        for d in workspace_dirs(root, pkg):
            info = describe_package(read_json(d / "package.json"))
            info["path"] = d.relative_to(root).as_posix()
            packages.append(info)
        if packages:
            js = result["javascript"]
            js["workspace_packages"] = packages
            js["frameworks"] = sorted(set(js["frameworks"]).union(*(p["frameworks"] for p in packages)))
            js["styling"] = sorted(set(js["styling"]).union(*(p["styling"] for p in packages)))
            js["testing"] = sorted(set(js["testing"]).union(*(p["testing"] for p in packages)))
            js["published_packages"] = [p["path"] for p in packages if p["published"]]
        if (root / "tsconfig.json").exists() and "typecheck" not in result["javascript"]["commands"]:
            result["javascript"]["commands"]["typecheck (suggested)"] = "npx tsc --noEmit"

    py_markers = [m for m in ("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile") if (root / m).exists()]
    if py_markers:
        text = " ".join((root / m).read_text(encoding="utf-8", errors="replace") for m in py_markers if (root / m).is_file())
        result["python"] = {
            "markers": py_markers,
            "pytest": "pytest" in text or (root / "pytest.ini").exists() or (root / "conftest.py").exists(),
            "tools": sorted(t for t in ("ruff", "mypy", "pyright", "black", "pylint", "hypothesis", "syrupy", "freezegun") if t in text),
            "commands": {"test (suggested)": "pytest -q"},
        }

    for marker, eco, cmds in (
        ("go.mod", "go", {"test": "go test ./...", "build": "go build ./...", "lint": "go vet ./..."}),
        ("Cargo.toml", "rust", {"test": "cargo test", "build": "cargo build", "lint": "cargo clippy"}),
        ("pom.xml", "java-maven", {"test": "mvn -q test", "build": "mvn -q package -DskipTests"}),
        ("build.gradle", "gradle", {"test": "./gradlew test", "build": "./gradlew build -x test"}),
        ("build.gradle.kts", "gradle", {"test": "./gradlew test", "build": "./gradlew build -x test"}),
        ("Gemfile", "ruby", {"test": "bundle exec rspec"}),
    ):
        if (root / marker).exists():
            result[eco] = {"commands (suggested)": cmds}

    configs = []
    for pattern in LINT_CONFIG_GLOBS:
        configs += [p.relative_to(root).as_posix() for p in root.glob(pattern)]
    result["config_and_docs"] = sorted(set(configs))
    result["likely_token_files"] = sorted(token_files)[:50]
    result["notes"] = [
        "Commands marked 'suggested' were inferred; confirm they work before relying on them.",
        "published_library / published_packages: exported symbols AND public_subpaths (deep imports) are public API; "
        "removing, moving, or changing them needs approval. Diff emitted .d.ts before/after for any change there.",
    ]
    json.dump(result, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
