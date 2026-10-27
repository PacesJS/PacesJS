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

  it('keeps only the final largest contentful paint of a navigation', () => {
    expect(count(names('slow-click'), 'LCP')).toBe(1);
    expect(count(names('paused-resume'), 'LCP')).toBe(1);
  });

  it('keeps the layout shifts of the page', () => {
    expect(count(names('layout-shift'), 'shift')).toBe(1);
  });
});
