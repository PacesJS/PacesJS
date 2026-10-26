import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { browserTimeline } from '../../src/query/browser.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { loadModel } from '../helpers/fixtures.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import type { BrowserFixtureName } from '../helpers/browser-fixtures.js';

const model = (name: BrowserFixtureName): ExecutionModel =>
  analyze(recordingToCapture(cloneInput(name)));

describe('browserTimeline', () => {
  it('is null for a Node run, which has no page', () => {
    expect(browserTimeline(loadModel('hot-regex'))).toBeNull();
  });

  it('describes the run: duration, browser, and what was recorded', () => {
    const t = browserTimeline(model('slow-click'));
    expect(t?.durationUs).toBeGreaterThan(2_000_000);
    expect(t?.product).toMatch(/^Edg\/|^Chrome\//);
    expect(t?.url).toMatch(/slow-click\.html$/);
    expect(t?.anchored).toBe(true);
  });

  it('puts the filmstrip frames in time order with their ids', () => {
    const t = browserTimeline(model('layout-shift'));
    const times = [...(t?.screenshots.time ?? [])];
    expect(times.length).toBeGreaterThan(1);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(t?.screenshots.id.length).toBe(times.length);
  });

  it('names the loading milestones and the layout shift', () => {
    const t = browserTimeline(model('layout-shift'));
    const names = t?.vitals.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['FCP', 'LCP', 'shift']));
    const shift = t?.vitals.find((v) => v.name === 'shift');
    expect(shift?.value).toBeGreaterThan(0.1);
  });

  it('gives each input its label, kind and the delay before the next paint', () => {
    const t = browserTimeline(model('slow-click'));
    const click = t?.inputs.find((i) => i.kind === 'click');
    expect(click?.label).toBe('button#save "Save"');
    expect(click?.latencyUs).toBeGreaterThan(200_000);
    expect(click?.endUs).toBeGreaterThan(click?.startUs ?? Infinity);
  });

  it('names the rendering phases and marks forced layout', () => {
    const t = browserTimeline(model('forced-layout'));
    expect(new Set(t?.render.map((r) => r.phase))).toEqual(
      expect.objectContaining(new Set(['style', 'layout'])),
    );
    expect(t?.render.filter((r) => r.forced).length).toBeGreaterThan(100);
  });

  it('holds the paused stretches', () => {
    const t = browserTimeline(model('paused-resume'));
    expect(t?.paused).toHaveLength(1);
    expect((t?.paused[0]?.endUs ?? 0) - (t?.paused[0]?.startUs ?? 0)).toBeGreaterThan(500_000);
  });

  it('counts the long main-thread tasks as ticks on the page lane', () => {
    const t = browserTimeline(model('slow-click'));
    expect(t?.longTasks.length).toBeGreaterThan(0);
    expect(t?.longTasks[0]?.durationUs).toBeGreaterThan(50_000);
  });

  it('lists what the header shows as chips', () => {
    const f = cloneInput('slow-click');
    const m = analyze(recordingToCapture({ ...f, throttle: 4, cacheCold: true }));
    const t = browserTimeline(m);
    expect(t?.throttle).toBe(4);
    expect(t?.cacheCold).toBe(true);
    expect(t?.screenshotCount).toBe(m.page?.screenshots.length);
  });
});
