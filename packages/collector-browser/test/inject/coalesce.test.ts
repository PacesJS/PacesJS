import { describe, expect, it } from 'vitest';
import { createCoalescer } from '../../src/inject/coalesce.js';

interface Emitted {
  kind: string;
  label: string;
}

function setup(limits: { maxPerSecond?: number; maxTotal?: number } = {}) {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const out: Emitted[] = [];
  const c = createCoalescer({
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
    emit: (kind, label) => out.push({ kind, label }),
    ...limits,
  });
  const advance = (ms: number): void => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      due.live = false;
      due.fn();
    }
    clock = target;
  };
  return { c, out, advance };
}

describe('createCoalescer', () => {
  it('turns a burst of typing into one event with the keystroke count and no text', () => {
    const { c, out, advance } = setup();
    for (let i = 0; i < 5; i++) {
      c.typing('input[type=email]');
      advance(100);
    }
    expect(out).toEqual([]);
    advance(500);
    expect(out).toEqual([{ kind: 'typing', label: 'input[type=email] (5 keys, 0.4 s)' }]);
  });

  it('starts a new burst after a pause of more than 500 ms', () => {
    const { c, out, advance } = setup();
    c.typing('input');
    advance(600);
    c.typing('input');
    advance(600);
    expect(out.map((e) => e.kind)).toEqual(['typing', 'typing']);
  });

  it('splits a burst when the field changes', () => {
    const { c, out, advance } = setup();
    c.typing('input#a');
    c.typing('input#b');
    advance(600);
    expect(out.map((e) => e.label)).toEqual(['input#a (1 key, 0 s)', 'input#b (1 key, 0 s)']);
  });

  it('reports a scroll once, then again only after a second of quiet', () => {
    const { c, out, advance } = setup();
    c.scroll();
    advance(200);
    c.scroll();
    advance(200);
    c.scroll();
    expect(out).toEqual([{ kind: 'scroll', label: 'scroll' }]);
    advance(1500);
    c.scroll();
    expect(out.map((e) => e.kind)).toEqual(['scroll', 'scroll']);
  });

  it('passes ordinary events straight through', () => {
    const { c, out } = setup();
    c.event('click', 'button "Save"');
    expect(out).toEqual([{ kind: 'click', label: 'button "Save"' }]);
  });

  it('drops events over the per-second limit and reports how many in one entry', () => {
    const { c, out, advance } = setup({ maxPerSecond: 3 });
    for (let i = 0; i < 10; i++) c.event('click', `b${i}`);
    advance(1100);
    c.event('click', 'later');
    expect(out.map((e) => e.label)).toEqual(['b0', 'b1', 'b2', '…7 more', 'later']);
  });

  it('stops at the total limit and flush reports the rest', () => {
    const { c, out, advance } = setup({ maxPerSecond: 100, maxTotal: 4 });
    for (let i = 0; i < 6; i++) {
      c.event('click', `b${i}`);
      advance(20);
    }
    c.flush();
    expect(out.map((e) => e.label)).toEqual(['b0', 'b1', 'b2', 'b3', '…2 more']);
  });

  it('flush emits a pending typing burst', () => {
    const { c, out } = setup();
    c.typing('input');
    c.flush();
    expect(out).toEqual([{ kind: 'typing', label: 'input (1 key, 0 s)' }]);
  });
});
