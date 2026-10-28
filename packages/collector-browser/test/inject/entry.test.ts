// Runs the real injected script text in a DOM, the way the browser runs it, with the bridge binding
// replaced by a recorder. What the real browser adds (that CDP injects it, that V8 reports its URL)
// is covered by the real-browser tests; what the script does on a page is covered here.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInjectedSource } from '../../src/inject/entry.js';
import type { InjectConfig } from '../../src/inject/entry.js';

interface Sent {
  t: string;
  [key: string]: unknown;
}

interface Page {
  window: JSDOM['window'] & Record<string, unknown>;
  sent: Sent[];
  stamps: string[];
  install(config?: Partial<InjectConfig>): void;
  events(): Sent[];
}

const ALL: InjectConfig = { overlay: true, eventMarks: true, eventText: false };
const pages: JSDOM[] = [];

function page(html = '<!doctype html><body></body>'): Page {
  const dom = new JSDOM(html, {
    url: 'https://example.test/app?token=abc#frag',
    runScripts: 'outside-only',
  });
  pages.push(dom);
  const window = dom.window as Page['window'];
  const sent: Sent[] = [];
  const stamps: string[] = [];
  window['__pacesBridge'] = (payload: string) => sent.push(JSON.parse(payload) as Sent);
  (window.console as unknown as { timeStamp: (label: string) => void }).timeStamp = (label) =>
    void stamps.push(label);
  return {
    window,
    sent,
    stamps,
    install: (config = {}) => void window.eval(buildInjectedSource({ ...ALL, ...config })),
    events: () => sent.filter((m) => m.t === 'event'),
  };
}

const click = (p: Page, target: Element): void =>
  void target.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, composed: true }));

const keydown = (p: Page, init: KeyboardEventInit): KeyboardEvent => {
  const event = new p.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  p.window.dispatchEvent(event);
  return event as unknown as KeyboardEvent;
};

afterEach(() => {
  for (const dom of pages.splice(0)) dom.window.close();
});

describe('installing', () => {
  it('says hello once from the top frame, with the page address and no query or fragment', () => {
    const p = page();
    p.install();
    p.install();
    expect(p.sent.filter((m) => m.t === 'hello')).toEqual([
      { t: 'hello', frame: 'top', url: 'https://example.test/app' },
    ]);
  });

  it('exposes one hidden, fixed api', () => {
    const p = page();
    p.install();
    const descriptor = Object.getOwnPropertyDescriptor(p.window, '__paces__');
    expect(descriptor).toMatchObject({ enumerable: false, configurable: false, writable: false });
  });

  it('stamps the trace clock and answers with the time when the host syncs', () => {
    const p = page();
    p.install();
    const api = p.window['__paces__'] as { sync(n: number): number };
    const before = Date.now();
    const epoch = api.sync(3);
    expect(p.stamps).toContain('paces:sync:3');
    expect(epoch).toBeGreaterThanOrEqual(before - 5);
    expect(epoch).toBeLessThanOrEqual(Date.now() + 5);
  });

  it('keeps working when the host is not listening', () => {
    const p = page();
    delete p.window['__pacesBridge'];
    expect(() => p.install()).not.toThrow();
    const button = p.window.document.createElement('button');
    p.window.document.body.appendChild(button);
    expect(() => click(p, button)).not.toThrow();
  });

  it('keeps working when the host throws', () => {
    const p = page();
    p.window['__pacesBridge'] = () => {
      throw new Error('detached');
    };
    expect(() => p.install()).not.toThrow();
  });

  it('works when the console has no timeStamp', () => {
    const p = page();
    delete (p.window.console as unknown as Record<string, unknown>)['timeStamp'];
    p.install();
    const api = p.window['__paces__'] as { sync(n: number): number };
    expect(() => api.sync(1)).not.toThrow();
  });
});

describe('events', () => {
  it('describes a click by structure, stamps it on the trace and sends its join key', () => {
    const p = page('<!doctype html><body><button id="save">Save order</button></body>');
    p.install();
    click(p, p.window.document.getElementById('save') as Element);
    const [event] = p.events();
    expect(event).toMatchObject({ kind: 'click', label: 'button#save', frame: 'top' });
    expect(p.stamps).toContain(`paces:${String(event?.seq)}`);
    expect(typeof event?.at).toBe('number');
  });

  it('numbers events so no two share a join key', () => {
    const p = page('<!doctype html><body><button id="a">A</button></body>');
    p.install();
    const a = p.window.document.getElementById('a') as Element;
    click(p, a);
    click(p, a);
    const seqs = p.events().map((e) => e.seq);
    expect(new Set(seqs).size).toBe(2);
  });

  it('describes a click on an SVG icon, whose className is not a string', () => {
    const p = page(
      '<!doctype html><body><svg class="icon big"><path id="p" class="stroke"/></svg></body>',
    );
    p.install();
    click(p, p.window.document.getElementById('p') as Element);
    expect(p.events()).toHaveLength(1);
    expect(p.events()[0]?.label).toContain('path');
  });

  it('names a button by its text only when asked to', () => {
    const html = '<!doctype html><body><button class="primary">Pay now</button></body>';
    const off = page(html);
    off.install({ eventText: false });
    click(off, off.window.document.querySelector('button') as Element);
    expect(String(off.events()[0]?.label)).not.toContain('Pay now');

    const on = page(html);
    on.install({ eventText: true });
    click(on, on.window.document.querySelector('button') as Element);
    expect(String(on.events()[0]?.label)).toContain('Pay now');
  });

  it('never sends what was typed, only that typing happened', () => {
    const p = page('<!doctype html><body><input id="pw" type="password" name="pw"></body>');
    p.install({ eventText: true });
    const input = p.window.document.getElementById('pw') as HTMLInputElement;
    for (const value of ['h', 'hu', 'hunter2']) {
      input.value = value;
      input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    }
    p.window.dispatchEvent(new p.window.Event('pagehide'));
    expect(JSON.stringify(p.sent)).not.toContain('hunter2');
    expect(p.events().map((e) => e.kind)).toEqual(['typing']);
    expect(String(p.events()[0]?.label)).toMatch(/\(3 keys, /);
  });

  it('reports a change of a select, a checkbox or a radio, and not of a text field', () => {
    const p = page(
      '<!doctype html><body><select id="s"></select><input id="c" type="checkbox"><input id="t" type="text"></body>',
    );
    p.install();
    for (const id of ['s', 'c', 't']) {
      const element = p.window.document.getElementById(id) as Element;
      element.dispatchEvent(new p.window.Event('change', { bubbles: true }));
    }
    expect(p.events().map((e) => [e.kind, e.label])).toEqual([
      ['change', 'select#s'],
      ['change', 'input[type=checkbox]#c'],
    ]);
  });

  it('reports a submit', () => {
    const p = page('<!doctype html><body><form id="f"></form></body>');
    p.install();
    (p.window.document.getElementById('f') as Element).dispatchEvent(
      new p.window.Event('submit', { bubbles: true }),
    );
    expect(p.events()[0]).toMatchObject({ kind: 'submit', label: 'form#f' });
  });

  it.each([
    [{ key: 'Enter' }, 'Enter'],
    [{ key: 'Escape' }, 'Escape'],
    [{ key: 'ArrowDown' }, 'Arrow'],
    [{ key: 's', ctrlKey: true }, 'Shortcut'],
    [{ key: 'k', metaKey: true }, 'Shortcut'],
    [{ key: 'x', altKey: true }, 'Shortcut'],
  ])('names the key %j by its class, never the key', (init, label) => {
    const p = page();
    p.install();
    keydown(p, init);
    expect(p.events().map((e) => [e.kind, e.label])).toEqual([['key', label]]);
  });

  it('does not report an ordinary letter', () => {
    const p = page();
    p.install();
    keydown(p, { key: 'a' });
    expect(p.events()).toEqual([]);
  });

  it('reports scroll once after a quiet second, and a visibility change', () => {
    const p = page();
    p.install();
    p.window.dispatchEvent(new p.window.Event('scroll'));
    p.window.dispatchEvent(new p.window.Event('scroll'));
    p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
    expect(p.events().map((e) => e.kind)).toEqual(['scroll', 'visibility']);
  });

  it('listens for nothing when event marks are off', () => {
    const p = page('<!doctype html><body><button id="b">B</button></body>');
    p.install({ eventMarks: false });
    click(p, p.window.document.getElementById('b') as Element);
    keydown(p, { key: 'Enter' });
    expect(p.events()).toEqual([]);
  });
});

describe('the overlay', () => {
  it('adds one element of its own to the page, behind a closed shadow root', () => {
    const p = page();
    const before = p.window.document.documentElement.childElementCount;
    p.install();
    const root = p.window.document.documentElement;
    expect(root.childElementCount).toBe(before + 1);
    expect((root.lastElementChild as Element).shadowRoot).toBeNull();
  });

  it('adds nothing when it is off', () => {
    const p = page();
    const before = p.window.document.documentElement.childElementCount;
    p.install({ overlay: false });
    expect(p.window.document.documentElement.childElementCount).toBe(before);
  });

  it('waits for the body before attaching, so it never becomes the document root', async () => {
    const p = page();
    const { document } = p.window;
    const body = document.body;
    body.remove();
    p.install();
    expect(document.documentElement.lastElementChild?.tagName).toBe('HEAD');
    document.documentElement.appendChild(body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.documentElement.lastElementChild?.tagName).toBe('DIV');
  });

  it('pauses on Alt+Shift+P, resumes on the next one once the host says it is paused, and keeps the page its own keys', () => {
    const p = page();
    p.install();
    const api = p.window['__paces__'] as { state(s: object): void };
    const pause = keydown(p, { altKey: true, shiftKey: true, code: 'KeyP' });
    expect(pause.defaultPrevented).toBe(true);
    api.state({ phase: 'paused', elapsedMs: 1000, marks: 0 });
    keydown(p, { altKey: true, shiftKey: true, code: 'KeyP' });
    const controls = p.sent.filter((m) => m.t === 'control').map((m) => m.action);
    expect(controls).toEqual(['pause', 'resume']);
    const other = keydown(p, { altKey: true, shiftKey: true, code: 'KeyZ' });
    expect(other.defaultPrevented).toBe(false);
    const plain = keydown(p, { code: 'KeyP' });
    expect(plain.defaultPrevented).toBe(false);
  });

  it('opens the mark field on Alt+Shift+M without a control message', () => {
    const p = page();
    p.install();
    const event = keydown(p, { altKey: true, shiftKey: true, code: 'KeyM' });
    expect(event.defaultPrevented).toBe(true);
    expect(p.sent.filter((m) => m.t === 'control')).toEqual([]);
  });

  it('does not take the shortcuts when it is off', () => {
    const p = page();
    p.install({ overlay: false });
    const event = keydown(p, { altKey: true, shiftKey: true, code: 'KeyP' });
    expect(event.defaultPrevented).toBe(false);
  });

  it('takes the host state, including a move of the corner, without throwing', () => {
    const p = page();
    p.install();
    const api = p.window['__paces__'] as { state(s: object): void };
    expect(() => {
      api.state({ phase: 'recording', elapsedMs: 10, marks: 1, position: 'top-left' });
      api.state({ phase: 'paused', elapsedMs: 10, marks: 1 });
      api.state({ phase: 'stopping', elapsedMs: 10, marks: 1 });
    }).not.toThrow();
  });
});
