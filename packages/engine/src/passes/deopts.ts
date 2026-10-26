// V8's deoptimization trace -> a table of deopts per function. The trace comes from `--trace-deopt`
// and names the function V8 deoptimized and the source position that made it give up; the engine
// ties each position to the function whose code it is, so a deopt in inlined code lands on the
// function to fix rather than on its caller.

import type { DeoptTable } from '../model.js';
import type { RawCapture } from '../raw.js';
import { urlToPath } from '../util/paths.js';
import type { FrameTable, PassContext } from './types.js';

interface Position {
  path: string;
  line: number;
  col: number;
}

export interface DeoptEvent extends Position {
  /** `eager` (this code's own assumption failed), `lazy` (a dependency changed) or `soft`. */
  kind: string;
  reason: string;
  /** Tier the deoptimized code was compiled for: MAGLEV, TURBOFAN_JS, ... */
  tier: string;
  /** Name V8 gave the function it deoptimized; empty for an anonymous function. */
  fn: string;
  /** Set when the position is in inlined code: where that code was inlined. */
  inlinedAt?: Position;
}

// The reason can contain parentheses ("... (OSR)"); the function name can be empty.
const HEADER =
  /^\[bailout \(kind: deopt-([a-z]+), reason: (.*?)\): begin\. deoptimizing \S+ <JSFunction ?(.*?) ?\(sfi = [^)]*\)>, \S+ <Code ([A-Z_]+)>/;
const SITE = /;;; deoptimize at <(.+?):(\d+):(\d+)>(?: inlined at <(.+?):(\d+):(\d+)>)?/;

/** Reads the condensed trace: each `[bailout ...` line followed by its `;;; deoptimize at` line. */
export function parseDeoptTrace(text: string): DeoptEvent[] {
  const lines = text.split('\n');
  const events: DeoptEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = HEADER.exec(lines[i] ?? '');
    if (!header) continue;
    const site = SITE.exec(lines[i + 1] ?? '');
    if (!site) continue;
    events.push({
      kind: header[1] ?? '',
      reason: header[2] ?? '',
      tier: header[4] ?? '',
      fn: header[3] ?? '',
      path: urlToPath(site[1] ?? ''),
      line: Number(site[2]),
      col: Number(site[3]),
      ...(site[4]
        ? { inlinedAt: { path: urlToPath(site[4]), line: Number(site[5]), col: Number(site[6]) } }
        : {}),
    });
  }
  return events;
}

const KINDS = ['eager', 'lazy', 'soft'];
/** A kind this engine does not know: kept apart so no rule mistakes it for an eager deopt. */
const OTHER_KIND = KINDS.length;

interface FileFrames {
  /** Frame ids ordered by start position, with their 0-based starts alongside. */
  frame: number[];
  line: number[];
  col: number[];
}

function framesByFile(frames: FrameTable, strings: string[]): Map<string, FileFrames> {
  const byFile = new Map<string, Array<{ frame: number; line: number; col: number }>>();
  for (let f = 0; f < frames.length; f++) {
    const line = frames.line[f] ?? -1;
    if (line < 0) continue;
    const path = urlToPath(strings[frames.url[f] ?? 0] ?? '');
    const list = byFile.get(path) ?? [];
    list.push({ frame: f, line, col: frames.col[f] ?? 0 });
    byFile.set(path, list);
  }
  const out = new Map<string, FileFrames>();
  for (const [path, list] of byFile) {
    list.sort((a, b) => a.line - b.line || a.col - b.col || a.frame - b.frame);
    out.set(path, {
      frame: list.map((x) => x.frame),
      line: list.map((x) => x.line),
      col: list.map((x) => x.col),
    });
  }
  return out;
}

/** The last frame that starts at or before the 1-based position, or -1. */
function frameAt(file: FileFrames, line1: number, col1: number): number {
  const line = line1 - 1;
  const col = col1 - 1;
  let lo = 0;
  let hi = file.frame.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const before =
      (file.line[mid] ?? 0) < line || (file.line[mid] === line && (file.col[mid] ?? 0) <= col);
    if (before) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? -1 : (file.frame[found] ?? -1);
}

const isAnonymous = (name: string): boolean => name === '' || name === '(anonymous)';

/**
 * One row per (function, reason, kind, position) with how often it happened. Only functions that are
 * in the profile can be matched; a deopt in code that was never sampled has nothing to attach to.
 */
export function buildDeoptTable(
  capture: RawCapture,
  frames: FrameTable,
  frameToFn: Uint32Array,
  ctx: PassContext,
  originalLine: (frame: number, line: number, col: number) => number,
): DeoptTable {
  const strings = ctx.strings.strings;
  const files = framesByFile(frames, strings);
  const counts = new Map<
    string,
    {
      fn: number;
      reason: string;
      kind: number;
      line: number;
      col: number;
      origLine: number;
      proc: string;
      count: number;
    }
  >();
  for (const track of capture.tracks) {
    if (!track.deoptTrace) continue;
    for (const e of parseDeoptTrace(track.deoptTrace)) {
      const file = files.get(e.path);
      if (!file) continue;
      const frame = frameAt(file, e.line, e.col);
      if (frame < 0) continue;
      // Not inlined: the position is inside the function V8 named, so the names must agree.
      if (!e.inlinedAt) {
        const name = strings[frames.name[frame] ?? 0] ?? '';
        if (isAnonymous(e.fn) ? !isAnonymous(name) : e.fn !== name) continue;
      }
      const fn = frameToFn[frame] ?? 0;
      const known = KINDS.indexOf(e.kind);
      const kind = known < 0 ? OTHER_KIND : known;
      const key = `${track.info.id}|${fn}|${e.reason}|${kind}|${e.line}|${e.col}`;
      const row = counts.get(key);
      if (row) row.count++;
      else {
        counts.set(key, {
          fn,
          reason: e.reason,
          kind,
          line: e.line,
          col: e.col,
          origLine: originalLine(frame, e.line, e.col),
          proc: track.info.id,
          count: 1,
        });
      }
    }
  }
  const rows = [...counts.values()].sort(
    (a, b) =>
      (a.proc < b.proc ? -1 : a.proc > b.proc ? 1 : 0) ||
      a.fn - b.fn ||
      a.line - b.line ||
      a.col - b.col ||
      a.kind - b.kind ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
  const table: DeoptTable = {
    length: rows.length,
    fn: new Uint32Array(rows.length),
    reason: new Uint32Array(rows.length),
    kind: new Uint8Array(rows.length),
    line: new Uint32Array(rows.length),
    col: new Uint32Array(rows.length),
    origLine: new Uint32Array(rows.length),
    proc: new Uint32Array(rows.length),
    count: new Uint32Array(rows.length),
  };
  rows.forEach((r, i) => {
    table.fn[i] = r.fn;
    table.reason[i] = ctx.strings.intern(r.reason);
    table.kind[i] = r.kind;
    table.line[i] = r.line;
    table.col[i] = r.col;
    table.origLine[i] = r.origLine;
    table.proc[i] = ctx.strings.intern(r.proc);
    table.count[i] = r.count;
  });
  return table;
}
