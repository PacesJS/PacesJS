/** Pure helpers for the source panel: line windows and a tiny syntax tokenizer. */

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
