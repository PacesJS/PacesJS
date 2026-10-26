// Runs the passes in their fixed order and assembles the execution model.

import { DEFAULT_THRESHOLDS, ENGINE_VERSION } from './config.js';
import type { AnalyzeOptions } from './config.js';
import { Origin } from './model.js';
import type { ExecutionModel, FunctionTable, Track } from './model.js';
import { aggregateTrack, mergePackages } from './passes/aggregate.js';
import type { TrackAggregateResult } from './passes/aggregate.js';
import { stitchAsync } from './passes/async.js';
import { bridgeRuntimeSamples } from './passes/bridge.js';
import { stitchContinuations } from './passes/continuations.js';
import { toCallTree } from './passes/call-tree.js';
import { classify } from './passes/classification.js';
import { findIssues } from './passes/findings.js';
import { segmentBrowserTasks } from './passes/tasks-browser.js';
import type { ModelEvent } from './passes/tasks-browser.js';
import { buildInputs, buildPageTimeline, buildRender } from './passes/timeline.js';
import { buildDeoptTable } from './passes/deopts.js';
import { ingest } from './passes/ingest.js';
import { foldModuleLoading } from './passes/module-loading.js';
import { detectPlumbing } from './passes/plumbing.js';
import { resolveSourceMaps } from './passes/source-maps.js';
import { reconstructSpans } from './passes/spans.js';
import { segmentTasks } from './passes/tasks.js';
import { detectTarget, processName, runKindOf } from './passes/target.js';
import type { TargetDetection } from './passes/target.js';
import type { IngestResult, PassContext, WarningDraft } from './passes/types.js';
import { buildWarnings, lostTrackDrafts } from './passes/warnings.js';
import type { RawCapture } from './raw.js';
import { displayPath, packageNameFromPath } from './util/paths.js';
import { createStringTable } from './util/strings.js';

const LISTEN_NAMES = new Set(['listen', 'Server.listen', 'setupListenHandle', 'onconnection']);
const LISTEN_FILES = /^node:(net|_http_server|http2|internal\/(http2|net))/;

/** A server was started in a target process: `net.Server.listen` shows up in its call tree. */
function hasListeningServer(ing: IngestResult, strings: string[], tracks: number[]): boolean {
  const listening = new Uint8Array(ing.frames.length);
  for (let f = 0; f < ing.frames.length; f++) {
    const url = strings[ing.frames.url[f] ?? 0] ?? '';
    listening[f] =
      LISTEN_FILES.test(url) && LISTEN_NAMES.has(strings[ing.frames.name[f] ?? 0] ?? '') ? 1 : 0;
  }
  return tracks.some((t) => {
    const tree = ing.tracks[t]?.tree;
    if (!tree) return false;
    for (let n = 0; n < tree.length; n++) if (listening[tree.frame[n] ?? 0] === 1) return true;
    return false;
  });
}

/** Appends a first-party function row for each track's entry script; they never appear in a raw call tree. */
function withEntryFunctions(
  base: FunctionTable,
  detection: TargetDetection,
  ctx: PassContext,
  byEntry: Map<string, number>,
): { functions: FunctionTable; rootOf: number[] } {
  const rootOf: number[] = [];
  const added: Array<{ name: number; file: number; pkg: number }> = [];
  detection.entries.forEach((entry, i) => {
    const key = entry || `(entry ${i})`;
    let id = byEntry.get(key);
    if (id === undefined) {
      id = base.length + added.length;
      byEntry.set(key, id);
      const abs = detection.entryAbs[i] ?? '';
      const pkg = packageNameFromPath(abs);
      added.push({
        name: ctx.strings.intern(entry ? displayPath(entry) : '(entry)'),
        file: ctx.strings.intern(entry),
        pkg: pkg && detection.spec.packages.has(pkg) ? ctx.strings.intern(pkg) : 0,
      });
    }
    rootOf.push(id);
  });
  const n = base.length + added.length;
  const grow = <T extends Uint8Array | Uint32Array>(a: T, fill: (k: number) => number): T => {
    const out = new (a.constructor as new (len: number) => T)(n);
    out.set(a);
    added.forEach((_, k) => {
      out[base.length + k] = fill(k);
    });
    return out;
  };
  return {
    rootOf,
    functions: {
      length: n,
      name: grow(base.name, (k) => added[k]?.name ?? 0),
      file: grow(base.file, (k) => added[k]?.file ?? 0),
      line: grow(base.line, () => 1),
      col: grow(base.col, () => 0),
      origin: grow(base.origin, () => Origin.User),
      pkg: grow(base.pkg, (k) => added[k]?.pkg ?? 0),
      plumbing: grow(base.plumbing, () => 0),
      mapped: grow(base.mapped, () => 0),
      mapMissing: grow(base.mapMissing, () => 0),
      loader: grow(base.loader, () => 0),
    },
  };
}

function trackLabel(
  info: { kind: string; label: string; pid?: number; threadId?: number },
  detection: TargetDetection,
  index: number,
  browser: boolean,
): string {
  // Browser tracks were named when the trace was converted: page, iframe, worker.
  if (browser) return info.label;
  const support = detection.roles[index] === 'support';
  const suffix = support ? ' (supporting)' : '';
  if (info.kind === 'worker') {
    const thread = info.threadId ?? 0;
    return `worker ${thread} · thread ${thread}${suffix}`;
  }
  const entry = detection.entryAbs[index] ?? '';
  if (!entry) return `${info.label}${suffix}`;
  const name = processName(entry, support);
  const pid = info.pid === undefined ? '' : ` · pid ${info.pid}`;
  return `${name}${pid}${suffix}`;
}

interface TrackStage {
  ing: IngestResult;
  sm: ReturnType<typeof resolveSourceMaps>;
  functions: FunctionTable;
  detection: TargetDetection;
  rootOf: number[];
  ctx: PassContext;
  /** Browser runs: the user's events in model time, for naming the tasks that handled them. */
  browser?: { marks: Array<{ time: number; label: string; kind: string }> };
}

/** Passes 5-8 for one track: call tree, spans, tasks, async edges, continuations and aggregates. */
function buildTrack(
  raw: IngestResult['tracks'][number],
  index: number,
  { ing, sm, functions, detection, rootOf, ctx, browser }: TrackStage,
): { track: Track; aggregate: TrackAggregateResult } {
  const tree = toCallTree(raw.tree, sm.frameToFn);
  const spans = reconstructSpans({
    tree,
    samples: raw.samples,
    origin: functions.origin,
    gapUs: ing.precisionUs * 3,
  });
  const taskInput = { tree, samples: raw.samples, spans, functions, requests: raw.events.requests };
  const tasks =
    browser && raw.timeline
      ? segmentBrowserTasks(
          {
            ...taskInput,
            marks: browser.marks,
            timeline: raw.timeline
              .map((e): ModelEvent => ({
                name: e.name,
                start: e.ts - ing.monoAtStartUs,
                dur: e.dur,
                ...(e.arg ? { arg: e.arg } : {}),
              }))
              .sort((a, b) => a.start - b.start || b.dur - a.dur),
          },
          ctx,
        )
      : segmentTasks(taskInput, ctx);
  const asyncEdges = stitchAsync({ records: raw.async, tasks: tasks.table });
  const continuations = stitchContinuations({
    spans,
    tasks: tasks.table,
    asyncEdges,
    functions,
    precisionUs: ing.precisionUs,
  });
  const result = aggregateTrack({
    tree,
    samples: raw.samples,
    spans,
    tasks: tasks.table,
    taskSampleStart: tasks.sampleStart,
    taskSampleEnd: tasks.sampleEnd,
    tickOffset: raw.ticks.offset,
    tickLine: sm.tickLines[index] ?? new Uint32Array(0),
    tickCount: raw.ticks.ticks,
    hits: raw.tree.hits,
    functions,
  });
  const n = raw.samples.length;
  const durationUs =
    n === 0
      ? 0
      : (raw.samples.time[n - 1] ?? 0) + (raw.samples.dur[n - 1] ?? 0) - (raw.samples.time[0] ?? 0);
  const track: Track = {
    id: raw.info.id,
    kind: raw.info.kind,
    label: trackLabel(raw.info, detection, index, browser !== undefined),
    role: detection.roles[index] ?? 'target',
    entry: detection.entries[index] ?? '',
    rootFn: rootOf[index] ?? 0,
    ...(raw.info.parent ? { parent: raw.info.parent } : {}),
    callTree: tree,
    samples: raw.samples,
    spans,
    tasks: tasks.table,
    asyncEdges,
    continuations,
    events: raw.events,
    lines: result.lines,
    agg: result.agg,
    fnIds: result.fnIds,
    busyUs: result.busyUs,
    durationUs,
  };
  return { track, aggregate: result };
}

/** Missing source maps: a problem in the target's own code, expected noise in dependencies. */
function missingMapDrafts(functions: FunctionTable, ctx: PassContext): WarningDraft[] {
  const mapDrafts: WarningDraft[] = [];
  const invalid = new Set(
    ctx.warnings.filter((w) => w.kind === 'source-map-invalid').map((w) => w.detail),
  );
  for (let f = 0; f < functions.length; f++) {
    if (functions.mapMissing[f] !== 1) continue;
    if (invalid.has(ctx.strings.strings[functions.file[f] ?? 0] ?? '')) continue;
    const o = functions.origin[f] ?? Origin.User;
    const dependency = o === Origin.Dependency || o === Origin.Framework;
    const file = ctx.strings.strings[functions.file[f] ?? 0] ?? '';
    // The user can add a map to their own project, not to a published package they only run.
    const published = !dependency && packageNameFromPath(file) !== '';
    mapDrafts.push({
      kind: dependency
        ? 'dependency-source-map-missing'
        : published
          ? 'target-package-source-map-missing'
          : 'source-map-missing',
      severity: dependency || published ? 'info' : 'warn',
      detail: dependency || published ? displayPath(file) : file,
    });
  }
  return mapDrafts;
}

export function analyze(capture: RawCapture, options: AnalyzeOptions = {}): ExecutionModel {
  const ctx: PassContext = {
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
    options,
    strings: createStringTable(),
    warnings: [],
  };

  // 1-4: per-function passes. The target is detected first: it decides which functions are first-party.
  const ingested = ingest(capture, ctx);
  const ing =
    options.bridgeRuntimeSamples === false
      ? ingested
      : bridgeRuntimeSamples(ingested, ctx.strings.strings);
  const detection = detectTarget(capture, ing, ctx);
  ctx.target = detection.spec;
  const sm = resolveSourceMaps({ capture, ingest: ing }, ctx);
  const classification = classify(sm.functions, ctx);
  const plumbing = detectPlumbing({ functions: sm.functions, classification }, ctx);
  const { loader } = foldModuleLoading({ functions: sm.functions, classification, plumbing }, ctx);
  const base: FunctionTable = {
    length: sm.functions.length,
    name: sm.functions.name,
    file: sm.functions.file,
    line: sm.functions.line,
    col: sm.functions.col,
    origin: classification.origin,
    pkg: classification.pkg,
    plumbing,
    mapped: sm.functions.mapped,
    mapMissing: sm.functions.mapMissing,
    loader,
  };
  // One function row per distinct entry script: the root of that run in stitched views.
  const rootFns = new Map<string, number>();
  const { functions, rootOf } = withEntryFunctions(base, detection, ctx, rootFns);

  // 5-8: per-track passes.
  const startedAt = capture.meta.startedAt;
  const marks = (capture.meta.marks ?? []).map((m) => ({
    time: (m.at - startedAt) * 1000,
    label: m.label,
    kind: m.kind ?? 'manual',
  }));
  const stage: TrackStage = {
    ing,
    sm,
    functions,
    detection,
    rootOf,
    ctx,
    ...(capture.browser ? { browser: { marks } } : {}),
  };
  const built = ing.tracks.map((raw, index) => buildTrack(raw, index, stage));
  const tracks = built.map((x) => x.track);
  // Browser pages also have exact rendering work and user input, beside the samples.
  let page: ExecutionModel['page'];
  if (capture.browser) {
    ing.tracks.forEach((raw, i) => {
      const track = tracks[i];
      const isMain =
        track?.kind === 'page' || track?.kind === 'frame' || track?.kind === 'extension';
      if (!track || !raw.timeline || !isMain) return;
      track.render = buildRender(raw.timeline, ing.monoAtStartUs);
      if (i === detection.primary) {
        track.inputs = buildInputs(
          capture.meta.marks ?? [],
          startedAt,
          raw.timeline,
          ing.monoAtStartUs,
          track.tasks,
          ctx,
        );
      }
    });
    page = buildPageTimeline(
      capture.browser,
      capture.tracks[detection.primary]?.info.pid,
      ing.monoAtStartUs,
    );
  }
  const aggregates = built.map((x) => x.aggregate);

  const { packages, taskKinds } = mergePackages(aggregates, ctx.strings.strings);

  const targetTracks: number[] = [];
  tracks.forEach((t, i) => {
    if (t.role === 'target') targetTracks.push(i);
  });
  const runKind = runKindOf({
    override: options.runKind,
    browser: capture.browser !== undefined,
    hasRequests: ing.tracks.some(
      (t, i) => detection.roles[i] === 'target' && t.events.requests.time.length > 0,
    ),
    listening: hasListeningServer(ing, ctx.strings.strings, targetTracks),
    commandLike: detection.commandLike,
  });

  const mapDrafts = missingMapDrafts(functions, ctx);

  const model: ExecutionModel = {
    meta: {
      ...capture.meta,
      precisionUs: ing.precisionUs,
      durationUs: ing.durationUs,
      engineVersion: ENGINE_VERSION,
      warnings: [],
      runKind,
      ...(capture.browser
        ? {
            browser: {
              product: capture.browser.product,
              url: capture.browser.url,
              clockErrorUs: capture.browser.clock.errorUs,
              anchored: capture.browser.clock.anchored,
              offsetUs: capture.browser.clock.offsetUs,
              ...(capture.browser.throttle ? { throttle: capture.browser.throttle } : {}),
              ...(capture.browser.cacheCold ? { cacheCold: true } : {}),
              segments: capture.browser.segments.length,
              ...(capture.browser.traceFilter
                ? {
                    traceFilter: {
                      version: capture.browser.traceFilter.version,
                      excludedCategories: capture.browser.traceFilter.excludedCategories,
                      keptEvents: capture.browser.traceFilter.keptEvents,
                      droppedEvents: capture.browser.traceFilter.droppedEvents,
                    },
                  }
                : {}),
            },
          }
        : {}),
    },
    strings: ctx.strings.strings,
    functions,
    tracks,
    packages,
    taskKinds,
    findings: [],
    deopts: buildDeoptTable(capture, ing.frames, sm.frameToFn, ctx, sm.originalLine),
    target: {
      packages: detection.packages,
      entry: detection.entries[detection.primary] ?? '',
      kind: runKind,
    },
    primaryTrack: detection.primary,
    ...(page ? { page } : {}),
  };
  // 9: findings read the finished model.
  model.findings = findIssues(model, ctx);
  model.meta.warnings = buildWarnings([
    ...ctx.warnings,
    ...lostTrackDrafts(capture.meta.lostTracks),
    ...dedupeFiles(mapDrafts),
  ]);
  return model;
}

/** One draft per file: several functions of the same file share a missing map. */
function dedupeFiles(drafts: WarningDraft[]): WarningDraft[] {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = `${d.kind}|${d.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
