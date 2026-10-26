import { describe, expect, it } from 'vitest';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';

const isSync = (e: { name: string; args?: Record<string, unknown> }): boolean =>
  e.name === 'TimeStamp' && JSON.stringify(e.args).includes('paces:sync');

describe('clock anchor', () => {
  it('takes the offset from the sync stamp the page reported', () => {
    const input = cloneInput('slow-click');
    const sync = input.events.find(isSync);
    const epochMs = input.segments?.[0]?.syncs[0]?.epochMs ?? 0;
    const capture = recordingToCapture(input);
    expect(capture.browser?.clock.anchored).toBe(true);
    expect(capture.browser?.clock.offsetUs).toBeCloseTo(epochMs * 1000 - (sync?.ts ?? 0), 0);
  });

  it('puts the first event of the run close to the wall clock time the run started', () => {
    const input = cloneInput('slow-click');
    const capture = recordingToCapture(input);
    const first = capture.browser?.segments[0]?.startUs ?? 0;
    const epochMs = (first + (capture.browser?.clock.offsetUs ?? 0)) / 1000;
    expect(Math.abs(epochMs - input.startedAt)).toBeLessThan(2000);
  });

  it('is accurate to well under a millisecond when the page answered', () => {
    const capture = recordingToCapture(cloneInput('slow-click'));
    expect(capture.browser?.clock.errorUs).toBeLessThan(1000);
  });

  it('falls back to the host clock, and says the error is large, without a sync stamp', () => {
    const input = cloneInput('slow-click');
    input.events = input.events.filter((e) => !isSync(e));
    const capture = recordingToCapture(input);
    expect(capture.browser?.clock.anchored).toBe(true);
    expect(capture.browser?.clock.errorUs).toBeGreaterThan(1000);
  });

  it('uses the sync of every segment, so a pause does not skew later events', () => {
    const capture = recordingToCapture(cloneInput('paused-resume'));
    expect(capture.browser?.clock.errorUs).toBeLessThan(5000);
  });
});
