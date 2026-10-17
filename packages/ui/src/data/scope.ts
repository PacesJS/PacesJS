import { Origin, applyTransforms, describeFunction } from '@pacesjs/engine';
import type {
  ExecutionModel,
  FunctionInfo,
  OriginId,
  Track,
  Transform as EngineTransform,
  TransformedView,
} from '@pacesjs/engine';
import type { TimeRange, Transform } from '../state/types';

/** Per-model lookups the adapter needs: stable package ids and the dependency package list. */
export interface ModelCtx {
  model: ExecutionModel;
  /** Every package name, sorted. Collapsed-package ids are `functions.length + index`, stable. */
  pkgs: string[];
  depPkgs: string[];
}

export function modelCtx(model: ExecutionModel): ModelCtx {
  const all = new Set<string>();
  const deps = new Set<string>();
  const f = model.functions;
  for (let fn = 0; fn < f.length; fn++) {
    const pkg = model.strings[f.pkg[fn] ?? 0] ?? '';
    if (!pkg) continue;
    all.add(pkg);
    if (f.origin[fn] === Origin.Dependency) deps.add(pkg);
  }
  return { model, pkgs: [...all].sort(), depPkgs: [...deps].sort() };
}

/**
 * The engine works on one track. "All tracks" has no engine query, so the default resolves to the
 * target process (`model.primaryTrack`), and so does an unknown id.
 */
export function trackIndexOf(model: ExecutionModel, id: string): number {
  const i = model.tracks.findIndex((t) => t.id === id);
  return i < 0 ? model.primaryTrack : i;
}

/**
 * Display order of the tracks: the target process first, then the other target tracks (its
 * workers), then supporting launcher processes such as npx.
 */
export function trackOrder(model: ExecutionModel): number[] {
  const rank = (i: number): number =>
    i === model.primaryTrack ? 0 : model.tracks[i]?.role === 'support' ? 2 : 1;
  return model.tracks.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || a - b);
}

/**
 * UI transform stack to engine stack. A collapsed package keeps its dependency collapse except
 * for the packages expanded in place, which is how the call graph opens a package.
 */
export function toEngineStack(
  ctx: ModelCtx,
  ui: readonly Transform[],
  expanded: readonly string[],
  range: TimeRange | null,
  hide: readonly number[] = [],
): EngineTransform[] {
  const F = ctx.model.functions.length;
  const out: EngineTransform[] = [];
  // Stitching grafts whole stacks, so the engine only honours it as the first step.
  if (ui.some((t) => t.k === 'stitch')) out.push({ kind: 'stitch-continuations' });
  if (range) out.push({ kind: 'time-range', start: range[0], end: range[1] });
  const paths = (p: number[]): boolean => p.every((id) => id < F);
  for (const t of ui) {
    switch (t.k) {
      case 'stitch':
        break;
      case 'collapse-deps':
        if (expanded.length === 0) out.push({ kind: 'collapse-dependencies' });
        else
          for (const pkg of ctx.depPkgs)
            if (!expanded.includes(pkg)) out.push({ kind: 'collapse-package', pkg });
        break;
      case 'merge-plumbing':
        out.push({ kind: 'merge-plumbing' });
        break;
      case 'drop-idle':
        out.push({ kind: 'drop-idle' });
        break;
      case 'invert':
        out.push({ kind: 'invert' });
        break;
      case 'collapse-pkg':
        if (!expanded.includes(t.pkg)) out.push({ kind: 'collapse-package', pkg: t.pkg });
        break;
      case 'merge-fn':
        if (t.fn < F) out.push({ kind: 'merge-function', fn: t.fn });
        break;
      case 'focus-fn':
        if (t.fn < F) out.push({ kind: 'focus-function', fn: t.fn });
        break;
      case 'focus-self':
        if (t.fn < F) out.push({ kind: 'focus-function-self', fn: t.fn });
        break;
      case 'collapse-rec':
        if (t.fn < F) out.push({ kind: 'collapse-recursion', fn: t.fn });
        break;
      case 'drop-fn':
        if (t.fn < F) out.push({ kind: 'drop-samples', fn: t.fn });
        break;
      case 'merge-node':
        if (paths(t.path)) out.push({ kind: 'merge-node', path: t.path });
        break;
      case 'focus-node':
        if (paths(t.path)) out.push({ kind: 'focus-subtree', path: t.path });
        break;
    }
  }
  // Last, so what the other transforms collapsed counts as dependencies and self time moves up.
  if (hide.length > 0) out.push({ kind: 'hide-origins', origins: [...hide] as OriginId[] });
  return out;
}

/** A transformed view plus the id translation between the UI's stable ids and the view's own. */
export interface Scoped {
  ctx: ModelCtx;
  view: TransformedView;
  trackIndex: number;
  track: Track;
  /** Engine view function id to the UI's stable id (collapsed packages sorted by name). */
  out(fn: number): number;
  /** UI stable id to this view's id, or -1 when the package is not collapsed in this view. */
  inn(fn: number): number;
  info(fn: number): FunctionInfo;
}

export function scopeView(ctx: ModelCtx, trackIndex: number, stack: EngineTransform[]): Scoped {
  const { model } = ctx;
  const F = model.functions.length;
  const view = applyTransforms(model, trackIndex, stack);
  const syn = view.syntheticPackages;
  const track = model.tracks[trackIndex] as Track;
  const out = (fn: number): number => {
    if (fn < F) return fn;
    const at = ctx.pkgs.indexOf(syn[fn - F] ?? '');
    return at < 0 ? fn : F + at;
  };
  const inn = (fn: number): number => {
    if (fn < F) return fn;
    const at = syn.indexOf(ctx.pkgs[fn - F] ?? '');
    return at < 0 ? -1 : F + at;
  };
  const info = (fn: number): FunctionInfo => {
    const engineFn = inn(fn);
    if (engineFn >= 0) return describeFunction(model, engineFn, syn);
    return describeFunction(model, F, [ctx.pkgs[fn - F] ?? '']);
  };
  return { ctx, view, trackIndex, track, out, inn, info };
}

/** The function's name, or `(anonymous)` for one without. */
export function nameOrAnon(name: string): string {
  return name || '(anonymous)';
}

/** `file:line`, or just the file when the line is unknown. */
export function fileLine(file: string, line: number): string {
  return line > 0 ? `${file}:${line}` : file;
}

/** `file:line`, `node_modules/pkg` for a collapsed package, or '' when there is no file. */
export function locationOf(info: FunctionInfo): string {
  if (info.synthetic) return `node_modules/${info.pkg}`;
  if (!info.file) return '';
  return fileLine(info.file, info.line);
}
