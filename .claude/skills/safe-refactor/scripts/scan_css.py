#!/usr/bin/env python3
"""Scan stylesheets and CSS-in-JS for refactoring leads.

Reports:
  * every !important
  * the z-index inventory (distinct values, escalation values like 999/9999)
  * position: absolute / fixed per file
  * literal values that equal an existing design token (CSS custom property,
    SCSS $var, Less @var) -- usually the cheapest safe fix
  * literal values repeated across the codebase, by family (typography,
    spacing, borders, radii, colors, shadows, breakpoints, durations)
  * near-miss values (e.g. 15px next to a common 16px) for a human to decide

Covers .css/.scss/.sass/.less, <style> blocks in .vue/.svelte/.html, styled-components /
Emotion tagged templates, and camelCase style objects in JS/TS (heuristic).

Usage: scan_css.py [SCOPE ...] [--json] [--min-repeat N] [--max-list N] [--exclude PATTERN ...]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import iter_files, line_of, looks_generated, read_text  # noqa: E402

CSS_EXT = (".css", ".scss", ".sass", ".less", ".pcss")
EMBED_EXT = (".vue", ".svelte", ".html", ".htm")
JS_EXT = (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs")

TRIVIAL = {"0", "0px", "0rem", "0em", "auto", "inherit", "initial", "unset", "revert", "none",
           "transparent", "currentcolor", "100%", "normal", "1", "solid", "0 0", "0 auto"}

FAMILY_OF = [
    (re.compile(r"^font-size$"), "font-size", "whole"),
    (re.compile(r"^font-weight$"), "font-weight", "whole"),
    (re.compile(r"^line-height$"), "line-height", "whole"),
    (re.compile(r"^letter-spacing$"), "letter-spacing", "whole"),
    (re.compile(r"^font-family$"), "font-family", "whole"),
    (re.compile(r"^(margin|padding|gap|row-gap|column-gap|inset)(-.*)?$"), "spacing", "lengths"),
    (re.compile(r"^border-(top-|right-|bottom-|left-)?radius$|^border-radius-.*$"), "border-radius", "whole"),
    (re.compile(r"^border(-(top|right|bottom|left|inline|block)(-start|-end)?)?(-width|-style)?$"), "border", "whole"),
    (re.compile(r"^outline$"), "border", "whole"),
    (re.compile(r"^(box-shadow|text-shadow)$"), "shadow", "whole"),
    (re.compile(r"^(transition|transition-duration|animation|animation-duration)$"), "duration", "durations"),
]

DECL_PROPS = r"--[\w-]+|\$[\w-]+|@[\w-]+|[a-z][a-z-]*"
DECL_RE = re.compile(r"(?<![\w$@-])(" + DECL_PROPS + r")\s*:\s*([^;{}]*?)\s*(?=;|}|$)", re.M)
COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^)]*\)")
LENGTH_RE = re.compile(r"(?<![\w.-])-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch|ex|pt)(?![\w-])")
DURATION_RE = re.compile(r"(?<![\w.])\d*\.?\d+m?s\b")
MEDIA_RE = re.compile(r"@media[^{]*", re.I)
MEDIA_LEN_RE = re.compile(r"(?:min|max)-(?:width|height)\s*:\s*(\d*\.?\d+(?:px|em|rem))", re.I)
STYLE_BLOCK_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S | re.I)
TAGGED_TEMPLATE_RE = re.compile(
    r"(?:\bstyled(?:\.[A-Za-z]\w*|\([^()]*\))(?:\s*\.attrs\([^`]*?\))?|\bcss|\bcreateGlobalStyle|\binjectGlobal|\bkeyframes|\btw)\s*`"
)
JS_STYLE_PROP_RE = re.compile(
    r"\b(zIndex|position|fontSize|fontWeight|lineHeight|letterSpacing|margin\w*|padding\w*|gap|rowGap|columnGap|"
    r"border\w*|outline|boxShadow|textShadow|color|backgroundColor|background)\s*:\s*"
    r"(?:(['\"])([^'\"\n]*)\2|(-?\d+(?:\.\d+)?)(?=\s*[,}\n]))"
)
UNITLESS_JS = {"zIndex", "fontWeight", "lineHeight", "opacity", "flex"}
NUM_PX_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def camel_to_kebab(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", lambda m: "-" + m.group(1).lower(), name)


VAR_RE = re.compile(r"var\((?:[^()]|\([^()]*\))*\)")

TOKEN_FAMILY_HINTS = [
    ("z-index", re.compile(r"z-?index|layer", re.I)),
    ("border-radius", re.compile(r"radius|rounded", re.I)),
    ("shadow", re.compile(r"shadow|elevation", re.I)),
    ("duration", re.compile(r"duration|transition|speed|timing", re.I)),
    ("breakpoint", re.compile(r"breakpoint|\bbp\b|screen|\bmq\b", re.I)),
    ("font-weight", re.compile(r"weight", re.I)),
    ("line-height", re.compile(r"line-?height|leading", re.I)),
    ("font-size", re.compile(r"font-?size|text-(xs|sm|md|base|lg|xl)|\bfs\b|type-?scale", re.I)),
    ("spacing", re.compile(r"spac|gap|padding|margin|inset|gutter|\bsp-", re.I)),
    ("color", re.compile(r"colou?r|\bbg\b|background|fill|stroke|palette|gray|grey|red|green|blue|brand|primary|"
                         r"secondary|accent|danger|success|warning|surface|text|ink", re.I)),
]
GLOBAL_SCOPE_RE = re.compile(r"^(:root|html|:host|body|\*)\b|^\[data-theme|^\.theme", re.I)


def norm(value: str) -> str:
    """Normalize a value for comparison; lowercase everything except identifiers inside var()."""
    v = re.sub(r"\s*!important\s*$", "", value.strip(), flags=re.I)
    v = re.sub(r"\s+", " ", v).strip()
    parts, last = [], 0
    for m in VAR_RE.finditer(v):
        parts.append(v[last:m.start()].lower())
        parts.append(m.group(0))
        last = m.end()
    parts.append(v[last:].lower())
    v = "".join(parts)
    v = re.sub(r"(?<![\d.\w-])0\.(\d)", r".\1", v)  # 0.5rem -> .5rem
    return v


def token_family(name: str, value: str) -> str | None:
    """Guess what a design token is for, from its name (and value for colors)."""
    if COLOR_RE.fullmatch(value.strip()):
        return "color"
    for family, rx in TOKEN_FAMILY_HINTS:
        if rx.search(name):
            return None if family == "color" else family
    return None


def enclosing_selector(text: str, offset: int) -> str:
    """Selector of the innermost block containing `offset` ('' at top level)."""
    depth = 0
    for i in range(offset - 1, -1, -1):
        ch = text[i]
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                j = max(text.rfind("}", 0, i), text.rfind(";", 0, i), text.rfind("{", 0, i))
                return text[j + 1:i].strip()
            depth -= 1
    return ""


def blank_comments(text: str, line_comments: bool) -> str:
    """Replace comments with spaces, keeping newlines so line numbers stay correct."""
    def keep_newlines(m: re.Match) -> str:
        return re.sub(r"[^\n]", " ", m.group(0))
    text = re.sub(r"/\*.*?\*/", keep_newlines, text, flags=re.S)
    if line_comments:
        text = re.sub(r"(?<![:\w\"'/])//[^\n]*", keep_newlines, text)
    return text


def extract_template_css(js: str) -> list[tuple[int, str]]:
    """Return (offset, css_text) for styled-components/Emotion tagged templates."""
    blocks = []
    for m in TAGGED_TEMPLATE_RE.finditer(js):
        i = m.end()
        depth = 0
        buf = []
        start = i
        while i < len(js):
            ch = js[i]
            if ch == "\\":
                buf.append("  ")
                i += 2
                continue
            if depth == 0 and ch == "`":
                break
            if js.startswith("${", i):
                depth += 1
                buf.append("  ")
                i += 2
                continue
            if depth and ch == "}":
                depth -= 1
                buf.append(" ")
                i += 1
                continue
            buf.append(ch if depth == 0 or ch == "\n" else " ")
            i += 1
        blocks.append((start, "".join(buf)))
    return blocks


class Scanner:
    def __init__(self) -> None:
        self.important: list[dict] = []
        self.zindex: dict[str, list[str]] = defaultdict(list)
        self.position: dict[str, Counter] = defaultdict(Counter)
        self.position_locs: list[dict] = []
        # normalized value -> [(token name, family, is_global)]
        self.tokens: dict[str, list[tuple[str, str | None, bool]]] = defaultdict(list)
        self.token_def_locs: set[str] = set()
        self.literals: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        self.files = 0

    # -- recording -----------------------------------------------------------
    def add_literal(self, family: str, value: str, loc: str) -> None:
        if value and value not in TRIVIAL and not re.search(r"var\(|\$|@|theme\(|env\(|\{|\}", value):
            self.literals[family][value].append(loc)

    def handle_decl(self, prop: str, raw_value: str, loc: str, source: str, scope: str = "") -> None:
        prop = prop.lower() if not prop.startswith(("--", "$", "@")) else prop
        value = raw_value.strip()
        if not value:
            return
        if re.search(r"!\s*important", value, re.I):
            self.important.append({"loc": loc, "prop": prop, "value": value, "source": source})
        if prop.startswith(("--", "$", "@")):
            if prop.startswith("@") and prop[1:] in {"media", "include", "extend", "import", "use", "forward",
                                                     "mixin", "function", "return", "if", "else", "each",
                                                     "for", "supports", "keyframes", "font-face", "layer", "page"}:
                return
            is_global = scope == "" if prop.startswith(("$", "@")) else bool(GLOBAL_SCOPE_RE.match(scope))
            self.tokens[norm(value)].append((prop, token_family(prop, norm(value)), is_global))
            self.token_def_locs.add(loc)
            return
        v = norm(value)
        if prop == "z-index":
            self.zindex[v].append(loc)
            return
        if prop == "position" and v in {"absolute", "fixed"}:
            self.position[loc.rsplit(":", 1)[0]][v] += 1
            self.position_locs.append({"loc": loc, "value": v, "source": source})
            return
        for color in COLOR_RE.findall(VAR_RE.sub(" ", value)):
            self.add_literal("color", norm(color), loc)
        for rx, family, mode in FAMILY_OF:
            if rx.match(prop):
                if mode == "whole":
                    self.add_literal(family, v, loc)
                elif mode == "lengths":
                    for length in LENGTH_RE.findall(v):
                        self.add_literal(family, norm(length), loc)
                elif mode == "durations":
                    for d in DURATION_RE.findall(v):
                        self.add_literal(family, norm(d), loc)
                break

    # -- sources -------------------------------------------------------------
    def scan_css_text(self, text: str, path: str, base_offset_text: str | None = None,
                      base_offset: int = 0, source: str = "css", line_comments: bool = True) -> None:
        cleaned = blank_comments(text, line_comments)
        origin = base_offset_text if base_offset_text is not None else cleaned

        def loc_for(offset: int) -> str:
            return f"{path}:{line_of(origin, base_offset + offset)}"

        for m in MEDIA_RE.finditer(cleaned):
            for length in MEDIA_LEN_RE.findall(m.group(0)):
                self.add_literal("breakpoint", norm(length), loc_for(m.start()))
        for m in DECL_RE.finditer(cleaned):
            prop, value = m.group(1), m.group(2)
            if prop.startswith("@") and prop[1:].lower() in {"media", "supports", "container"}:
                continue
            scope = enclosing_selector(cleaned, m.start()) if prop.startswith(("--", "$", "@")) else ""
            self.handle_decl(prop, value, loc_for(m.start()), source, scope)

    def scan_js_objects(self, text: str, path: str) -> None:
        cleaned = blank_comments(text, True)
        for m in JS_STYLE_PROP_RE.finditer(cleaned):
            name = m.group(1)
            value = m.group(3) if m.group(3) is not None else m.group(4)
            if value is None:
                continue
            if NUM_PX_RE.match(value) and name not in UNITLESS_JS:
                value = f"{value}px"
            self.handle_decl(camel_to_kebab(name), value, f"{path}:{line_of(cleaned, m.start())}", "js-object")

    def scan_file(self, p: Path) -> None:
        text = read_text(p)
        if text is None or looks_generated(text):
            return
        self.files += 1
        path = p.as_posix()
        ext = p.suffix.lower()
        if ext in CSS_EXT:
            self.scan_css_text(text, path, line_comments=ext != ".css")
        elif ext in EMBED_EXT:
            for m in STYLE_BLOCK_RE.finditer(text):
                self.scan_css_text(m.group(1), path, text, m.start(1), "style-block")
            if ext in {".vue", ".svelte"}:
                self.scan_js_objects(STYLE_BLOCK_RE.sub(lambda m: "\n" * m.group(0).count("\n"), text), path)
        elif ext in JS_EXT:
            for offset, css in extract_template_css(text):
                self.scan_css_text(css, path, text, offset, "css-in-js")
            self.scan_js_objects(text, path)

    # -- analysis ------------------------------------------------------------
    def matching_tokens(self, family: str, value: str) -> list[str]:
        """Global tokens with the same value AND the same purpose (family) as the literal."""
        fam = "border-radius" if family == "border-radius" else family
        return sorted({name for name, tfam, is_global in self.tokens.get(value, [])
                       if is_global and tfam == fam})

    def token_matches(self) -> list[dict]:
        out = []
        for family, values in self.literals.items():
            for value, locs in values.items():
                names = self.matching_tokens(family, value)
                real = [loc for loc in locs if loc not in self.token_def_locs]
                if names and real:
                    out.append({"family": family, "value": value, "tokens": names, "count": len(real), "locations": real})
        return sorted(out, key=lambda d: -d["count"])

    def repeated(self, min_repeat: int) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for family, values in sorted(self.literals.items()):
            rows = []
            for value, locs in values.items():
                real = [loc for loc in locs if loc not in self.token_def_locs]
                if len(real) >= min_repeat:
                    files = {loc.rsplit(":", 1)[0] for loc in real}
                    rows.append({"value": value, "count": len(real), "files": len(files), "locations": real,
                                 "existing_tokens": self.matching_tokens(family, value)})
            if rows:
                out[family] = sorted(rows, key=lambda r: (-r["count"], r["value"]))
        return out

    def near_misses(self) -> list[dict]:
        out = []
        for family in ("font-size", "spacing", "border-radius", "line-height", "breakpoint"):
            counts = {v: len(l) for v, l in self.literals.get(family, {}).items()}
            px = {}
            for v, c in counts.items():
                m = re.fullmatch(r"(-?\d*\.?\d+)px", v)
                if m:
                    px[float(m.group(1))] = (v, c)
            for num, (v, c) in px.items():
                for delta in (-2, -1, 1, 2):
                    other = px.get(num + delta)
                    if other and other[1] >= max(3, 2 * c):
                        out.append({"family": family, "value": v, "count": c, "near": other[0], "near_count": other[1]})
                        break
        return out

    def zindex_summary(self) -> list[dict]:
        def key(v: str) -> tuple:
            try:
                return (0, float(v))
            except ValueError:
                return (1, v)
        rows = []
        for v in sorted(self.zindex, key=key):
            try:
                escalation = abs(float(v)) >= 999
            except ValueError:
                escalation = False
            rows.append({"value": v, "count": len(self.zindex[v]), "escalation": escalation, "locations": self.zindex[v]})
        return rows


def render_markdown(s: Scanner, args: argparse.Namespace) -> str:
    lim = args.max_list
    z = s.zindex_summary()
    tm = s.token_matches()
    rep = s.repeated(args.min_repeat)
    nm = s.near_misses()
    pos_total = sum(sum(c.values()) for c in s.position.values())
    out = ["# CSS scan", "",
           "Heuristic leads, not verdicts. Verify each before acting (see references/css.md).", "",
           "| Metric | Value |", "| --- | --- |",
           f"| Files scanned | {s.files} |",
           f"| `!important` | {len(s.important)} |",
           f"| z-index declarations / distinct values | {sum(r['count'] for r in z)} / {len(z)} |",
           f"| Escalation z-index values (>= 999) | {sum(1 for r in z if r['escalation'])} |",
           f"| position absolute/fixed | {pos_total} in {len(s.position)} files |",
           f"| Design tokens defined | {sum(len(v) for v in s.tokens.values())} |",
           f"| Literals equal to a same-purpose global token | {sum(r['count'] for r in tm)} |",
           f"| Repeated literal values (>= {args.min_repeat} uses) | {sum(len(v) for v in rep.values())} |",
           ""]

    out += ["## `!important`", ""]
    for r in s.important[:lim]:
        out.append(f"- `{r['loc']}` {r['prop']}: {r['value']} ({r['source']})")
    if len(s.important) > lim:
        out.append(f"- ... {len(s.important) - lim} more")
    out.append("")

    out += ["## z-index inventory", ""]
    for r in z:
        flag = " **escalation**" if r["escalation"] else ""
        locs = ", ".join(f"`{l}`" for l in r["locations"][:4])
        more = f" +{r['count'] - 4} more" if r["count"] > 4 else ""
        out.append(f"- `{r['value']}` x{r['count']}{flag}: {locs}{more}")
    out.append("")

    out += ["## Absolute / fixed positioning by file", ""]
    for f, c in sorted(s.position.items(), key=lambda kv: -sum(kv[1].values()))[:lim]:
        out.append(f"- `{f}`: absolute {c.get('absolute', 0)}, fixed {c.get('fixed', 0)}")
    out.append("")

    out += ["## Literals that equal a same-purpose global token (cheapest safe fixes)", "",
            "Matched on value AND purpose (inferred from the token name) and only against tokens defined at "
            "global scope (:root/html/top-level $vars). Still confirm the token isn't overridden where the literal lives.", ""]
    for r in tm[:lim]:
        locs = ", ".join(f"`{l}`" for l in r["locations"][:5])
        more = f" +{r['count'] - 5} more" if r["count"] > 5 else ""
        out.append(f"- {r['family']} `{r['value']}` = {', '.join(r['tokens'])} — x{r['count']}: {locs}{more}")
    out.append("")

    out += [f"## Repeated literal values (>= {args.min_repeat} uses)", ""]
    for family, rows in rep.items():
        out.append(f"### {family}")
        for r in rows[:lim]:
            tok = f" (token exists: {', '.join(r['existing_tokens'])})" if r["existing_tokens"] else ""
            locs = ", ".join(f"`{l}`" for l in r["locations"][:3])
            out.append(f"- `{r['value']}` x{r['count']} in {r['files']} files{tok}: {locs}")
        out.append("")

    out += ["## Near-miss values (design decision; never auto-unify)", ""]
    for r in nm[:lim]:
        out.append(f"- {r['family']}: `{r['value']}` x{r['count']} next to `{r['near']}` x{r['near_count']}")
    out.append("")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scopes", nargs="*", default=["."], metavar="SCOPE",
                    help="one or more files, directories, or globs (default: .)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of Markdown")
    ap.add_argument("--min-repeat", type=int, default=3, help="minimum uses for a repeated value (default 3)")
    ap.add_argument("--max-list", type=int, default=60, help="max rows per Markdown section (default 60)")
    ap.add_argument("--exclude", nargs="+", action="extend", default=[], metavar="PATTERN",
                    help="skip paths: a bare name (dist, docs, *.stories.tsx) matches any folder or file name; a pattern with / (src/legacy, packages/*/fixtures) matches that path and everything under it. Repeatable; put it after the scopes, since it consumes the arguments that follow it")
    ap.add_argument("--no-js", action="store_true", help="skip CSS-in-JS / style objects in JS/TS")
    ap.add_argument("--include-hidden", action="store_true",
                    help="also scan dot-directories (.storybook, .github, ...); skipped by default")
    args = ap.parse_intermixed_args()

    exts = CSS_EXT + EMBED_EXT + (() if args.no_js else JS_EXT)
    s = Scanner()
    for p in iter_files(args.scopes, exts, args.exclude, args.include_hidden):
        s.scan_file(p)

    if args.json:
        json.dump({
            "files": s.files,
            "important": s.important,
            "zindex": s.zindex_summary(),
            "position": {f: dict(c) for f, c in s.position.items()},
            "token_matches": s.token_matches(),
            "repeated": s.repeated(args.min_repeat),
            "near_misses": s.near_misses(),
        }, sys.stdout, indent=2)
        print()
    else:
        print(render_markdown(s, args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
