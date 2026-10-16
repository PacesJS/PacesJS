// Runs the passes in their fixed order and assembles the execution model.

import { DEFAULT_THRESHOLDS, ENGINE_VERSION } from './config.js';
import type { AnalyzeOptions } from './config.js';
import { Origin } from './model.js';
import type { ExecutionModel, FunctionTable, Track } from './model.js';
import { aggregateTrack, mergePackages } from './passes/aggregate.js';
import type { TrackAggregateResult } from './passes/aggregate.js';
import { stitchAsync } from './passes/async.js';
import { toCallTree } from './passes/call-tree.js';
import { classify } from './passes/classification.js';
import { findIssues } from './passes/findings.js';
import { ingest } from './passes/ingest.js';
import { foldModuleLoading } from './passes/module-loading.js';
import { detectPlumbing } from './passes/plumbing.js';
import { resolveSourceMaps } from './passes/source-maps.js';
import { reconstructSpans } from './passes/spans.js';
import { segmentTasks } from './passes/tasks.js';
import { detectTarget, processName, runKindOf } from './passes/target.js';
import type { TargetDetection } from './passes/target.js';
import type { IngestResult, PassContext, WarningDraft } from './passes/types.js';
import { buildWarnings } from './passes/warnings.js';
import type { RawCapture } from './raw.js';
import { displayPath } from './util/paths.js';
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

function trackLabel(
  info: { kind: string; label: string; pid?: number; threadId?: number },
  detection: TargetDetection,
  index: number,
): string {
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

export function analyze(capture: RawCapture, options: AnalyzeOptions = {}): ExecutionModel {
  const ctx: PassContext = {
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
    options,
    strings: createStringTable(),
    warnings: [],
  };

  // 1-4: per-function passes. The target is detected first: it decides which functions are first-party.
  const ing = ingest(capture, ctx);
  const detection = detectTarget(capture, ing, ctx);
  ctx.target = detection.spec;
  const sm = resolveSourceMaps({ capture, ingest: ing }, ctx);
  const classification = classify(sm.functions, ctx);
  const plumbing = detectPlumbing({ functions: sm.functions, classification }, ctx);
  const { loader } = foldModuleLoading({ functions: sm.functions, classification, plumbing }, ctx);
  const functions: FunctionTable = {
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

  // 5-8: per-track passes.
  const tracks: Track[] = [];
  const aggregates: TrackAggregateResult[] = [];
  ing.tracks.forEach((raw, index) => {
    const tree = toCallTree(raw.tree, sm.frameToFn);
    const spans = reconstructSpans({
      tree,
      samples: raw.samples,
      origin: functions.origin,
      gapUs: ing.precisionUs * 3,
    });
    const tasks = segmentTasks(
      { tree, samples: raw.samples, spans, functions, requests: raw.events.requests },
      ctx,
    );
    const asyncEdges = stitchAsync({ records: raw.async, tasks: tasks.table });
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
    aggregates.push(result);
    const n = raw.samples.length;
    const durationUs =
      n === 0
        ? 0
        : (raw.samples.time[n - 1] ?? 0) +
          (raw.samples.dur[n - 1] ?? 0) -
          (raw.samples.time[0] ?? 0);
    tracks.push({
      id: raw.info.id,
      kind: raw.info.kind,
      label: trackLabel(raw.info, detection, index),
      role: detection.roles[index] ?? 'target',
      entry: detection.entries[index] ?? '',
      ...(raw.info.parent ? { parent: raw.info.parent } : {}),
      callTree: tree,
      samples: raw.samples,
      spans,
      tasks: tasks.table,
      asyncEdges,
      events: raw.events,
      lines: result.lines,
      agg: result.agg,
      fnIds: result.fnIds,
      busyUs: result.busyUs,
      durationUs,
    });
  });

  const { packages, taskKinds } = mergePackages(aggregates, ctx.strings.strings);

  const targetTracks: number[] = [];
  tracks.forEach((t, i) => {
    if (t.role === 'target') targetTracks.push(i);
  });
  const runKind = runKindOf({
    override: options.runKind,
    hasRequests: ing.tracks.some(
      (t, i) => detection.roles[i] === 'target' && t.events.requests.time.length > 0,
    ),
    listening: hasListeningServer(ing, ctx.strings.strings, targetTracks),
    commandLike: detection.commandLike,
  });

  // Missing source maps: a problem in the target's own code, expected noise in dependencies.
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
    mapDrafts.push({
      kind: dependency ? 'dependency-source-map-missing' : 'source-map-missing',
      severity: dependency ? 'info' : 'warn',
      detail: dependency ? displayPath(file) : file,
    });
  }

  const model: ExecutionModel = {
    meta: {
      ...capture.meta,
      precisionUs: ing.precisionUs,
      durationUs: ing.durationUs,
      engineVersion: ENGINE_VERSION,
      warnings: [],
      runKind,
    },
    strings: ctx.strings.strings,
    functions,
    tracks,
    packages,
    taskKinds,
    findings: [],
    target: {
      packages: detection.packages,
      entry: detection.entries[detection.primary] ?? '',
      kind: runKind,
    },
    primaryTrack: detection.primary,
  };
  // 9: findings read the finished model.
  model.findings = findIssues(model, ctx);
  model.meta.warnings = buildWarnings([...ctx.warnings, ...dedupeFiles(mapDrafts)]);
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
