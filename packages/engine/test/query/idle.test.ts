import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { browserTimeline } from '../../src/query/browser.js';
import { stretches } from '../../src/query/idle.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import type { BrowserFixtureName } from '../helpers/browser-fixtures.js';

const models = new Map<BrowserFixtureName, ExecutionModel>();
const model = (name: BrowserFixtureName): ExecutionModel => {
  let m = models.get(name);
  if (!m) {
    m = analyze(recordingToCapture(cloneInput(name)));
    models.set(name, m);
  }
  return m;
};

describe('stretches: what the main thread was doing, moment by moment', () => {
  it('covers the whole range without gaps or overlaps', () => {
    const m = model('slow-load');
    const out = stretches(m, 0, m.meta.durationUs);
    expect(out[0]?.start).toBe(0);
    expect(out[out.length - 1]?.end).toBe(m.meta.durationUs);
    for (let i = 1; i < out.length; i++) expect(out[i]?.start).toBe(out[i - 1]?.end);
  });

  it('joins neighbours that have the same cause', () => {
    const out = stretches(model('slow-load'), 0, model('slow-load').meta.durationUs);
    for (let i = 1; i < out.length; i++) expect(out[i]?.cause).not.toBe(out[i - 1]?.cause);
  });

  it('calls a long idle wait on the slow hero image a wait on requests', () => {
    const m = model('slow-load');
    const waits = stretches(m, 0, m.meta.durationUs).filter((s) => s.cause === 'requests');
    expect(Math.max(...waits.map((s) => s.end - s.start))).toBeGreaterThan(1_500_000);
  });
});

describe('browserTimeline: the idle stretches and requests of the lane', () => {
  const timeline = (name: BrowserFixtureName) => browserTimeline(model(name));

  it('names the requests an idle wait was on', () => {
    const wait = timeline('slow-load')?.idle.find(
      (s) => s.cause === 'requests' && s.endUs - s.startUs > 1_500_000,
    );
    expect(wait?.requests.some((u) => u.endsWith('/slow-hero.svg'))).toBe(true);
  });

  it('leaves out stretches that are too short to see', () => {
    const idle = timeline('slow-load')?.idle ?? [];
    expect(idle.every((s) => s.endUs - s.startUs >= 20_000)).toBe(true);
  });

  it('never lists the busy stretches: the lane is about waiting', () => {
    const idle = timeline('slow-load')?.idle ?? [];
    expect(idle.map((s) => s.cause as string)).not.toContain('busy');
  });

  it('puts overlapping requests in different rows', () => {
    const requests = timeline('big-script')?.requests ?? [];
    expect(requests.length).toBeGreaterThan(1);
    for (const a of requests) {
      for (const b of requests) {
        if (a === b || a.row !== b.row) continue;
        expect(a.endUs <= b.startUs || b.endUs <= a.startUs).toBe(true);
      }
    }
  });

  it('keeps each request with its type, address and size', () => {
    const hero = timeline('slow-load')?.requests.find((r) => r.url.endsWith('/slow-hero.svg'));
    expect(hero).toMatchObject({ type: 'Image' });
    expect(hero?.endUs).toBeGreaterThan(hero?.startUs ?? Infinity);
  });
});

describe('stretches: time that was not recorded', () => {
  it('calls the stretch where recording was paused paused, not idle', () => {
    const m = model('paused-resume');
    const gap = m.page?.paused;
    expect(gap?.length).toBe(1);
    const out = stretches(m, 0, m.meta.durationUs).filter((s) => s.cause === 'paused');
    expect(out).toHaveLength(1);
    expect(out[0]?.start).toBe(gap?.start[0]);
    expect(out[0]?.end).toBe(gap?.end[0]);
  });

  it('keeps paused time out of the idle stretches the lane draws', () => {
    const m = model('paused-resume');
    const gap = m.page?.paused;
    const t = browserTimeline(m);
    const from = gap?.start[0] ?? 0;
    const to = gap?.end[0] ?? 0;
    expect((t?.idle ?? []).filter((s) => s.startUs < to && s.endUs > from)).toEqual([]);
  });
});
