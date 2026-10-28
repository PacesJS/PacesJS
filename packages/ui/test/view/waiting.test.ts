import { describe, expect, it } from 'vitest';
import type { BrowserIdle, BrowserRequest } from '@pacesjs/engine';
import { idleLabel, inFlightAt, idleShares, requestName, waitingTip } from '../../src/view/waiting';

const idle = (over: Partial<BrowserIdle>): BrowserIdle => ({
  startUs: 1_000_000,
  endUs: 2_800_000,
  cause: 'requests',
  requests: [],
  ...over,
});

describe('requestName', () => {
  it('is the file a request asked for, not the whole address', () => {
    expect(requestName('https://static.licdn.com/aero-v1/sc/h/e3e60132.js')).toBe('e3e60132.js');
  });

  it('falls back to the host for an address that ends in a slash', () => {
    expect(requestName('https://www.example.com/')).toBe('www.example.com');
  });

  it('says what kind of address a blob or data one is', () => {
    expect(requestName('blob:http://127.0.0.1:5000/9f1c')).toBe('blob');
    expect(requestName('data:image/png;base64,AAAA')).toBe('data');
  });
});

describe('idleLabel', () => {
  it('names what a wait was on, and how long it lasted', () => {
    const label = idleLabel(idle({ requests: ['http://x.test/slow-hero.svg'] }));
    expect(label).toBe('Idle 1.8 s, waiting on slow-hero.svg');
  });

  it('says how many more were in flight beyond the ones it names', () => {
    const label = idleLabel(idle({ requests: ['http://x.test/a.js', 'http://x.test/b.js'] }));
    expect(label).toBe('Idle 1.8 s, waiting on a.js and b.js');
  });

  it('says nothing was in flight when that is so', () => {
    expect(idleLabel(idle({ cause: 'nothing' }))).toBe('Idle 1.8 s, nothing in flight');
  });

  it('does not pretend to know which request when only quiet ones were open', () => {
    expect(idleLabel(idle({ requests: [] }))).toBe('Idle 1.8 s, waiting on requests');
  });
});

const req = (startUs: number, endUs: number, url = 'http://x.test/a.js'): BrowserRequest => ({
  startUs,
  endUs,
  type: 'Script',
  url,
  wireBytes: 100,
  row: 0,
});

describe('inFlightAt', () => {
  it('lists the requests under way at a moment, the longest-running first', () => {
    const list = inFlightAt([req(0, 100, 'a'), req(50, 200, 'b'), req(300, 400, 'c')], 75);
    expect(list.map((r) => r.url)).toEqual(['b', 'a']);
  });

  it('lists nothing between requests', () => {
    expect(inFlightAt([req(0, 100)], 150)).toEqual([]);
  });
});

describe('idleShares', () => {
  it('says what share of each slice the main thread was idle, by cause', () => {
    const { waiting, nothing } = idleShares(
      [
        idle({ startUs: 0, endUs: 250, cause: 'requests' }),
        idle({ startUs: 250, endUs: 400, cause: 'nothing', requests: [] }),
      ],
      1000,
      10,
    );
    expect(waiting.slice(0, 4)).toEqual([1, 1, 0.5, 0]);
    expect(nothing.slice(0, 5)).toEqual([0, 0, 0.5, 1, 0]);
  });

  it('counts a stretch shorter than a slice as part of it', () => {
    const { waiting } = idleShares([idle({ startUs: 0, endUs: 50, cause: 'requests' })], 1000, 10);
    expect(waiting[0]).toBe(0.5);
  });

  it('has no slices for a run with no length', () => {
    expect(idleShares([idle({})], 0, 10)).toEqual({
      waiting: new Array(10).fill(0),
      nothing: new Array(10).fill(0),
    });
  });
});

describe('waitingTip', () => {
  const data = {
    idle: [idle({ startUs: 1_000_000, endUs: 2_000_000, requests: ['http://x.test/hero.svg'] })],
    requests: [req(900_000, 2_500_000, 'http://x.test/hero.svg'), req(1_200_000, 1_300_000, 'b')],
  };

  it('says what the main thread was idle for and which requests were in flight', () => {
    const tip = waitingTip(data, 1_250_000);
    expect(tip.title).toBe('1.25 s');
    expect(tip.lines[0]).toMatch(/Idle 1\.0 s, waiting on hero\.svg/);
    expect(tip.lines[1]).toBe('2 requests in flight: hero.svg and b');
  });

  it('says recording was paused inside a pause, whatever was in flight', () => {
    const paused = [{ startUs: 1_100_000, endUs: 1_400_000 }];
    expect(waitingTip({ ...data, paused }, 1_250_000).lines).toEqual(['Recording was paused']);
  });

  it('says so when nothing was in flight', () => {
    expect(waitingTip({ idle: [], requests: [] }, 500).lines).toEqual(['No requests in flight']);
  });

  it('shortens a long list of requests', () => {
    const many = Array.from({ length: 9 }, (_, i) => req(0, 1000 + i, `r${i}`));
    expect(waitingTip({ idle: [], requests: many }, 500).lines[0]).toBe(
      '9 requests in flight: r8, r7, r6 and 6 more',
    );
  });
});
