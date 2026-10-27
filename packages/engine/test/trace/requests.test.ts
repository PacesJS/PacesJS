import { describe, expect, it } from 'vitest';
import { recordingToCapture } from '../../src/trace/trace-to-capture.js';
import { cloneInput } from '../helpers/browser-fixtures.js';

const requests = () => recordingToCapture(cloneInput('big-script')).browser?.requests ?? [];
const named = (suffix: string) => requests().find((r) => r.url.endsWith(suffix));

describe('recordingToCapture: network requests', () => {
  it('joins the send, the response and the finish of one request', () => {
    const vendor = named('/vendor.js');
    expect(vendor).toMatchObject({
      type: 'Script',
      priority: 'High',
      status: 200,
      protocol: 'http/1.1',
      fromCache: false,
      failed: false,
      renderBlocking: true,
    });
    expect(vendor?.encodedBytes).toBeGreaterThan(170_000);
    expect(vendor?.decodedBytes).toBeGreaterThan(170_000);
  });

  it('puts the send before the response and the response before the finish', () => {
    for (const r of requests()) {
      if (r.responseUs !== undefined) expect(r.responseUs).toBeGreaterThanOrEqual(r.startUs);
      if (r.responseUs !== undefined && r.endUs !== undefined) {
        expect(r.endUs).toBeGreaterThanOrEqual(r.responseUs);
      }
    }
  });

  it('shows a compressed script as a few kilobytes that unpack to many', () => {
    const gz = named('/vendor-gz.js');
    expect(gz?.encodedBytes).toBeLessThan(10_000);
    expect(gz?.decodedBytes).toBeGreaterThan(170_000);
  });

  it('keeps the query-free URL of each request', () => {
    expect(requests().every((r) => !/[?#]/.test(r.url))).toBe(true);
  });

  it('keeps no response header, cookie or other field it was not asked for', () => {
    const text = JSON.stringify(recordingToCapture(cloneInput('big-script')));
    expect(text).not.toContain('cookie-secret');
    expect(text).not.toContain('set-cookie');
    expect(JSON.stringify(requests())).not.toContain('headers');
  });

  it('keeps the function, file and line of the script that made a fetch', () => {
    const late = recordingToCapture(cloneInput('late-hero')).browser?.requests ?? [];
    const hero = late.find((r) => r.url.endsWith('/slow-hero.svg'));
    expect(hero?.type).toBe('Fetch');
    expect(hero?.initiator).toMatchObject({ kind: 'script', fn: 'showHero', line: 10 });
    expect(hero?.initiator?.script?.endsWith('/late-hero.html')).toBe(true);
  });

  it('leaves out a requester when the page did not call anything', () => {
    const late = recordingToCapture(cloneInput('late-hero')).browser?.requests ?? [];
    expect(late[0]?.initiator).toBeUndefined();
  });
});
