/** Pure helpers for the source panel: line windows and a tiny syntax tokenizer. */

const TEXT = {
  samples: (count: number) => `${count} sample${count === 1 ? '' : 's'}`,
  across: (samples: string, across: string) => `${samples} ${across}.`,
  approximate: (samples: string) =>
    `About ${samples}: below the measurement precision, so the time on this line is approximate.`,
  rolledUp: (lineCount: number, lines: string) =>
    `V8 reported this time on line${lineCount > 1 ? 's' : ''} ${lines}, inside this statement.`,
} as const;

export interface LineWindow {
  /** 1-based first and last line shown. */
  first: number;
  last: number;
}

/** Find the last line of the function that starts at `startLine` by matching braces. */
export function functionEnd(lines: readonly string[], startLine: number): number {
  let depth = 0;
  let opened = false;
  for (let i = Math.max(0, startLine - 1); i < Math.min(lines.length, startLine + 400); i++) {
    const text = (lines[i] ?? '').replace(
      /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
      '',
    );
    for (const ch of text) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (opened && depth <= 0) return i + 1;
  }
  return Math.min(lines.length, startLine + 24);
}

/** First and last line of the function in `lines` (for the Source view's band). */
export function functionBand(texts: readonly string[], startLine: number): LineWindow | null {
  if (texts.length === 0 || startLine <= 0) return null;
  return { first: startLine, last: functionEnd(texts, startLine) };
}

export function lineWindow(
  lines: readonly string[],
  startLine: number,
  context = 2,
  maxLines = 120,
): LineWindow {
  if (lines.length === 0) return { first: 1, last: 0 };
  const start = Math.min(Math.max(1, startLine), lines.length);
  const end = functionEnd(lines, start);
  const first = Math.max(1, start - context);
  const last = Math.min(lines.length, Math.min(end + context, first + maxLines - 1));
  return { first, last };
}

export type TokenKind = 'plain' | 'keyword' | 'string' | 'fn';

export interface Token {
  text: string;
  kind: TokenKind;
}

const TOKEN_RE =
  /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/(?![/*])(?:[^/\\\n]|\\.)+\/[gimsuy]*)|\b(export|function|const|let|var|if|else|return|for|of|in|new|true|false|null|async|await|class|import|from|throw|try|catch|typeof)\b|([A-Za-z_$][\w$]*)(?=\()/g;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), kind: 'plain' });
    out.push({ text: m[0], kind: m[1] ? 'string' : m[2] ? 'keyword' : 'fn' });
    last = TOKEN_RE.lastIndex;
  }
  if (last < src.length) out.push({ text: src.slice(last), kind: 'plain' });
  return out;
}

/** Bar width in px: at least 3 for any self time, 52 for the hottest line. */
export function gutterWidth(selfUs: number, maxSelfUs: number): number {
  if (selfUs <= 0 || maxSelfUs <= 0) return 0;
  return Math.max(3, Math.round((selfUs / maxSelfUs) * 52));
}

export interface RolledLine {
  /** Line the time is shown on: the first line of the statement. */
  line: number;
  selfUs: number;
  /** Lines V8 reported that were folded into this one (empty when nothing moved). */
  from: number[];
}

/** A tick this far below its statement start is not rolled up: the bracket scan is likely off. */
const MAX_ROLL_LINES = 25;
const BLOCK_WORDS = new Set(['else', 'try', 'finally', 'do']);

/**
 * How many brackets (and object literals) are still open at the start of each line, counted from
 * `fromLine`. A line that starts inside an open call or literal continues the statement above it.
 * A block `{` (function body, if, loop) starts afresh, so statements in a callback do not count as
 * continuations of the call that holds it. Strings, template literals and comments are skipped.
 */
function openDepthAtLineStart(
  lines: readonly string[],
  fromLine: number,
  toLine: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const stack: number[] = [];
  let depth = 0;
  let inBlockComment = false;
  let inTemplate = false;
  let lastSig = '';
  let lastWord = '';
  let word = '';
  const endWord = (): void => {
    if (word) lastWord = word;
    word = '';
  };
  for (let n = Math.max(1, fromLine); n <= Math.min(toLine, lines.length); n++) {
    out.set(n, depth);
    const src = lines[n - 1] ?? '';
    let quote = '';
    for (let i = 0; i < src.length; i++) {
      const ch = src.charAt(i);
      const next = src.charAt(i + 1);
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') i++;
        else if (ch === '`') inTemplate = false;
        continue;
      }
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        endWord();
        quote = ch;
        lastSig = ch;
        continue;
      }
      if (ch === '`') {
        endWord();
        inTemplate = true;
        lastSig = ch;
        continue;
      }
      if (/[\w$]/.test(ch)) {
        word += ch;
        lastSig = ch;
        continue;
      }
      endWord();
      if (/\s/.test(ch)) continue;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === '{') {
        const block =
          lastSig === ')' ||
          lastSig === '>' ||
          lastSig === '' ||
          lastSig === ';' ||
          lastSig === '{' ||
          lastSig === '}' ||
          (BLOCK_WORDS.has(lastWord) && /[\w$]/.test(lastSig));
        stack.push(depth);
        depth = block ? 0 : depth + 1;
      } else if (ch === '}') {
        depth = stack.pop() ?? 0;
      }
      lastSig = ch;
    }
  }
  return out;
}

/**
 * V8 reports time at bytecode positions, and inside a multi-line call, argument or object literal
 * that position can be any of its lines. Reading `signal: controller?.signal,` as the cost of that
 * property is misleading; the cost belongs to the statement, so it is shown on the statement's first
 * line, with the lines V8 reported kept for a tooltip.
 */
export function rollUpToStatements(
  lines: readonly string[],
  ticks: ReadonlyArray<{ line: number; selfUs: number }>,
  fromLine: number,
): RolledLine[] {
  const last = ticks.reduce((m, t) => Math.max(m, t.line), 0);
  const depths = openDepthAtLineStart(lines, fromLine, last);
  const byLine = new Map<number, RolledLine>();
  for (const t of ticks) {
    let start = t.line;
    while (start > fromLine && (depths.get(start) ?? 0) > 0 && t.line - start < MAX_ROLL_LINES) {
      start--;
    }
    const target =
      (depths.get(start) ?? 0) > 0 && t.line - start >= MAX_ROLL_LINES ? t.line : start;
    const hit = byLine.get(target) ?? { line: target, selfUs: 0, from: [] };
    hit.selfUs += t.selfUs;
    if (target !== t.line && !hit.from.includes(t.line)) hit.from.push(t.line);
    byLine.set(target, hit);
  }
  return [...byLine.values()]
    .map((r) => ({ ...r, from: [...r.from].sort((a, b) => a - b) }))
    .sort((a, b) => a.line - b.line);
}

/** Under two sampling intervals is about one sample: too little to trust as a cost (as in the waterfall). */
export function isLowConfidence(selfUs: number, precisionUs: number): boolean {
  return precisionUs > 0 && selfUs < 2 * precisionUs;
}

/** "1 sample" / "3 samples": how many sampling intervals the time stands for, at least one. */
export function sampleLabel(selfUs: number, precisionUs: number): string {
  const n = Math.max(1, precisionUs > 0 ? Math.round(selfUs / precisionUs) : 1);
  return TEXT.samples(n);
}

/** Tooltip for a line's gutter: why a faint bar is approximate, and where V8 put rolled-up time. */
export function gutterTitle(
  selfUs: number,
  precisionUs: number,
  from: readonly number[],
  across = '',
): string {
  if (selfUs <= 0) return '';
  const parts: string[] = [];
  // The bar is a sum over every call of the function, a handful of samples at most.
  if (across) parts.push(TEXT.across(sampleLabel(selfUs, precisionUs), across));
  if (isLowConfidence(selfUs, precisionUs)) {
    parts.push(TEXT.approximate(sampleLabel(selfUs, precisionUs)));
  }
  if (from.length > 0) {
    parts.push(TEXT.rolledUp(from.length, from.join(', ')));
  }
  return parts.join(' ');
}
