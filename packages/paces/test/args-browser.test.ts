import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../src/args.js';

const browser = (argv: string[]) => {
  const parsed = parseArgs(['browser', ...argv]);
  if (parsed.kind !== 'browser') throw new Error(`parsed as ${parsed.kind}`);
  return parsed;
};

describe('paces browser: arguments', () => {
  it('takes a URL', () => {
    expect(browser(['http://localhost:3000']).target).toBe('http://localhost:3000');
  });

  it('has the defaults of a plain run: screenshots, overlay and event marks on', () => {
    const { flags } = browser(['http://localhost:3000']);
    expect(flags.browser).toMatchObject({
      noScreenshots: false,
      noOverlay: false,
      noEventMarks: false,
      noEventText: false,
      keepQuery: false,
      fullTrace: false,
      paused: false,
      firstParty: [],
    });
  });

  it('reads the switches', () => {
    const { flags } = browser([
      'http://x.test',
      '--paused',
      '--no-screenshots',
      '--no-overlay',
      '--no-event-marks',
      '--no-event-text',
      '--keep-query',
      '--full-trace',
    ]);
    expect(flags.browser).toMatchObject({
      paused: true,
      noScreenshots: true,
      noOverlay: true,
      noEventMarks: true,
      noEventText: true,
      keepQuery: true,
      fullTrace: true,
    });
  });

  it('reads the options with values', () => {
    const { flags } = browser([
      'http://x.test',
      '--browser',
      'C:\\chrome.exe',
      '--root',
      './src',
      '--throttle',
      '4x',
      '--cache',
      'cold',
      '--first-party',
      'https://cdn.x.test/**',
      '--first-party',
      '*.y.test',
      '--duration',
      '10',
      '--out',
      'run.paces',
    ]);
    expect(flags.browser).toMatchObject({
      path: 'C:\\chrome.exe',
      root: './src',
      throttle: 4,
      cache: 'cold',
      firstParty: ['https://cdn.x.test/**', '*.y.test'],
    });
    expect(flags.duration).toBe(10);
    expect(flags.out).toBe('run.paces');
  });

  it('accepts a throttle without the x', () => {
    expect(browser(['http://x.test', '--throttle', '6']).flags.browser.throttle).toBe(6);
  });

  it('joins a browser the user started, by port, without needing a URL', () => {
    const parsed = browser(['--attach', '9222']);
    expect(parsed.flags.browser.attach).toBe(9222);
    expect(parsed.target).toBeUndefined();
  });

  it('asks for a URL or --attach', () => {
    expect(() => parseArgs(['browser'])).toThrow(UsageError);
    expect(() => parseArgs(['browser'])).toThrow(/URL/);
  });

  it.each([
    [['http://x.test', '--attach', 'nope'], /--attach/],
    [['http://x.test', '--attach', '70000'], /--attach/],
    [['http://x.test', '--throttle', '0x'], /--throttle/],
    [['http://x.test', '--throttle', 'fast'], /--throttle/],
    [['http://x.test', '--cache', 'warm'], /--cache/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(['browser', ...argv])).toThrow(message);
  });

  it('refuses two URLs', () => {
    expect(() => parseArgs(['browser', 'http://a.test', 'http://b.test'])).toThrow(UsageError);
  });
});
