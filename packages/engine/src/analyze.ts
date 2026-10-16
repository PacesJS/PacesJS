// Runs the passes in their fixed order and assembles the execution model.

import { DEFAULT_THRESHOLDS, ENGINE_VERSION } from './config.js';
import type { AnalyzeOptions } from './config.js';
import type { ExecutionModel, FunctionTable, Track } from './model.js';
import { aggregateTrack, mergePackages } from './passes/aggregate.js';
import type { TrackAggregateResult } from './passes/aggregate.js';
import { stitchAsync } from './passes/async.js';
import { toCallTree } from './passes/call-tree.js';
import { classify } from './passes/classification.js';
import { findIssues } from './passes/findings.js';
import { ingest } from './passes/ingest.js';
import { detectPlumbing } from './passes/plumbing.js';
import { resolveSourceMaps } from './passes/source-maps.js';
import { reconstructSpans } from './passes/spans.js';
import { segmentTasks } from './passes/tasks.js';
import type { PassContext } from './passes/types.js';
import type { RawCapture } from './raw.js';
import { createStringTable } from './util/strings.js';

export function analyze(capture: RawCapture, options: AnalyzeOptions = {}): ExecutionModel {
  const ctx: PassContext = {
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
    options,
    strings: createStringTable(),
    warnings: [],
  };

  // 1-4: per-function passes.
  const ing = ingest(capture, ctx);
  const sm = resolveSourceMaps({ capture, ingest: ing }, ctx);
  const classification = classify(sm.functions, ctx);
  const plumbing = detectPlumbing({ functions: sm.functions, classification }, ctx);
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
      label: raw.info.label,
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
  const model: ExecutionModel = {
    meta: {
      ...capture.meta,
      precisionUs: ing.precisionUs,
      durationUs: ing.durationUs,
      engineVersion: ENGINE_VERSION,
      warnings: [],
    },
    strings: ctx.strings.strings,
    functions,
    tracks,
    packages,
    taskKinds,
    findings: [],
  };
  // 9: findings read the finished model.
  model.findings = findIssues(model, ctx);
  model.meta.warnings = [...new Set(ctx.warnings)];
  return model;
}
