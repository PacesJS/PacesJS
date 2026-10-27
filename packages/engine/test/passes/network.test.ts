import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { REQUEST_FLAG, REQUEST_TYPE_NAMES } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { deserializeModel, serializeModel } from '../../src/serialize.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';
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
