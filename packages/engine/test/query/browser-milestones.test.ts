import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { browserTimeline } from '../../src/query/browser.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import type { BrowserFixtureName } from '../helpers/browser-fixtures.js';

const names = (name: BrowserFixtureName) => {
  const t = browserTimeline(analyze(recordingToCapture(cloneInput(name))));
  return (t?.vitals ?? []).map((v) => v.name);
};
const count = (list: string[], what: string): number => list.filter((n) => n === what).length;

describe('the page milestones', () => {
  it('has one navigation and one DOMContentLoaded for a page that loaded once', () => {
    const list = names('slow-click');
    expect(count(list, 'navigation')).toBe(1);
    expect(count(list, 'DOMContentLoaded')).toBe(1);
  });

  it('leaves out the milestones of an iframe in the page', () => {
    const list = names('worker-and-iframe');
    expect(count(list, 'navigation')).toBe(1);
    expect(count(list, 'DOMContentLoaded')).toBe(1);
    expect(count(list, 'load')).toBe(1);
  });

  it('leaves out load events that carry no frame, such as those of frames a script created', () => {
    const input = cloneInput('slow-click');
    for (const name of ['domContentLoadedEventEnd', 'loadEventEnd']) {
      const real = input.events.find((e) => e.name === name);
      if (!real) throw new Error(`the fixture has no ${name}`);
      const frameless = structuredClone(real);
      frameless.ts += 2_000_000;
      delete (frameless.args as { frame?: string }).frame;
      input.events.push(frameless);
    }
    const list = (browserTimeline(analyze(recordingToCapture(input)))?.vitals ?? []).map(
      (v) => v.name,
    );
    expect(count(list, 'DOMContentLoaded')).toBe(1);
    expect(count(list, 'load')).toBe(1);
  });

  it('counts the page, not its initial blank document, as the one that became ready', () => {
    const input = cloneInput('slow-click');
    const navigation = input.events.find((e) => e.name === 'navigationStart');
    const ready = input.events.find((e) => e.name === 'domContentLoadedEventEnd');
    if (!navigation || !ready)
      throw new Error('the fixture lacks a navigation or a DOMContentLoaded');
    const blank = structuredClone(ready);
    blank.ts = navigation.ts + 1;
    ready.ts += 300_000;
    input.events.push(blank);
    const vitals = browserTimeline(analyze(recordingToCapture(input)))?.vitals ?? [];
    const dcl = vitals.filter((v) => v.name === 'DOMContentLoaded');
    expect(dcl).toHaveLength(1);
    expect(dcl[0]?.timeUs).toBeGreaterThan(250_000);
  });

  it('keeps only the final largest contentful paint of a navigation', () => {
    expect(count(names('slow-click'), 'LCP')).toBe(1);
    expect(count(names('paused-resume'), 'LCP')).toBe(1);
  });

  it('keeps the layout shifts of the page', () => {
    expect(count(names('layout-shift'), 'shift')).toBe(1);
  });
});
