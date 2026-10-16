import type { ExecutionModel, Track } from '@pacesjs/engine';

/** Typed-array read that is never undefined (noUncheckedIndexedAccess). */
export function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0;
}

export function str(model: ExecutionModel, id: number): string {
  return model.strings[id] ?? '';
}

export const ORIGIN_IDLE = 5;
export const ORIGIN_DEP = 1;
export const ORIGIN_GC = 6;

export function fnName(model: ExecutionModel, fn: number): string {
  const n = str(model, at(model.functions.name, fn));
  if (n) return n;
  return '(anonymous)';
}

/** `file:line` for display, with a project-relative path when the file lives under the root. */
export function fnLocation(model: ExecutionModel, fn: number): string {
  const file = str(model, at(model.functions.file, fn));
  if (!file) return '';
  const line = at(model.functions.line, fn);
  const rel = relativePath(file, model.meta.projectRoot);
  return line > 0 ? `${rel}:${line}` : rel;
}

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

export function relativePath(file: string, root: string): string {
  let f = normalizeSlashes(file);
  if (f.startsWith('file:///')) f = decodeURIComponent(f.slice(8));
  else if (f.startsWith('file://')) f = decodeURIComponent(f.slice(7));
  const r = normalizeSlashes(root).replace(/\/+$/, '');
  if (r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1);
  return f;
}

export function packageOf(model: ExecutionModel, fn: number): string {
  return str(model, at(model.functions.pkg, fn));
}

export function selectTracks(model: ExecutionModel, trackId: string): Track[] {
  if (trackId === 'all') return model.tracks;
  const t = model.tracks.find((x) => x.id === trackId);
  return t ? [t] : model.tracks;
}

export function trackById(model: ExecutionModel, id: string): Track | undefined {
  return model.tracks.find((t) => t.id === id);
}
