// Characterization test for the safe-refactor run: pins the exact output (key order included) of the passes
// and of every query, on every committed fixture. Hashes live in engine-golden.json; regenerate only with
// GOLDEN_WRITE=1 on unchanged code. Never regenerate to make a refactor pass.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAgentSummary } from '../../src/agent-summary.js';
import { diffModels } from '../../src/diff.js';
import type { ExecutionModel } from '../../src/model.js';
import { Origin } from '../../src/model.js';
import { callGraph } from '../../src/query/callgraph.js';
import { flameLayout } from '../../src/query/flame.js';
import { functionRows, sandwich } from '../../src/query/functions.js';
import { callersOf, hotPaths, packageBreakdown } from '../../src/query/paths.js';
import { relatedIds } from '../../src/query/selection.js';
import { functionSource } from '../../src/query/source.js';
import { describeTasks } from '../../src/query/tasks.js';
import { timelineLane } from '../../src/query/timeline.js';
import { callTreeQuery } from '../../src/query/tree.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import type { Transform, TransformedView } from '../../src/query/types.js';
import { applyTransforms } from '../../src/query/view.js';
import {
  trivialTasks,
  waterfallForRange,
  waterfallForRun,
  waterfallForTask,
} from '../../src/query/waterfall.js';
import { serializeModel } from '../../src/serialize.js';
import { FIXTURES } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';

const GOLDEN = new URL('./engine-golden.json', import.meta.url);
const WRITE = process.env['GOLDEN_WRITE'] === '1';
const expected: Record<string, string> = existsSync(GOLDEN)
  ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>)
  : {};
const actual: Record<string, string> = {};

function plain(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return { typed: Array.from(value as unknown as ArrayLike<number>) };
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return { map: [...value.entries()].map(plain) };
  if (value instanceof Set) return { set: [...value].map(plain) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(plain(value)))
    .digest('hex')
    .slice(0, 24);
}

function check(key: string, value: unknown): void {
  const got = digest(value);
  actual[key] = got;
  if (!WRITE) expect(got, key).toBe(expected[key]);
}

function transformSets(model: ExecutionModel, trackIndex: number): Transform[][] {
  const track = model.tracks[trackIndex];
  const top = track ? track.fnIds[Math.min(3, track.fnIds.length - 1)] : undefined;
  const sets: Transform[][] = [[], [...DEFAULT_TRANSFORMS], [{ kind: 'invert' }]];
  if (top !== undefined) {
    sets.push([{ kind: 'focus-function', fn: top }]);
    sets.push([{ kind: 'merge-function', fn: top }]);
  }
  if (track) {
    const span = track.durationUs;
    sets.push([{ kind: 'time-range', start: span * 0.25, end: span * 0.75 }]);
  }
  return sets;
}

function topFunctions(view: TransformedView, n: number): number[] {
  return Array.from(view.tree.fn.slice(0, n));
}

describe('engine golden masters', () => {
  for (const name of FIXTURES) {
    it(`${name}: model, findings, summary`, () => {
      const model = loadModel(name);
      check(`${name}/serialized`, serializeModel(model));
      check(`${name}/findings`, model.findings);
      check(`${name}/meta`, model.meta);
      check(`${name}/summary`, buildAgentSummary(model));
      check(`${name}/diff-self`, diffModels(model, model));
      check(`${name}/target`, [model.target, model.packages, model.taskKinds, model.primaryTrack]);
    });

    it(`${name}: per-track queries`, () => {
      const model = loadModel(name);
      model.tracks.forEach((track, t) => {
        const k = `${name}/t${t}`;
        check(`${k}/tasks`, describeTasks(model, t));
        check(`${k}/timeline`, timelineLane(model, t));
        check(`${k}/timeline-narrow`, timelineLane(model, t, { buckets: 17, longTaskUs: 1000 }));
        check(`${k}/hot`, hotPaths(model, t));
        check(`${k}/hot-user`, hotPaths(model, t, { origin: Origin.User, limit: 20, minShare: 0 }));
        check(`${k}/tree`, callTreeQuery(model, t));
        check(
          `${k}/tree-self`,
          callTreeQuery(model, t, { sort: 'self', depth: 12, minShare: 0, collapseDeps: false }),
        );
        check(`${k}/run-wf`, waterfallForRun(model, t));
        check(`${k}/run-wf-nocollapse`, waterfallForRun(model, t, { collapseTrivialUs: 0 }));
        check(
          `${k}/run-wf-opts`,
          waterfallForRun(model, t, { sort: 'duration', maxDepth: 6, hideOrigins: [Origin.Node] }),
        );
        check(`${k}/trivial`, trivialTasks(model, t));
        const view = applyTransforms(model, t, DEFAULT_TRANSFORMS);
        const tasksN = track.tasks.length;
        const longest = [...Array(tasksN).keys()].sort(
          (a, b) =>
            (track.tasks.end[b] ?? 0) -
            (track.tasks.start[b] ?? 0) -
            ((track.tasks.end[a] ?? 0) - (track.tasks.start[a] ?? 0)),
        );
        for (const task of [0, Math.floor(tasksN / 2), tasksN - 1, ...longest.slice(0, 3)]) {
          if (task < 0 || task >= tasksN) continue;
          check(`${k}/task${task}`, waterfallForTask(model, view, task));
        }
        if (tasksN > 0)
          check(
            `${k}/task-opts`,
            waterfallForTask(model, view, longest[0] ?? 0, { sort: 'share', minDurationUs: 200 }),
          );
        check(
          `${k}/range`,
          waterfallForRange(model, view, track.durationUs * 0.2, track.durationUs * 0.6),
        );
        const sets = transformSets(model, t);
        sets.forEach((stack, i) => {
          const v = applyTransforms(model, t, stack);
          const s = `${k}/v${i}`;
          check(`${s}/view`, {
            totalUs: v.totalUs,
            inverted: v.inverted,
            tree: v.tree,
            samples: v.samples,
            syn: v.syntheticPackages,
          });
          check(`${s}/graph`, callGraph(model, v));
          check(`${s}/graph-plain`, callGraph(model, v, { prioritizeTarget: false, maxNodes: 12 }));
          check(`${s}/flame`, flameLayout(model, v));
          check(
            `${s}/flame-alpha`,
            flameLayout(model, v, {
              sort: 'alphabetical',
              orientation: 'classic',
              colorBy: 'self',
            }),
          );
          check(`${s}/rows`, functionRows(model, v));
          check(
            `${s}/rows-total`,
            functionRows(model, v, { sort: 'total', includeIdle: true, userFirst: false }),
          );
          check(`${s}/rows-name`, functionRows(model, v, { sort: 'name', direction: 'asc' }));
          for (const fn of topFunctions(v, 4)) {
            check(`${s}/fn${fn}/sandwich`, sandwich(model, v, fn));
            check(`${s}/fn${fn}/source`, functionSource(model, v, fn));
            check(`${s}/fn${fn}/related`, relatedIds(model, v, { kind: 'function', fn }));
            check(`${s}/fn${fn}/graph-ego`, callGraph(model, v, { ego: fn }));
          }
          check(
            `${s}/related-node`,
            relatedIds(model, v, { kind: 'node', path: Array.from(v.tree.fn.slice(1, 3)) }),
          );
        });
        const fns = track.fnIds.slice(0, 6);
        for (const fn of fns) check(`${k}/callers${fn}`, callersOf(model, t, fn, 3));
        const pkgs = [
          ...new Set(track.fnIds.map((f) => model.strings[model.functions.pkg[f] ?? 0] ?? '')),
        ].slice(0, 4);
        for (const p of pkgs) check(`${k}/pkg:${p}`, packageBreakdown(model, t, p));
      });
    });
  }

  it('writes or checks the hash file', () => {
    if (WRITE) {
      const sorted = Object.fromEntries(
        Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      writeFileSync(GOLDEN, JSON.stringify(sorted, null, 1) + '\n');
    } else {
      expect(Object.keys(actual).length).toBe(Object.keys(expected).length);
    }
  });
});
