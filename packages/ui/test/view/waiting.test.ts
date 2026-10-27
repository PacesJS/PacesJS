import { describe, expect, it } from 'vitest';
import type { BrowserIdle } from '@pacesjs/engine';
import { idleLabel, requestName } from '../../src/view/waiting';

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
