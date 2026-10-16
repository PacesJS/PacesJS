import {
  ALL_TRACKS,
  DEFAULT_OPTIONS,
  DEFAULT_TRANSFORMS,
  NO_SELECTION,
  VIEW_ORDER,
  initialSnapshot,
} from './types';
import type { Selection, Snapshot, TimeRange, Transform, ViewId, ViewOptions } from './types';

const enc = encodeURIComponent;
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function encodeSelection(sel: Selection): string {
  switch (sel.kind) {
    case 'none':
      return '';
    case 'fn':
      return `fn:${sel.fn}`;
    case 'node':
      return `node:${enc(sel.track)}:${sel.path.join('.')}${sel.row === undefined ? '' : `:${sel.row}`}`;
    case 'task':
      return `task:${enc(sel.track)}:${sel.task}`;
    case 'range':
      return `range:${Math.round(sel.from)}:${Math.round(sel.to)}`;
  }
}

function int(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  return Number(s);
}

function decodePath(text: string | undefined): number[] | null {
  if (!text) return null;
  const ids = text.split('.').map((n) => int(n));
  return ids.every((n): n is number => n !== null) ? (ids as number[]) : null;
}

export function decodeSelection(text: string): Selection {
  const [kind, a, b, c] = text.split(':');
  if (kind === 'fn') {
    const fn = int(a);
    return fn === null ? NO_SELECTION : { kind: 'fn', fn };
  }
  if (kind === 'node') {
    const path = decodePath(b);
    const row = int(c);
    if (a === undefined || path === null) return NO_SELECTION;
    return { kind, track: dec(a), path, ...(row === null ? {} : { row }) };
  }
  if (kind === 'task') {
    const idx = int(b);
    return a === undefined || idx === null ? NO_SELECTION : { kind, track: dec(a), task: idx };
  }
  if (kind === 'range') {
    const from = int(a);
    const to = int(b);
    return from === null || to === null ? NO_SELECTION : { kind: 'range', from, to };
  }
  return NO_SELECTION;
}

export function encodeTransform(t: Transform): string {
  switch (t.k) {
    case 'stitch':
    case 'collapse-deps':
    case 'merge-plumbing':
    case 'drop-idle':
    case 'invert':
      return t.k;
    case 'collapse-pkg':
      return `pkg:${enc(t.pkg)}`;
    case 'merge-fn':
      return `merge:${t.fn}`;
    case 'focus-fn':
      return `focus:${t.fn}`;
    case 'focus-self':
      return `fself:${t.fn}`;
    case 'collapse-rec':
      return `rec:${t.fn}`;
    case 'drop-fn':
      return `drop:${t.fn}`;
    case 'merge-node':
      return `mnode:${t.path.join('.')}`;
    case 'focus-node':
      return `fnode:${t.path.join('.')}`;
  }
}

export function decodeTransform(text: string): Transform | null {
  const [kind, a] = text.split(':');
  switch (kind) {
    case 'stitch':
    case 'collapse-deps':
    case 'merge-plumbing':
    case 'drop-idle':
    case 'invert':
      return { k: kind };
    case 'pkg':
      return a === undefined ? null : { k: 'collapse-pkg', pkg: dec(a) };
    case 'merge':
    case 'focus':
    case 'fself':
    case 'rec':
    case 'drop': {
      const fn = int(a);
      if (fn === null) return null;
      const k = {
        merge: 'merge-fn',
        focus: 'focus-fn',
        fself: 'focus-self',
        rec: 'collapse-rec',
        drop: 'drop-fn',
      } as const;
      return { k: k[kind], fn };
    }
    case 'mnode':
    case 'fnode': {
      const path = decodePath(a);
      return path === null ? null : { k: kind === 'mnode' ? 'merge-node' : 'focus-node', path };
    }
    default:
      return null;
  }
}

function encodeOptions(o: ViewOptions): string {
  const parts: string[] = [];
  if (o.critical !== DEFAULT_OPTIONS.critical) parts.push(`crit:${o.critical ? 1 : 0}`);
  if (o.pathOnly !== DEFAULT_OPTIONS.pathOnly) parts.push(`cpo:${o.pathOnly ? 1 : 0}`);
  if (o.hide.length > 0) parts.push(`hide:${o.hide.join('.')}`);
  if (o.fnPkg !== DEFAULT_OPTIONS.fnPkg) parts.push(`fpkg:${enc(o.fnPkg)}`);
  if (o.targetOnly) parts.push('tonly:1');
  if (o.zoomPath.length > 0) parts.push(`zp:${o.zoomPath.join('.')}`);
  if (o.wfSort !== DEFAULT_OPTIONS.wfSort) parts.push(`wsort:${o.wfSort}`);
  if (o.minDurUs !== DEFAULT_OPTIONS.minDurUs) parts.push(`mind:${o.minDurUs}`);
  if (o.logical !== DEFAULT_OPTIONS.logical) parts.push(`logical:${o.logical ? 1 : 0}`);
  if (o.sort !== DEFAULT_OPTIONS.sort) parts.push(`sort:${o.sort}`);
  if (o.color !== DEFAULT_OPTIONS.color) parts.push(`color:${o.color}`);
  if (o.layout !== DEFAULT_OPTIONS.layout) parts.push(`layout:${o.layout}`);
  if (o.ego !== DEFAULT_OPTIONS.ego) parts.push(`ego:${o.ego ? 1 : 0}`);
  if (o.zoom.length > 0) parts.push(`zoom:${o.zoom.join('.')}`);
  if (o.task !== DEFAULT_OPTIONS.task) parts.push(`task:${o.task}`);
  if (o.expanded.length > 0) parts.push(`exp:${o.expanded.map(enc).join('|')}`);
  if (o.reveal.length > 0) parts.push(`rev:${o.reveal.join('.')}`);
  if (o.line !== DEFAULT_OPTIONS.line) parts.push(`line:${o.line}`);
  return parts.join(',');
}

function decodeOptions(text: string): ViewOptions {
  const o: ViewOptions = {
    ...DEFAULT_OPTIONS,
    zoom: [],
    expanded: [],
    reveal: [],
    hide: [],
    zoomPath: [],
  };
  for (const part of text.split(',')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i);
    const val = part.slice(i + 1);
    if (key === 'crit') o.critical = val === '1';
    else if (key === 'hide') o.hide = decodePath(val) ?? [];
    else if (key === 'fpkg') o.fnPkg = dec(val);
    else if (key === 'tonly') o.targetOnly = val === '1';
    else if (key === 'zp') o.zoomPath = decodePath(val) ?? [];
    else if (key === 'cpo') o.pathOnly = val === '1';
    else if (key === 'wsort' && (val === 'time' || val === 'duration' || val === 'share'))
      o.wfSort = val;
    else if (key === 'mind') o.minDurUs = Math.max(-1, int(val) ?? -1);
    else if (key === 'logical') o.logical = val === '1';
    else if (key === 'sort' && (val === 'heavy' || val === 'alpha')) o.sort = val;
    else if (key === 'color' && (val === 'origin' || val === 'self')) o.color = val;
    else if (key === 'layout' && (val === 'icicle' || val === 'flames')) o.layout = val;
    else if (key === 'ego') o.ego = val === '1';
    else if (key === 'zoom')
      o.zoom = val
        .split('.')
        .map((n) => int(n))
        .filter((n): n is number => n !== null);
    else if (key === 'task') o.task = int(val) ?? -1;
    else if (key === 'line') o.line = int(val) ?? 0;
    else if (key === 'rev') o.reveal = decodePath(val) ?? [];
    else if (key === 'exp') o.expanded = val.split('|').map(dec).filter(Boolean);
  }
  return o;
}

export function encodeRange(r: TimeRange | null): string {
  return r ? `${Math.round(r[0])}..${Math.round(r[1])}` : '';
}

export function decodeRange(text: string | null): TimeRange | null {
  if (!text) return null;
  const [a, b] = text.split('..');
  const from = int(a);
  const to = int(b);
  return from === null || to === null || to <= from ? null : [from, to];
}

const sameTransforms = (a: readonly Transform[], b: readonly Transform[]): boolean =>
  a.length === b.length &&
  a.every((t, i) => encodeTransform(t) === encodeTransform(b[i] as Transform));

/** Serialize the screen state. The leading `#` is included. */
export function snapshotToHash(s: Snapshot): string {
  const q: string[] = [`v=${s.view}`];
  if (s.track !== ALL_TRACKS) q.push(`tr=${enc(s.track)}`);
  const sel = encodeSelection(s.selection);
  if (sel) q.push(`sel=${enc(sel)}`);
  const range = encodeRange(s.range);
  if (range) q.push(`r=${range}`);
  if (!sameTransforms(s.transforms, DEFAULT_TRANSFORMS)) {
    q.push(`t=${s.transforms.map((t) => enc(encodeTransform(t))).join(',')}`);
  }
  const opts = encodeOptions(s.options);
  if (opts) q.push(`o=${enc(opts)}`);
  return `#${q.join('&')}`;
}

/** Restore the screen state; unknown or malformed parts fall back to defaults. */
export function hashToSnapshot(hash: string): Snapshot {
  const base = initialSnapshot();
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text) return base;
  const params = new Map<string, string>();
  for (const part of text.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) params.set(part.slice(0, i), part.slice(i + 1));
  }
  const view = params.get('v');
  if (view && (VIEW_ORDER as readonly string[]).includes(view)) base.view = view as ViewId;
  const tr = params.get('tr');
  if (tr) base.track = dec(tr);
  const sel = params.get('sel');
  if (sel) base.selection = decodeSelection(dec(sel));
  base.range = decodeRange(params.get('r') ?? null);
  const t = params.get('t');
  if (t !== undefined) {
    base.transforms = t
      .split(/,|%2C/i)
      .map((x) => decodeTransform(dec(x)))
      .filter((x): x is Transform => x !== null);
  }
  const o = params.get('o');
  if (o) base.options = decodeOptions(dec(o));
  return base;
}
