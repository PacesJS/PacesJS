import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import type { Flags } from '../src/args.js';
import { chooseBrowser, normalizeTarget, recordOptionsFor } from '../src/browser-command.js';
import type { BrowserDeps } from '../src/browser-command.js';

const flagsOf = (argv: string[]): Flags => {
  const parsed = parseArgs(['browser', 'http://x.test', ...argv]);
  if (parsed.kind !== 'browser') throw new Error('not browser');
  return parsed.flags;
};

const deps = (over: Partial<BrowserDeps> = {}): BrowserDeps => ({
  detect: () => Promise.resolve({ kind: 'chromium', name: 'Edge', exe: 'C:\\edge.exe' }),
  exists: () => true,
  headless: () => false,
  ...over,
});

describe('chooseBrowser', () => {
  it('uses the default browser when it is Chromium', async () => {
    expect(await chooseBrowser(flagsOf([]), deps())).toEqual({ exe: 'C:\\edge.exe', name: 'Edge' });
  });

  it('refuses a default browser that is not Chromium, naming it and what to do', async () => {
    const result = await chooseBrowser(
      flagsOf([]),
      deps({ detect: () => Promise.resolve({ kind: 'unsupported', name: 'Firefox' }) }),
    );
    expect(result).toEqual({
      exitCode: 2,
      message:
        'paces: the default browser (Firefox) is not Chromium-based. paces can profile Chrome, Edge, Brave, Vivaldi, Opera and Chromium. Install one, or pass --browser <path>.',
    });
  });

  it('refuses when it cannot tell which browser is the default', async () => {
    const result = await chooseBrowser(
      flagsOf([]),
      deps({ detect: () => Promise.resolve({ kind: 'unknown' }) }),
    );
    expect(result).toEqual({
      exitCode: 2,
      message:
        'paces: could not tell which browser is the default. Pass --browser <path> to a Chromium browser.',
    });
  });

  it('refuses without a display, before anything launches', async () => {
    let detected = false;
    const result = await chooseBrowser(
      flagsOf([]),
      deps({
        headless: () => true,
        detect: () => {
          detected = true;
          return Promise.resolve({ kind: 'unknown' });
        },
      }),
    );
    expect(result).toEqual({
      exitCode: 2,
      message:
        'paces: no display found, so there is no browser window to profile. Run this on a desktop session, or use --attach with a browser started elsewhere.',
    });
    expect(detected).toBe(false);
  });

  it('takes --browser over the default browser, and skips detection', async () => {
    let detected = false;
    const result = await chooseBrowser(
      flagsOf(['--browser', 'D:\\brave.exe']),
      deps({
        detect: () => {
          detected = true;
          return Promise.resolve({ kind: 'unknown' });
        },
      }),
    );
    expect(result).toEqual({ exe: 'D:\\brave.exe', name: 'the browser you chose' });
    expect(detected).toBe(false);
  });

  it('refuses a --browser path that does not exist', async () => {
    const result = await chooseBrowser(
      flagsOf(['--browser', 'D:\\nope.exe']),
      deps({ exists: () => false }),
    );
    expect(result).toEqual({
      exitCode: 2,
      message: 'paces: --browser D:\\nope.exe does not exist. Pass the path to a Chromium browser.',
    });
  });
});

describe('normalizeTarget', () => {
  const none = () => false;

  it('keeps a full URL', () => {
    expect(normalizeTarget('https://example.com/a?b=1', none)).toBe('https://example.com/a?b=1');
  });

  it('assumes http for localhost, an address or a port', () => {
    expect(normalizeTarget('localhost:3000', none)).toBe('http://localhost:3000/');
    expect(normalizeTarget('127.0.0.1:8080/app', none)).toBe('http://127.0.0.1:8080/app');
    expect(normalizeTarget('intranet:9000', none)).toBe('http://intranet:9000/');
  });

  it('assumes https for a bare host name', () => {
    expect(normalizeTarget('example.com', none)).toBe('https://example.com/');
  });

  it('turns a path to an existing file into a file URL', () => {
    expect(normalizeTarget('C:\\site\\index.html', () => true)).toBe('file:///C:/site/index.html');
  });
});

describe('recordOptionsFor', () => {
  it('maps the flags to what the capture host takes', () => {
    const options = recordOptionsFor(
      flagsOf([
        '--paused',
        '--no-screenshots',
        '--no-overlay',
        '--no-event-marks',
        '--no-event-text',
        '--keep-query',
        '--full-trace',
        '--throttle',
        '4x',
        '--cache',
        'cold',
        '--duration',
        '12',
      ]),
      'http://x.test/',
      'C:\\edge.exe',
    );
    expect(options).toMatchObject({
      url: 'http://x.test/',
      exe: 'C:\\edge.exe',
      startPaused: true,
      screenshots: false,
      overlay: false,
      eventMarks: false,
      eventText: false,
      keepQuery: true,
      fullTrace: true,
      throttle: 4,
      cacheCold: true,
      durationMs: 12_000,
    });
  });

  it('records screenshots, the overlay and event marks by default', () => {
    expect(recordOptionsFor(flagsOf([]), 'http://x.test/', 'e')).toMatchObject({
      startPaused: false,
      screenshots: true,
      overlay: true,
      eventMarks: true,
      eventText: true,
      keepQuery: false,
      fullTrace: false,
      cacheCold: false,
    });
  });

  it('asks V8 for a finer sampling interval only when a fine one was requested', () => {
    expect(recordOptionsFor(flagsOf(['--interval', '100']), 'u', 'e').hiRes).toBe(true);
    expect(recordOptionsFor(flagsOf(['--interval', '1000']), 'u', 'e').hiRes).toBe(false);
    expect(recordOptionsFor(flagsOf([]), 'u', 'e').hiRes).toBe(false);
  });
});
