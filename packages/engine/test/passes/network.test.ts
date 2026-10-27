import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { REQUEST_FLAG, REQUEST_TYPE_NAMES } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { deserializeModel, serializeModel } from '../../src/serialize.js';
import { requestInitiator } from '../../src/query/network.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
import { BROWSER_FIXTURES } from '../helpers/browser-fixtures.js';
import type { BrowserFixtureName } from '../helpers/browser-fixtures.js';

const models = new Map<BrowserFixtureName, ExecutionModel>();
function model(name: BrowserFixtureName): ExecutionModel {
  let m = models.get(name);
  if (!m) {
    m = analyze(recordingToCapture(cloneInput(name)));
    models.set(name, m);
  }
  return m;
}

function request(m: ExecutionModel, suffix: string) {
  const t = m.page?.requests;
  for (let i = 0; t && i < t.length; i++) {
    const url = m.strings[t.url[i] ?? 0] ?? '';
    if (!url.endsWith(suffix)) continue;
    return {
      type: REQUEST_TYPE_NAMES[t.type[i] ?? 0],
      start: t.start[i] ?? 0,
      response: t.response[i] ?? -1,
      end: t.end[i] ?? -1,
      encoded: t.encoded[i] ?? -1,
      decoded: t.decoded[i] ?? -1,
      status: t.status[i] ?? 0,
      blocking: ((t.flags[i] ?? 0) & REQUEST_FLAG.renderBlocking) !== 0,
      cached: ((t.flags[i] ?? 0) & REQUEST_FLAG.cached) !== 0,
    };
  }
  return undefined;
}

describe('browser model: requests', () => {
  it('lists the page requests with their type, size and status', () => {
    const r = request(model('big-script'), '/vendor.js');
    expect(r).toMatchObject({ type: 'Script', status: 200, blocking: true, cached: false });
    expect(r?.encoded).toBeGreaterThan(170_000);
  });

  it('times a request from the model clock: sent, answered, finished', () => {
    const r = request(model('big-script'), '/vendor.js');
    expect(r?.start).toBeGreaterThanOrEqual(0);
    expect(r?.response).toBeGreaterThanOrEqual(r?.start ?? 0);
    expect(r?.end).toBeGreaterThanOrEqual(r?.response ?? 0);
  });

  it('lists requests for every page run', () => {
    expect(model('slow-click').page?.requests.length).toBeGreaterThan(0);
  });

  it('survives a round trip through the cached form', () => {
    const back = deserializeModel(serializeModel(model('big-script')));
    expect(request(back, '/vendor-gz.js')).toEqual(request(model('big-script'), '/vendor-gz.js'));
  });

  it('keeps, for every function, the script it was parsed from', () => {
    const m = model('big-script');
    const scripts = new Set<string>();
    for (let f = 0; f < m.functions.length; f++) {
      scripts.add(m.strings[m.functions.script[f] ?? 0] ?? '');
    }
    expect([...scripts].some((s) => s.endsWith('/vendor.js'))).toBe(true);
    expect([...scripts].some((s) => s.endsWith('/vendor-gz.js'))).toBe(true);
  });
});

describe('browser model: the uncompressed-text finding', () => {
  const found = (name: BrowserFixtureName) =>
    model(name).findings.filter((f) => f.kind === 'uncompressed-text');

  it('names the large script sent as plain text, and not the one that was compressed', () => {
    const f = found('big-script');
    expect(f).toHaveLength(1);
    expect(f[0]?.summary).toContain('vendor.js');
    expect(f[0]?.summary).not.toContain('vendor-gz.js');
  });

  it('says how large the file is, and how to get it compressed', () => {
    const f = found('big-script')[0];
    expect(f?.summary).toMatch(/\d+ KB/);
    expect(f?.hint).toMatch(/gzip|brotli/i);
  });

  it.each(['slow-click', 'forced-layout', 'third-party', 'layout-shift'] as const)(
    'stays silent on %s, whose files are small',
    (name) => {
      expect(found(name)).toEqual([]);
    },
  );
});

describe('browser model: the slow-load finding', () => {
  const found = (name: BrowserFixtureName) =>
    model(name).findings.filter((f) => f.kind === 'slow-load');

  it('says where the time to the largest content went: busy, waiting on requests, or nothing', () => {
    const f = found('slow-load');
    expect(f).toHaveLength(1);
    expect(f[0]?.summary).toMatch(/Largest content appeared at 2\.\d s/);
    expect(f[0]?.summary).toMatch(/idle with requests in flight 2\.\d s/);
  });

  it('names the slowest request that finished before the content appeared', () => {
    expect(found('slow-load')[0]?.summary).toContain('slow-hero.svg');
  });

  it('points at the network when that is where the wait was', () => {
    expect(found('slow-load')[0]?.hint).toMatch(/network|request/i);
  });

  it('says which function asked for the slowest request when a script did', () => {
    const f = found('late-hero');
    expect(f).toHaveLength(1);
    expect(f[0]?.summary).toContain('slow-hero.svg');
    expect(f[0]?.summary).toMatch(/requested by showHero \(\S*late-hero\.html:\d+\)/);
  });

  it('does not name a requester for a request the parser made', () => {
    expect(found('slow-load')[0]?.summary).not.toContain('requested by');
  });

  it.each(BROWSER_FIXTURES.filter((n) => n !== 'slow-load' && n !== 'late-hero'))(
    'stays silent on %s',
    (name) => {
      expect(found(name)).toEqual([]);
    },
  );
});

describe('browser model: the slow-document finding', () => {
  const found = (name: BrowserFixtureName) =>
    model(name).findings.filter((f) => f.kind === 'slow-document');

  it('reports a page whose HTML took over a second to start arriving', () => {
    const f = found('slow-doc');
    expect(f).toHaveLength(1);
    expect(f[0]?.summary).toMatch(/1\.\d s/);
    expect(f[0]?.summary).toContain('slow-doc.html');
  });

  it.each(BROWSER_FIXTURES.filter((n) => n !== 'slow-doc'))('stays silent on %s', (name) => {
    expect(found(name)).toEqual([]);
  });
});

describe('browser model: network findings only count real network requests', () => {
  it('ignores the browser own error page, which is not a file anyone served', () => {
    const input = cloneInput('big-script');
    for (const e of input.events) {
      const data = (e.args as { data?: { url?: string } } | undefined)?.data;
      if (data?.url?.endsWith('/vendor.js')) data.url = 'chrome-error://chromewebdata/';
    }
    const m = analyze(recordingToCapture(input));
    expect(m.findings.filter((f) => f.kind === 'uncompressed-text')).toEqual([]);
  });
});

describe('browser model: who asked for a request', () => {
  it('records the function, file and line of the script that called fetch', () => {
    const m = model('late-hero');
    const t = m.page?.requests;
    const i = Array.from({ length: t?.length ?? 0 }, (_, k) => k).find((k) =>
      (m.strings[t?.url[k] ?? 0] ?? '').endsWith('/slow-hero.svg'),
    );
    expect(i).toBeDefined();
    expect(requestInitiator(m, i ?? -1)).toMatchObject({ fn: 'showHero', line: 10 });
    expect(requestInitiator(m, i ?? -1)?.script.endsWith('/late-hero.html')).toBe(true);
  });

  it('types a fetch call as Fetch, not Other', () => {
    expect(request(model('late-hero'), '/slow-hero.svg')?.type).toBe('Fetch');
  });

  it('has no requester for the document, which nothing in the page asked for', () => {
    const m = model('late-hero');
    expect(requestInitiator(m, 0)).toBeNull();
  });

  it('survives a trip through the cached model', () => {
    const back = deserializeModel(serializeModel(model('late-hero')));
    const t = back.page?.requests;
    const i = Array.from({ length: t?.length ?? 0 }, (_, k) => k).find((k) =>
      (back.strings[t?.url[k] ?? 0] ?? '').endsWith('/slow-hero.svg'),
    );
    expect(requestInitiator(back, i ?? -1)?.fn).toBe('showHero');
  });
});

describe('browser model: the slow-load finding when the wait was not on the network', () => {
  it('does not blame a request when most of the time was idle with nothing in flight', () => {
    const m = analyze(recordingToCapture(cloneInput('slow-doc')), {
      thresholds: { slowLoadMs: 1000 },
    });
    const f = m.findings.find((x) => x.kind === 'slow-load');
    expect(f).toBeDefined();
    expect(f?.summary).not.toContain('slowest request');
  });
});
