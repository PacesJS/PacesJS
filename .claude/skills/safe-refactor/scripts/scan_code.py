#!/usr/bin/env python3
"""Scan source code for structural refactoring leads.

Reports long functions and components, long parameter lists, components with many
props, deep control-flow nesting, large files, comment-heavy files, commented-out
code, and comments that merely restate the next line.

JS/TS/JSX/TSX use a heuristic tokenizer (strings, templates, regexes, and comments
are blanked before analysis). Python uses the `ast` and `tokenize` modules.
Other languages are counted for file length only.

Usage: scan_code.py [SCOPE ...] [--json] [--max-lines 60] [--max-params 4] [--max-props 8]
                    [--max-depth 4] [--max-file-lines 500] [--top 40] [--exclude PATTERN ...]
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import re
import sys
import tokenize
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import iter_files, line_of, looks_generated, read_text  # noqa: E402

JS_EXT = (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts")
PY_EXT = (".py",)
OTHER_EXT = (".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".vue", ".svelte")

CONTROL_KEYWORDS = {"if", "for", "while", "switch", "catch", "with"}
BLOCK_KEYWORDS = {"else", "try", "do", "finally"}
NOT_METHODS = CONTROL_KEYWORDS | {"function", "return", "typeof", "new", "await", "super", "constructor_"}
REGEX_PRECEDERS = set("(,=:[!&|?;{+-*%<>~^")
REGEX_KEYWORDS = {"return", "typeof", "case", "do", "else", "in", "of", "delete", "void", "throw", "yield", "await"}

DIRECTIVE_RE = re.compile(
    r"^\s*(eslint|@ts-|istanbul|c8 |v8 |webpack|vite-|prettier-ignore|biome-ignore|jshint|global |"
    r"noqa|type:|pylint:|pragma|fmt:|isort:|mypy:|pyright:|@flow|@jsx|@refresh|#region|#endregion|"
    r"tslint|stylelint|@vite-ignore|@license|@preserve|!|/ <reference)", re.I)
TODO_RE = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
CODE_STRONG_RE = re.compile(
    r"^(const|let|var)\s+[\w${\[][^=]*=|^import\s.+\sfrom\s|^import\s+['\"]|"
    r"^export\s+(default\s+)?(const|let|function|class|type|interface|\{)|"
    r"^(if|for|while|switch)\s*\(.*\)\s*\{?.*$|^\}\s*(else\b.*)?\{?\s*$|^\{\s*$|"
    r"^return\s+[\w.$'\"\[({!-]+(\s*[-+*/%(\[.;?&|<>=].*)?$|^return;?$|"
    r"^[\w.$\[\]]+\s*(=|\+=|-=|\*=|\|\|=|\?\?=)\s*[^=\s].*$|"
    r"^(await\s+)?[\w.$]+\(.*\)\s*;?\s*$|console\.\w+\(|=>\s*[{(]?\s*$|"
    r"^(def|class)\s+\w+.*:\s*$|^(if|elif|for|while|with|try|except|else|finally)\b.*:\s*$|"
    r"^<\/?[A-Za-z][\w.]*(\s[^>]*)?\/?>\s*$"
)
PROSE_RUN_RE = re.compile(r"(?:\b[A-Za-z']+\b[ ,]+){3,}\b[A-Za-z']+\b")
STRING_RE = re.compile(r"'[^']*'|\"[^\"]*\"|`[^`]*`")


def is_continuation(text: str) -> bool:
    """A comment line that continues a commented-out code block (e.g. '//   isIOS ||')."""
    t = text.strip()
    return bool(t) and not PROSE_RUN_RE.search(STRING_RE.sub("''", t)) and bool(re.search(r"[(){}\[\],;.|&=+\-*/<>?:]", t))


def looks_like_code(text: str) -> bool:
    t = text.strip()
    if len(t) < 4 or t.startswith(("@", "*")):
        return False
    if PROSE_RUN_RE.search(STRING_RE.sub("''", t)):
        return False
    return bool(CODE_STRONG_RE.search(t))


WORD_RE = re.compile(r"[A-Za-z]{3,}")
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
STOPWORDS = set("""the and for this that with from into then than else when will are was were has have
had not but its use used using get gets set sets new add adds make makes return returns value values
here now just also only all any can should must may let var const our your their them they which""".split())


@dataclass
class Func:
    file: str
    line: int
    name: str
    kind: str
    lines: int
    logical_lines: int
    params: int
    destructured: int
    depth: int


@dataclass
class FileStat:
    file: str
    lines: int
    code_lines: int = 0
    comment_lines: int = 0
    commented_out: list = field(default_factory=list)   # [(line, size)]
    restating: list = field(default_factory=list)       # [(line, comment)]
    todos: int = 0


# ---------------------------------------------------------------------------
# JS/TS
# ---------------------------------------------------------------------------

def sanitize_js(src: str) -> tuple[str, list[tuple[int, str, bool]]]:
    """Blank strings, templates, regexes, and comments (same length, newlines kept).

    Returns (sanitized_source, comments) where comments are (offset, text, is_line_comment).
    """
    out = list(src)
    comments: list[tuple[int, str, bool]] = []
    n = len(src)
    i = 0
    stack: list[int] = []  # template frames: brace depth inside ${ }
    last_sig = ""          # last significant (non-space) char in code
    last_word = ""

    def blank(a: int, b: int) -> None:
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    def scan_template(j: int) -> tuple[int, bool]:
        """From inside a template at j, return (index after closing ` or ${, opened_interpolation)."""
        while j < n:
            c = src[j]
            if c == "\\":
                j += 2
                continue
            if c == "`":
                return j + 1, False
            if src.startswith("${", j):
                return j + 2, True
            j += 1
        return n, False

    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j == -1 else j
            comments.append((i, src[i + 2:j], True))
            blank(i, j)
            i = j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j == -1 else j + 2
            comments.append((i, src[i + 2:j - 2], False))
            blank(i, j)
            i = j
            continue
        if c in "'\"":
            if c == "'" and i > 0 and src[i - 1].isalnum():
                i += 1  # apostrophe in JSX text (e.g. Don't)
                continue
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            blank(i + 1, j)
            i = j + 1
            last_sig = c
            continue
        if c == "`":
            j, opened = scan_template(i + 1)
            blank(i + 1, j - (2 if opened else 1))
            if opened:
                stack.append(0)
                last_sig = "{"
            else:
                last_sig = "`"
            i = j
            continue
        if c == "/" and (not last_sig or last_sig in REGEX_PRECEDERS or last_word in REGEX_KEYWORDS) \
                and last_sig != "<" and not src.startswith("/>", i):
            j = i + 1
            in_class = False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            if j < n and src[j] == "/":
                blank(i + 1, j)
                i = j + 1
                while i < n and src[i].isalpha():
                    i += 1
                last_sig = "/"
                last_word = ""
                continue
        if stack:
            if c == "{":
                stack[-1] += 1
            elif c == "}":
                if stack[-1] == 0:
                    stack.pop()
                    j, opened = scan_template(i + 1)
                    blank(i + 1, j - (2 if opened else 1))
                    if opened:
                        stack.append(0)
                    i = j
                    last_sig = "`"
                    continue
                stack[-1] -= 1
        if c.isalnum() or c in "_$":
            m = IDENT_RE.match(src, i)
            if m:
                last_word = m.group(0)
                last_sig = last_word[-1]
                i = m.end()
                continue
        last_sig = c
        last_word = ""
        i += 1
    return "".join(out), comments


JSX_RE = re.compile(r"(return|=>|[(?:,&|])\s*<[A-Za-z>]|createElement\(")


def looks_like_jsx(body: str) -> bool:
    return bool(JSX_RE.search(body))


def match_forward(s: str, i: int, open_ch: str, close_ch: str) -> int:
    """Given s[i] == open_ch, return index of the matching close_ch (or -1)."""
    depth = 0
    for k in range(i, len(s)):
        if s[k] == open_ch:
            depth += 1
        elif s[k] == close_ch:
            depth -= 1
            if depth == 0:
                return k
    return -1


def match_backward(s: str, i: int, open_ch: str, close_ch: str) -> int:
    depth = 0
    for k in range(i, -1, -1):
        if s[k] == close_ch:
            depth += 1
        elif s[k] == open_ch:
            depth -= 1
            if depth == 0:
                return k
    return -1


def split_top_level(params: str) -> list[str]:
    parts, depth, cur = [], 0, []
    for ch in params:
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def count_destructured(param: str) -> int:
    p = param.strip()
    if p.startswith("{"):
        end = match_forward(p, 0, "{", "}")
        inner = p[1:end] if end > 0 else p[1:]
        return len([x for x in split_top_level(inner) if not x.startswith("...")])
    return 0


def skip_ws_back(s: str, i: int) -> int:
    while i >= 0 and s[i] in " \t\r\n":
        i -= 1
    return i


def word_before(s: str, i: int) -> tuple[str, int]:
    i = skip_ws_back(s, i)
    j = i
    while j >= 0 and (s[j].isalnum() or s[j] in "_$"):
        j -= 1
    return s[j + 1:i + 1], j


def control_depth(s: str, start: int, end: int) -> int:
    stack: list[bool] = []
    best = 0
    for k in range(start + 1, end):
        ch = s[k]
        if ch == "{":
            prev = skip_ws_back(s, k - 1)
            is_ctrl = False
            if prev >= 0 and s[prev] == ")":
                op = match_backward(s, prev, "(", ")")
                if op > 0:
                    w, _ = word_before(s, op - 1)
                    is_ctrl = w in CONTROL_KEYWORDS
            else:
                w, _ = word_before(s, k - 1)
                is_ctrl = w in BLOCK_KEYWORDS
            stack.append(is_ctrl)
            best = max(best, sum(stack))
        elif ch == "}" and stack:
            stack.pop()
    return best


def name_for(s: str, before: int) -> tuple[str, bool]:
    """Infer a function name from the text before `function`/params. Returns (name, is_callback)."""
    i = skip_ws_back(s, before)
    w, j = word_before(s, i)
    if w == "async":
        i = skip_ws_back(s, j)
        w, j = word_before(s, i)
    if i >= 0 and s[i] == "=" and (i == 0 or s[i - 1] not in "=!<>"):
        # const name = ... / name = ... (may have a type annotation)
        k = skip_ws_back(s, i - 1)
        seg = s[max(0, k - 120):k + 1]
        m = re.search(r"([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?$", seg)
        if m:
            return m.group(1), False
    if i >= 0 and s[i] == ":":
        w2, _ = word_before(s, i - 1)
        if w2:
            return w2, False
    if i >= 0 and s[i] in "(,":
        op = i if s[i] == "(" else match_backward(s, i, "(", ")")
        if op > 0:
            callee, _ = word_before(s, op - 1)
            if callee:
                return f"{callee}(callback)", True
        return "<anonymous>", True
    return "<anonymous>", True


def analyze_js(path: str, src: str, stat: FileStat) -> list[Func]:
    s, comments = sanitize_js(src)
    is_jsx = path.endswith((".jsx", ".tsx"))
    funcs: list[Func] = []
    seen_bodies: set[int] = set()

    def add(name: str, kind: str, params_open: int, params_close: int, body_open: int) -> None:
        if body_open in seen_bodies or body_open < 0 or s[body_open] != "{":
            return
        body_close = match_forward(s, body_open, "{", "}")
        if body_close < 0:
            return
        seen_bodies.add(body_open)
        params = split_top_level(s[params_open + 1:params_close]) if params_open >= 0 else []
        params = [p for p in params if not re.match(r"^this\s*:", p)]
        destructured = count_destructured(params[0]) if len(params) == 1 else 0
        start_line = line_of(s, params_open if params_open >= 0 else body_open)
        end_line = line_of(s, body_close)
        body_lines = s[body_open:body_close + 1].splitlines()
        logical = sum(1 for ln in body_lines if ln.strip() not in {"", "{", "}", "};", "},", ");", ")"})
        if is_jsx and name[:1].isupper() and kind != "method" and looks_like_jsx(s[body_open:body_close]):
            kind = "component"
        funcs.append(Func(path, start_line, name, kind, end_line - start_line + 1, logical, len(params),
                          destructured, control_depth(s, body_open, body_close)))

    # function declarations / expressions
    for m in re.finditer(r"\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(<[^>(]*>)?\s*\(", s):
        po = m.end() - 1
        pc = match_forward(s, po, "(", ")")
        if pc < 0:
            continue
        k = pc + 1
        rest = s[k:k + 200]
        mm = re.match(r"\s*(?::\s*[^{;]*?)?\s*\{", rest)
        if not mm:
            continue
        name = m.group(1)
        is_cb = False
        if not name:
            name, is_cb = name_for(s, m.start() - 1)
        add(name, "callback" if is_cb else "function", po, pc, k + mm.end() - 1)

    # arrow functions
    for m in re.finditer(r"=>\s*\{", s):
        arrow = m.start()
        body = m.end() - 1
        p_end = skip_ws_back(s, arrow - 1)
        # strip a return-type annotation: (a): Foo =>
        if p_end >= 0 and s[p_end] != ")":
            seg = s[max(0, p_end - 200):p_end + 1]
            rt = re.search(r"\)\s*:\s*[^()=;]*$", seg)
            if rt:
                p_end = p_end - (len(seg) - rt.start() - 1)
        if p_end >= 0 and s[p_end] == ")":
            po = match_backward(s, p_end, "(", ")")
            if po < 0:
                continue
            pc = p_end
            before = po - 1
            # generic type params: <T,>(x) =>
            b = skip_ws_back(s, before)
            if b >= 0 and s[b] == ">":
                lt = match_backward(s, b, "<", ">")
                before = lt - 1 if lt > 0 else before
        else:
            w, j = word_before(s, p_end)
            if not w:
                continue
            po, pc = -1, -1
            before = j
            name, is_cb = name_for(s, before)
            body_close = match_forward(s, body, "{", "}")
            if body_close < 0 or body in seen_bodies:
                continue
            seen_bodies.add(body)
            start_line = line_of(s, j + 1)
            logical = sum(1 for ln in s[body:body_close + 1].splitlines() if ln.strip() not in {"", "{", "}", "};", "},"})
            kind = "callback" if is_cb else (
                "component" if is_jsx and name[:1].isupper() and looks_like_jsx(s[body:body_close]) else "arrow")
            funcs.append(Func(path, start_line, name, kind, line_of(s, body_close) - start_line + 1, logical, 1, 0,
                              control_depth(s, body, body_close)))
            continue
        name, is_cb = name_for(s, before)
        add(name, "callback" if is_cb else "arrow", po, pc, body)

    # class / object methods:  name(args) {   possibly with modifiers and return types
    method_re = re.compile(
        r"^[ \t]*(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*"
        r"\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(", re.M)
    for m in method_re.finditer(s):
        name = m.group(1)
        if name in NOT_METHODS or name in CONTROL_KEYWORDS:
            continue
        po = m.end() - 1
        pc = match_forward(s, po, "(", ")")
        if pc < 0:
            continue
        mm = re.match(r"\s*(?::\s*[^{;=]*?)?\s*\{", s[pc + 1:pc + 200])
        if not mm:
            continue
        add(name, "method", po, pc, pc + 1 + mm.end() - 1)

    analyze_comments_js(src, s, comments, stat)
    return funcs


def code_tokens(line: str) -> set[str]:
    toks = set()
    for ident in IDENT_RE.findall(line):
        for part in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+", ident.replace("_", " ").replace("$", " ")):
            if len(part) >= 3:
                toks.add(part.lower())
    return toks


def is_restating(comment: str, next_code: str) -> bool:
    words = [w.lower() for w in WORD_RE.findall(comment)]
    words = [w for w in words if w not in STOPWORDS]
    if not (2 <= len(words) <= 6) or len(comment.strip()) > 70 or TODO_RE.search(comment):
        return False
    if re.search(r"\b(because|why|since|otherwise|workaround|note|hack|see|https?|issue|bug|until|avoid|must|ensure|"
                 r"not|no|only|never|always|cannot|can't|don't|fine|allow|unless|if|so|in case|e\.g|i\.e|\w+n't)\b"
                 r"|[?!:]\s*$|\w:\s|=", comment, re.I):
        return False
    toks = code_tokens(next_code)
    if not toks:
        return False
    hits = sum(1 for w in words if any(t.startswith(w[:4]) or w.startswith(t[:4]) for t in toks))
    return hits / len(words) >= 0.6


def analyze_comments_js(src: str, sanitized: str, comments: list[tuple[int, str, bool]], stat: FileStat) -> None:
    src_lines = src.splitlines()
    san_lines = sanitized.splitlines()
    stat.code_lines = sum(1 for ln in san_lines if ln.strip())
    comment_line_set: set[int] = set()
    run_start, run_len, prev_line = None, 0, -10
    for off, text, is_line in comments:
        ln = line_of(src, off)
        span = text.count("\n") + 1
        for k in range(ln, ln + span):
            comment_line_set.add(k)
        body = text.lstrip("*! ").rstrip()
        if TODO_RE.search(text):
            stat.todos += 1
        if DIRECTIVE_RE.match(text) or DIRECTIVE_RE.match(body):
            continue
        is_doc = not is_line and text.startswith("*")
        content_lines = [l.strip() for l in text.splitlines()] if not is_line else [text.strip()]
        code_like = [l for l in content_lines if l and looks_like_code(l)]
        if not is_doc and code_like and len(code_like) >= max(1, (len([l for l in content_lines if l]) + 1) // 2):
            if ln == prev_line + 1 and run_start is not None:
                run_len += span
            else:
                if run_start is not None:
                    stat.commented_out.append((run_start, run_len))
                run_start, run_len = ln, span
            prev_line = ln + span - 1
            continue
        if is_line and run_start is not None and ln == prev_line + 1 and is_continuation(text):
            run_len += 1
            prev_line = ln
            continue
        if is_line and ln < len(src_lines):
            # comment on its own line, directly followed by a code line
            own_line = src_lines[ln - 1].strip().startswith("//")
            nxt = ln  # 0-based index of next line
            if own_line and nxt < len(san_lines) and san_lines[nxt].strip() and \
                    (nxt + 1 not in comment_line_set) and is_restating(text, src_lines[nxt]):
                prev_is_comment = ln - 1 in comment_line_set
                if not prev_is_comment:
                    stat.restating.append((ln, text.strip()))
    if run_start is not None:
        stat.commented_out.append((run_start, run_len))
    stat.comment_lines = len(comment_line_set)


# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------

class _Depth(ast.NodeVisitor):
    NEST = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.With, ast.AsyncWith)

    def __init__(self) -> None:
        self.cur = 0
        self.best = 0

    def generic_visit(self, node: ast.AST) -> None:
        nested = isinstance(node, self.NEST) or type(node).__name__ in {"Match", "TryStar"}
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return  # nested definitions are measured separately
        if nested:
            self.cur += 1
            self.best = max(self.best, self.cur)
        super().generic_visit(node)
        if nested:
            self.cur -= 1


def analyze_py(path: str, src: str, stat: FileStat) -> list[Func]:
    funcs: list[Func] = []
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return funcs
    lines = src.splitlines()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = node.args
            names = [x.arg for x in a.posonlyargs + a.args + a.kwonlyargs]
            kind = "method" if names and names[0] in {"self", "cls"} else "function"
            if kind == "method":
                names = names[1:]
            params = len(names) + (1 if a.vararg else 0) + (1 if a.kwarg else 0)
            d = _Depth()
            for child in node.body:
                d.visit(child)
            end = getattr(node, "end_lineno", node.lineno)
            start = min([node.lineno] + [dec.lineno for dec in node.decorator_list])
            body = lines[node.lineno - 1:end]
            logical = sum(1 for ln in body if ln.strip() and not ln.strip().startswith("#"))
            funcs.append(Func(path, start, node.name, kind, end - start + 1, logical, params, 0, d.best))

    # comments
    comment_rows: list[tuple[int, str]] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.COMMENT:
                comment_rows.append((tok.start[0], tok.string[1:].strip()))
    except (tokenize.TokenError, IndentationError):
        pass
    comment_lines = {r for r, _ in comment_rows}
    stat.comment_lines = len(comment_lines)
    stat.code_lines = sum(1 for i, ln in enumerate(lines, 1) if ln.strip() and i not in comment_lines)
    run_start, run_len, prev = None, 0, -10
    for row, text in comment_rows:
        if TODO_RE.search(text):
            stat.todos += 1
        if DIRECTIVE_RE.match(text) or row == 1 and text.startswith("!"):
            continue
        if text and looks_like_code(text):
            if row == prev + 1 and run_start is not None:
                run_len += 1
            else:
                if run_start is not None:
                    stat.commented_out.append((run_start, run_len))
                run_start, run_len = row, 1
            prev = row
            continue
        if run_start is not None and row == prev + 1 and is_continuation(text):
            run_len += 1
            prev = row
            continue
        own_line = lines[row - 1].lstrip().startswith("#")
        if own_line and row < len(lines) and row + 1 not in comment_lines and row - 1 not in comment_lines \
                and lines[row].strip() and is_restating(text, lines[row]):
            stat.restating.append((row, text))
    if run_start is not None:
        stat.commented_out.append((run_start, run_len))
    return funcs


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scopes", nargs="*", default=["."], metavar="SCOPE",
                    help="one or more files, directories, or globs (default: .)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--max-lines", type=int, default=60, help="function length threshold (default 60)")
    ap.add_argument("--max-component-lines", type=int, default=200, help="component length threshold (default 200)")
    ap.add_argument("--max-params", type=int, default=4)
    ap.add_argument("--max-props", type=int, default=8)
    ap.add_argument("--max-depth", type=int, default=4)
    ap.add_argument("--max-file-lines", type=int, default=500)
    ap.add_argument("--comment-ratio", type=float, default=0.35, help="flag files whose comment/code ratio exceeds this")
    ap.add_argument("--top", type=int, default=40, help="rows per section")
    ap.add_argument("--include-tests", action="store_true", help="include test files (excluded by default)")
    ap.add_argument("--exclude", nargs="+", action="extend", default=[], metavar="PATTERN",
                    help="skip paths: a bare name (dist, docs, *.stories.tsx) matches any folder or file name; a pattern with / (src/legacy, packages/*/fixtures) matches that path and everything under it. Repeatable; put it after the scopes, since it consumes the arguments that follow it")
    ap.add_argument("--include-hidden", action="store_true",
                    help="also scan dot-directories (.storybook, .github, ...); skipped by default")
    args = ap.parse_intermixed_args()

    exclude = list(args.exclude)
    if not args.include_tests:
        exclude += ["*.test.*", "*.spec.*", "__tests__", "tests", "test", "e2e", "test_*.py", "*_test.py",
                    "conftest.py", "*.stories.*"]

    funcs: list[Func] = []
    stats: list[FileStat] = []
    skipped_generated: list[str] = []
    for p in iter_files(args.scopes, JS_EXT + PY_EXT + OTHER_EXT, exclude, args.include_hidden):
        src = read_text(p)
        if src is None:
            continue
        if looks_generated(src):
            skipped_generated.append(p.as_posix())
            continue
        stat = FileStat(p.as_posix(), src.count("\n") + (0 if src.endswith("\n") else 1))
        if p.suffix.lower() in JS_EXT:
            funcs += analyze_js(p.as_posix(), src, stat)
        elif p.suffix.lower() in PY_EXT:
            funcs += analyze_py(p.as_posix(), src, stat)
        stats.append(stat)

    def too_long(f: Func) -> bool:
        limit = args.max_component_lines if f.kind == "component" else args.max_lines
        return f.logical_lines > limit

    long_funcs = sorted([f for f in funcs if too_long(f)], key=lambda f: -f.logical_lines)
    many_params = sorted([f for f in funcs if f.params > args.max_params], key=lambda f: -f.params)
    many_props = sorted([f for f in funcs if f.destructured > args.max_props], key=lambda f: -f.destructured)
    deep = sorted([f for f in funcs if f.depth > args.max_depth], key=lambda f: -f.depth)
    big_files = sorted([s for s in stats if s.lines > args.max_file_lines], key=lambda s: -s.lines)
    chatty = sorted([s for s in stats if s.code_lines >= 20 and s.comment_lines / max(1, s.code_lines) > args.comment_ratio],
                    key=lambda s: -(s.comment_lines / max(1, s.code_lines)))
    commented_out = [(s.file, ln, n) for s in stats for ln, n in s.commented_out]
    restating = [(s.file, ln, c) for s in stats for ln, c in s.restating]

    if args.json:
        json.dump({
            "files": len(stats), "functions": len(funcs),
            "long_functions": [asdict(f) for f in long_funcs],
            "many_params": [asdict(f) for f in many_params],
            "many_props": [asdict(f) for f in many_props],
            "deep_nesting": [asdict(f) for f in deep],
            "large_files": [{"file": s.file, "lines": s.lines} for s in big_files],
            "comment_heavy_files": [{"file": s.file, "comment_lines": s.comment_lines, "code_lines": s.code_lines} for s in chatty],
            "commented_out_code": [{"file": f, "line": ln, "lines": n} for f, ln, n in commented_out],
            "restating_comments": [{"file": f, "line": ln, "comment": c} for f, ln, c in restating],
            "todo_count": sum(s.todos for s in stats),
            "skipped_generated": skipped_generated,
        }, sys.stdout, indent=2)
        print()
        return 0

    t = args.top
    o = ["# Code scan", "",
         "Heuristic leads, not verdicts. Read the code before classifying (see references/smells.md).", "",
         "| Metric | Value |", "| --- | --- |",
         f"| Files scanned | {len(stats)} |",
         f"| Functions/components found | {len(funcs)} |",
         f"| Functions over {args.max_lines} logical lines (components over {args.max_component_lines}) | {len(long_funcs)} |",
         f"| Functions with more than {args.max_params} params | {len(many_params)} |",
         f"| Components with more than {args.max_props} destructured props | {len(many_props)} |",
         f"| Control-flow nesting deeper than {args.max_depth} | {len(deep)} |",
         f"| Files over {args.max_file_lines} lines | {len(big_files)} |",
         f"| Commented-out code blocks | {len(commented_out)} |",
         f"| Likely restating comments | {len(restating)} |",
         f"| TODO/FIXME/HACK | {sum(s.todos for s in stats)} |",
         f"| Skipped as generated | {len(skipped_generated)} |", ""]

    def fn_row(f: Func, extra: str) -> str:
        return f"- `{f.file}:{f.line}` **{f.name}** ({f.kind}) {extra}"

    o += ["## Long functions and components", ""]
    o += [fn_row(f, f"{f.logical_lines} logical / {f.lines} total lines, {f.params} params, depth {f.depth}") for f in long_funcs[:t]]
    o += ["", "## Long parameter lists", ""]
    o += [fn_row(f, f"{f.params} params") for f in many_params[:t]]
    o += ["", "## Components / functions with many destructured props", ""]
    o += [fn_row(f, f"{f.destructured} props") for f in many_props[:t]]
    o += ["", "## Deep control-flow nesting", ""]
    o += [fn_row(f, f"depth {f.depth}") for f in deep[:t]]
    o += ["", "## Large files", ""]
    o += [f"- `{s.file}` {s.lines} lines" for s in big_files[:t]]
    o += ["", f"## Comment-heavy files (comment/code ratio > {args.comment_ratio})", ""]
    o += [f"- `{s.file}` {s.comment_lines} comment lines / {s.code_lines} code lines" for s in chatty[:t]]
    o += ["", "## Commented-out code (dead code; git keeps history)", ""]
    o += [f"- `{f}:{ln}` {n} line(s)" for f, ln, n in commented_out[:t]]
    o += ["", "## Comments that likely restate the next line", ""]
    o += [f"- `{f}:{ln}` // {c}" for f, ln, c in restating[:t]]
    o.append("")
    print("\n".join(o))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
