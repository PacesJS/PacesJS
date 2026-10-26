// Pass 2b (between ingest and classification): which process is the program being profiled?
// The entry script of each process decides the target package and tells launchers (npx, npm,
// pnpm, cross-env) from the real program. Pure: reads the capture and the ingested trees only.

import type { RunKind, TrackRole } from '../model.js';
import type { RawCapture } from '../raw.js';
import {
  basenameOf,
  globToRegExp,
  isGlob,
  isPacesInstrumentation,
  normalizeSlashes,
  packageNameFromPath,
  relativeToRoot,
  urlToPath,
} from '../util/paths.js';
import type { IngestResult, PassContext, TargetSpec } from './types.js';

export interface TargetDetection {
  /** Absolute entry script per track ('' when unknown), '/'-separated. */
  entryAbs: string[];
  /** Entry per track in model form: project-relative inside the root, absolute outside. */
  entries: string[];
  roles: TrackRole[];
  primary: number;
  spec: TargetSpec;
  /** Package names reported in `ExecutionModel.target.packages`. */
  packages: string[];
  /** The primary process is a command: its entry is in node_modules or it has arguments. */
  commandLike: boolean;
}

/** Launcher scripts by file name; `npm-prefix.js`, `npx-cli.js`, `pnpm.cjs`, `cross-env.js`. */
const LAUNCHER_FILE =
  /^(npx|npm|pnpm|pnpx|yarn|yarnpkg|corepack|cross-env|cross-env-shell|npm-run-all|run-p|run-s|concurrently|dotenv|env-cmd)([-.](cli|prefix|exec|cjs|js|mjs))*$/;
const LAUNCHER_PACKAGES = new Set([
  'npm',
  'pnpm',
  'yarn',
  'corepack',
  'cross-env',
  'npm-run-all',
  'npm-run-all2',
  'concurrently',
  'dotenv-cli',
  'env-cmd',
]);
/** A process that spawned the target and used less than this share of the busiest one is a launcher. */
const SUPPORT_BUSY_SHARE = 0.1;

function isEntryCandidate(url: string): boolean {
  return (
    url.startsWith('file:') &&
    !isPacesInstrumentation(urlToPath(url)) &&
    !url.includes('evalmachine')
  );
}

/** Launchers are recognized by the script's name or by the package that ships it. */
export function isLauncherEntry(absEntry: string): boolean {
  if (!absEntry) return false;
  const pkg = packageNameFromPath(absEntry);
  if (pkg && LAUNCHER_PACKAGES.has(pkg)) return true;
  return LAUNCHER_FILE.test(basenameOf(absEntry).replace(/\.(c|m)?js$/, ''));
}

/**
 * A browser has no launcher process: every thread is part of the page being profiled, the primary
 * track is the busiest page, and first-party code is whatever the launched site served.
 */
function detectBrowserTarget(
  capture: RawCapture,
  ingest: IngestResult,
  ctx: PassContext,
): TargetDetection {
  const strings = ctx.strings.strings;
  const n = capture.tracks.length;
  const busy = new Float64Array(n);
  ingest.tracks.forEach((ing, i) => {
    let total = 0;
    for (let node = 0; node < ing.tree.length; node++) {
      const name = strings[ingest.frames.name[ing.tree.frame[node] ?? 0] ?? 0];
      if (name !== '(idle)') total += ing.tree.self[node] ?? 0;
    }
    busy[i] = total;
  });
  let primary = -1;
  capture.tracks.forEach((t, i) => {
    if (t.info.kind !== 'page') return;
    if (primary < 0 || (busy[i] ?? 0) > (busy[primary] ?? 0)) primary = i;
  });
  if (primary < 0) {
    busy.forEach((b, i) => {
      if (primary < 0 || b > (busy[primary] ?? 0)) primary = i;
    });
  }
  if (primary < 0) primary = 0;
  const urls = capture.tracks.map((t) => t.info.url ?? '');
  const browser = capture.browser;
  const spec: TargetSpec = {
    packages: new Set(),
    globs: [],
    browser: {
      launchedUrl: browser?.url || urls[primary] || '',
      firstParty: browser?.firstParty ?? [],
    },
  };
  return {
    entryAbs: urls,
    entries: urls,
    roles: capture.tracks.map(() => 'target' as const),
    primary,
    spec,
    packages: [],
    commandLike: false,
  };
}

export function detectTarget(
  capture: RawCapture,
  ingest: IngestResult,
  ctx: PassContext,
): TargetDetection {
  if (capture.browser) return detectBrowserTarget(capture, ingest, ctx);
  const root = capture.meta.projectRoot;
  const strings = ctx.strings.strings;
  const n = capture.tracks.length;
  const entryAbs: string[] = [];
  const entries: string[] = [];
  const commandLike: boolean[] = [];
  const busy = new Float64Array(n);

  capture.tracks.forEach((track, i) => {
    const argv = track.info.argv;
    let abs = '';
    const second = argv?.[1];
    // A worker thread shares its process's argv; its own script is the first one it loaded.
    if (track.info.kind !== 'worker' && second && !second.startsWith('-')) {
      abs = normalizeSlashes(second);
    }
    if (abs === '') {
      const script = track.scripts.find((s) => isEntryCandidate(s.url));
      if (script) abs = urlToPath(script.url);
    }
    entryAbs.push(abs);
    entries.push(abs ? relativeToRoot(abs, root) : '');
    commandLike.push(
      (abs !== '' && packageNameFromPath(abs) !== '') || (argv !== undefined && argv.length > 2),
    );

    const ing = ingest.tracks[i];
    if (!ing) return;
    let total = 0;
    for (let node = 0; node < ing.tree.length; node++) {
      const name = strings[ingest.frames.name[ing.tree.frame[node] ?? 0] ?? 0];
      if (name !== '(idle)') total += ing.tree.self[node] ?? 0;
    }
    busy[i] = total;
  });

  const idOf = new Map<string, number>();
  capture.tracks.forEach((t, i) => idOf.set(t.info.id, i));
  const parentOf = (i: number): number => idOf.get(capture.tracks[i]?.info.parent ?? '') ?? -1;
  const isWorker = (i: number): boolean => capture.tracks[i]?.info.kind === 'worker';
  const processes: number[] = [];
  for (let i = 0; i < n; i++) if (!isWorker(i)) processes.push(i);
  const spawned = new Uint8Array(n);
  for (const i of processes) {
    for (let a = parentOf(i), hops = 0; a >= 0 && hops < n; a = parentOf(a), hops++) {
      if (!isWorker(a)) spawned[a] = 1;
    }
  }
  let maxBusy = 0;
  for (const i of processes) maxBusy = Math.max(maxBusy, busy[i] ?? 0);

  const support = new Uint8Array(n);
  for (const i of processes) {
    const quiet = (busy[i] ?? 0) < maxBusy * SUPPORT_BUSY_SHARE && spawned[i] === 1;
    support[i] = isLauncherEntry(entryAbs[i] ?? '') || quiet ? 1 : 0;
  }
  const busiest = (skipSupport: boolean): number => {
    let best = -1;
    for (const i of processes) {
      if (skipSupport && support[i] === 1) continue;
      if (best < 0 || (busy[i] ?? 0) > (busy[best] ?? 0)) best = i;
    }
    return best;
  };
  let primary = busiest(true);
  if (primary < 0) {
    // Only launchers were profiled (e.g. `npm install`): the busiest one is the program.
    primary = busiest(false);
    if (primary >= 0) support[primary] = 0;
  }
  if (primary < 0) primary = 0;

  const roles: TrackRole[] = [];
  for (let i = 0; i < n; i++) {
    if (!isWorker(i)) roles.push(support[i] === 1 ? 'support' : 'target');
    else {
      const p = parentOf(i);
      roles.push(p >= 0 && support[p] === 1 ? 'support' : 'target');
    }
  }

  const spec: TargetSpec = { packages: new Set(), globs: [] };
  const focus = ctx.options.focus ?? [];
  if (focus.length > 0) {
    for (const entry of focus) {
      if (!isGlob(entry)) spec.packages.add(entry);
      else {
        try {
          spec.globs.push(globToRegExp(entry));
        } catch {
          ctx.warnings.push({ kind: 'invalid-focus', severity: 'warn', detail: entry });
        }
      }
    }
  } else {
    const pkg = packageNameFromPath(entryAbs[primary] ?? '');
    if (pkg) spec.packages.add(pkg);
  }
  return {
    entryAbs,
    entries,
    roles,
    primary,
    spec,
    packages: [...spec.packages],
    commandLike: commandLike[primary] ?? false,
  };
}

/** Process name for labels: the target's package, else the script's name without extension. */
export function processName(absEntry: string, support: boolean): string {
  if (!absEntry) return 'main';
  const base = basenameOf(absEntry).replace(/\.(c|m)?[jt]s$/, '');
  const pkg = packageNameFromPath(absEntry);
  if (support) {
    return (isLauncherEntry(absEntry) ? base.replace(/-cli$/, '') : base) || pkg || 'main';
  }
  return pkg || base || 'main';
}

export function runKindOf(input: {
  override: RunKind | undefined;
  browser?: boolean;
  hasRequests: boolean;
  listening: boolean;
  commandLike: boolean;
}): RunKind {
  if (input.override) return input.override;
  if (input.browser) return 'page';
  if (input.hasRequests || input.listening) return 'server';
  return input.commandLike ? 'cli' : 'script';
}
