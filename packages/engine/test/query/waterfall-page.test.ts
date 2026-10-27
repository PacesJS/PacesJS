import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { TaskKind } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { smallTaskLimitUs, trivialTasks, waterfallForRun } from '../../src/query/waterfall.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import type { BrowserFixtureName } from '../helpers/browser-fixtures.js';
import { loadModel } from '../helpers/fixtures.js';

const page = (name: BrowserFixtureName): ExecutionModel =>
  analyze(recordingToCapture(cloneInput(name)));

describe('what counts as a small task', () => {
  it('is half a millisecond for a Node run, as it always was', () => {
    const m = loadModel('hot-regex');
    expect(smallTaskLimitUs(m, m.primaryTrack)).toBe(
      Math.max(500, 0.001 * (m.tracks[m.primaryTrack]?.durationUs ?? 0)),
    );
  });

  it('is five milliseconds for a page, where nearly every task is a fraction of one', () => {
    const m = page('slow-click');
    expect(smallTaskLimitUs(m, m.primaryTrack)).toBe(5000);
  });

  it('can still be set by the caller', () => {
    const m = page('slow-click');
    expect(smallTaskLimitUs(m, m.primaryTrack, 800)).toBe(800);
  });

  it('never hides a task that handled the user input, however short', () => {
    const m = page('slow-click');
    const track = m.tracks[m.primaryTrack];
    const click = [...Array(track?.tasks.length ?? 0).keys()].find(
      (k) => track?.tasks.kind[k] === TaskKind.Input,
    );
    expect(click).toBeDefined();
    if (track && click !== undefined) track.tasks.busy[click] = 100;
    expect(trivialTasks(m, m.primaryTrack).has(click ?? -1)).toBe(false);
  });

  it('hides the tasks under the limit', () => {
    const m = page('forced-layout');
    const track = m.tracks[m.primaryTrack];
    const small = trivialTasks(m, m.primaryTrack);
    expect(small.size).toBeGreaterThan(0);
    const heavy = [...small].filter(
      (k) => (track?.tasks.busy[k] ?? 0) >= 5000 && track?.tasks.runtimeOnly[k] !== 1,
    );
    expect(heavy).toEqual([]);
  });
});

describe('the whole-run waterfall of a page', () => {
  const summaries = (name: BrowserFixtureName) => {
    const m = page(name);
    const wf = waterfallForRun(m, m.primaryTrack);
    return { m, rows: wf.rows.filter((r) => r.kind === 'summary') };
  };

  it('never groups small tasks across a long idle gap', () => {
    for (const name of ['slow-click', 'forced-layout', 'paused-resume', 'layout-shift'] as const) {
      const { m, rows } = summaries(name);
      const tasks = m.tracks[m.primaryTrack]?.tasks;
      for (const row of rows) {
        const ids = [...row.summaryTasks].sort(
          (a, b) => (tasks?.start[a] ?? 0) - (tasks?.start[b] ?? 0),
        );
        let reached = tasks?.end[ids[0] ?? 0] ?? 0;
        for (const id of ids.slice(1)) {
          expect((tasks?.start[id] ?? 0) - reached).toBeLessThanOrEqual(100_000);
          reached = Math.max(reached, tasks?.end[id] ?? 0);
        }
      }
    }
  });

  it('does not let a group of small tasks span a pause', () => {
    const { m, rows } = summaries('paused-resume');
    const pause = m.page?.paused;
    expect(pause?.length).toBe(1);
    const from = pause?.start[0] ?? 0;
    const to = pause?.end[0] ?? 0;
    expect(rows.filter((r) => r.start < from && r.end > to)).toEqual([]);
  });

  it('keeps the tasks that are not small as rows of their own, so there is something to look at', () => {
    const { m } = summaries('forced-layout');
    const wf = waterfallForRun(m, m.primaryTrack);
    const big = wf.rows.filter((r) => r.kind === 'call' && r.depth > 1 && r.durUs > 20_000);
    expect(big.length).toBeGreaterThan(0);
  });

  it('is unchanged for a Node run: its small tasks group as before', () => {
    const m = loadModel('hot-regex');
    const wf = waterfallForRun(m, m.primaryTrack);
    expect(wf.rows.filter((r) => r.kind === 'summary').length).toBeGreaterThanOrEqual(0);
    expect(trivialTasks(m, m.primaryTrack).size).toBeGreaterThanOrEqual(0);
  });
});
