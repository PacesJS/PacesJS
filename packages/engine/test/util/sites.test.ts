import { describe, expect, it } from 'vitest';
import { isPacesInstrumentation } from '../../src/util/paths.js';
import { inferAppSites, isFirstParty, siteOf } from '../../src/util/sites.js';

describe('isPacesInstrumentation', () => {
  it('matches the injected browser script by its source URL', () => {
    expect(isPacesInstrumentation('paces://instrumentation/inject.js')).toBe(true);
  });

  it('still matches the Node preload script', () => {
    expect(isPacesInstrumentation('/x/node_modules/paces/dist/preload.cjs')).toBe(true);
  });

  it('does not match a page script that merely mentions paces', () => {
    expect(isPacesInstrumentation('https://example.com/paces/instrumentation.js')).toBe(false);
  });
});

describe('siteOf', () => {
  it.each([
    ['https://app.example.com/a?x=1', 'example.com'],
    ['http://cdn.example.com:8080/b.js', 'example.com'],
    ['http://localhost:3000/', 'localhost'],
    ['http://127.0.0.1:3000/', '127.0.0.1'],
    ['file:///C:/site/index.html', 'file://'],
    ['app://bundle/main.js', 'app://bundle'],
    ['https://www.bbc.co.uk/news', 'bbc.co.uk'],
    ['https://static.files.bbci.co.uk/a.js', 'bbci.co.uk'],
    ['https://shop.example.com.au/', 'example.com.au'],
    ['https://alice.github.io/app/', 'alice.github.io'],
  ])('reduces %s to %s', (url, site) => {
    expect(siteOf(url)).toBe(site);
  });

  it('returns an empty string for something that is not a URL', () => {
    expect(siteOf('src/App.tsx')).toBe('');
  });
});

describe('isFirstParty', () => {
  const launched = 'http://app.example.com/index.html';

  it('treats the same site, on any subdomain or port, as first-party', () => {
    expect(isFirstParty('https://api.example.com/x.js', launched, [])).toBe(true);
    expect(isFirstParty('http://app.example.com:4000/x.js', launched, [])).toBe(true);
  });

  it('treats another site as third-party', () => {
    expect(isFirstParty('https://cdn.tracker.test/t.js', launched, [])).toBe(false);
  });

  it('keeps localhost and 127.0.0.1 apart, since they are different hosts', () => {
    expect(isFirstParty('http://localhost:2/x.js', 'http://127.0.0.1:1/', [])).toBe(false);
  });

  it('honors an extra first-party glob matched against the script URL', () => {
    expect(
      isFirstParty('https://cdn.tracker.test/t.js', launched, ['https://cdn.tracker.test/**']),
    ).toBe(true);
  });

  it('treats file URLs as first-party when the run started on a file', () => {
    expect(isFirstParty('file:///C:/site/app.js', 'file:///C:/site/index.html', [])).toBe(true);
  });
});

describe('inferAppSites', () => {
  const launched = 'linkedin.com';
  const use = (rows: Record<string, [number, number]>) =>
    new Map(Object.entries(rows).map(([k, [selfUs, functions]]) => [k, { selfUs, functions }]));

  it('names the CDN that serves the page its code, when the page itself serves little', () => {
    const usage = use({
      'linkedin.com': [100, 40],
      'licdn.com': [1500, 2000],
      'gstatic.com': [200, 80],
    });
    expect(inferAppSites(usage, launched)).toEqual(['licdn.com']);
  });

  it('leaves a third party alone when it only has a few functions, however busy', () => {
    const usage = use({ 'example.com': [100, 40], 'tracker.test': [900, 6] });
    expect(inferAppSites(usage, 'example.com')).toEqual([]);
  });

  it('leaves a third party alone when the page itself does most of the work', () => {
    const usage = use({ 'example.com': [900, 40], 'cdn.test': [100, 500] });
    expect(inferAppSites(usage, 'example.com')).toEqual([]);
  });

  it('infers nothing for a run with no script time', () => {
    expect(inferAppSites(use({}), launched)).toEqual([]);
  });
});
