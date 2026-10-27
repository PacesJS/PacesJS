import { describe, expect, it } from 'vitest';
import { Origin } from '../../src/model.js';
import { BROWSER_RUN, NODE_RUN, adapterFor } from '../../src/run/index.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import { loadCapture } from '../helpers/capture.js';

const site = {
  launchedUrl: 'https://www.example.com/',
  firstParty: [],
  appSites: ['cdnexample.com'],
};
const target = { packages: new Set<string>(), globs: [], browser: site };

describe('which adapter a capture gets', () => {
  it('is the browser one for a page', () => {
    expect(adapterFor(recordingToCapture(cloneInput('slow-click')))).toBe(BROWSER_RUN);
  });

  it('is the Node one for a command', () => {
    expect(adapterFor(loadCapture('hot-regex'))).toBe(NODE_RUN);
  });

  it('says a page is a page without being told, and leaves a command to be worked out', () => {
    expect(BROWSER_RUN.fixedRunKind).toBe('page');
    expect(NODE_RUN.fixedRunKind).toBeUndefined();
  });
});

describe('what each adapter calls a function', () => {
  const at = (file: string, name = 'f') => ({ name, file, line: 1 });

  it('counts the launched site and the site serving its app as the page', () => {
    const own = BROWSER_RUN.classifyFunction(at('https://www.example.com/a.js'), target, undefined);
    const app = BROWSER_RUN.classifyFunction(at('https://cdnexample.com/b.js'), target, undefined);
    expect([own.origin, app.origin]).toEqual([Origin.User, Origin.User]);
  });

  it('names another site as a dependency by its host', () => {
    const other = BROWSER_RUN.classifyFunction(at('https://ads.test/c.js'), target, undefined);
    expect(other).toEqual({ origin: Origin.Dependency, pkg: 'ads.test' });
  });

  it('lets a caller override win in both', () => {
    const file = at('https://ads.test/c.js');
    expect(BROWSER_RUN.classifyFunction(file, target, Origin.User).origin).toBe(Origin.User);
    expect(
      NODE_RUN.classifyFunction(at('/p/node_modules/x/i.js'), undefined, Origin.User).origin,
    ).toBe(Origin.User);
  });

  it('names a package in node_modules a dependency in a Node run', () => {
    const verdict = NODE_RUN.classifyFunction(
      at('/p/node_modules/lodash/i.js'),
      undefined,
      undefined,
    );
    expect(verdict).toEqual({ origin: Origin.Dependency, pkg: 'lodash' });
  });
});

describe('the rules of each adapter', () => {
  it('give a page its own rules and no event-loop ones', () => {
    expect(BROWSER_RUN.rules.length).toBeGreaterThan(0);
    expect(BROWSER_RUN.rules).not.toEqual(NODE_RUN.rules);
  });
});
