import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { networkOverview, scriptCostFor, scriptCosts } from '../../src/query/network.js';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';

let cached: ExecutionModel | undefined;
const model = (): ExecutionModel =>
  (cached ??= analyze(recordingToCapture(cloneInput('big-script'))));
const row = (suffix: string) => scriptCosts(model()).find((r) => r.url.endsWith(suffix));

describe('scriptCosts', () => {
  it('puts what a script cost to fetch next to what it cost to run', () => {
    const vendor = row('/vendor.js');
    expect(vendor?.wireBytes).toBeGreaterThan(170_000);
    expect(vendor?.decodedBytes).toBeGreaterThan(170_000);
    expect(vendor?.downloadUs).toBeGreaterThanOrEqual(0);
    expect(vendor?.selfUs).toBeGreaterThan(0);
    expect(vendor?.functions).toBeGreaterThan(0);
    expect(vendor?.renderBlocking).toBe(true);
  });

  it('shows a compressed script as small on the wire and large once unpacked', () => {
    const gz = row('/vendor-gz.js');
    expect(gz?.wireBytes).toBeLessThan(10_000);
    expect(gz?.decodedBytes).toBeGreaterThan(170_000);
  });

  it('lists the scripts that ran the most first', () => {
    const rows = scriptCosts(model());
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]?.selfUs).toBeGreaterThanOrEqual(rows[i]?.selfUs ?? 0);
    }
  });

  it('lists only scripts: no document, icon or image', () => {
    expect(scriptCosts(model()).every((r) => /\.js$/.test(r.url))).toBe(true);
  });
});

describe('networkOverview', () => {
  it('counts requests and bytes by type', () => {
    const o = networkOverview(model());
    const scripts = o.byType.find((t) => t.type === 'Script');
    expect(scripts?.count).toBe(2);
    expect(o.requests).toBeGreaterThanOrEqual(3);
    expect(o.wireBytes).toBeGreaterThan(170_000);
    expect(o.decodedBytes).toBeGreaterThan(o.wireBytes);
  });

  it('is empty for a model with no page', () => {
    const empty = { ...model(), page: undefined } as ExecutionModel;
    expect(networkOverview(empty).requests).toBe(0);
  });
});

describe('scriptCostFor', () => {
  const plainVendorFn = (): number => {
    const m = model();
    for (let f = 0; f < m.functions.length; f++) {
      if (/^vendorStep\d+$/.test(m.strings[m.functions.name[f] ?? 0] ?? '')) return f;
    }
    return -1;
  };

  it('gives the cost of the file a function was parsed from', () => {
    const cost = scriptCostFor(model(), plainVendorFn());
    expect(cost?.url.endsWith('/vendor.js')).toBe(true);
    expect(cost?.wireBytes).toBeGreaterThan(170_000);
  });

  it('gives nothing for a function of the page itself or a native one', () => {
    expect(scriptCostFor(model(), 0)).toBeNull();
    expect(scriptCostFor(model(), 1e9)).toBeNull();
  });
});
