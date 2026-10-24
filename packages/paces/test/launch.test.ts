import { describe, expect, it } from 'vitest';
import { appModeArgs, findBrowser, isHeadless, planEditorOpen } from '../src/launch.js';

describe('findBrowser', () => {
  const win = { PROGRAMFILES: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const edgeX86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  it('finds Edge in the (x86) Program Files path on Windows', () => {
    expect(findBrowser({ env: win, platform: 'win32', exists: (p) => p === edgeX86 })).toBe(
      edgeX86,
    );
  });

  it('prefers Edge over Chrome when both are installed', () => {
    const both = new Set([edgeX86, chrome]);
    expect(findBrowser({ env: win, platform: 'win32', exists: (p) => both.has(p) })).toBe(edgeX86);
  });

  it('falls back to Chrome, then to nothing', () => {
    expect(findBrowser({ env: win, platform: 'win32', exists: (p) => p === chrome })).toBe(chrome);
    expect(findBrowser({ env: win, platform: 'win32', exists: () => false })).toBeUndefined();
  });

  it('finds the macOS Edge bundle', () => {
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    expect(findBrowser({ env: {}, platform: 'darwin', exists: (p) => p === edge })).toBe(edge);
  });
});

describe('isHeadless', () => {
  it('treats SSH as headless and a Linux box without a display as headless', () => {
    expect(isHeadless({ SSH_CONNECTION: '1 2 3 4' }, 'win32')).toBe(true);
    expect(isHeadless({}, 'linux')).toBe(true);
    expect(isHeadless({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadless({}, 'win32')).toBe(false);
  });
});

describe('appModeArgs', () => {
  it('opens a chromeless app window in a throwaway profile', () => {
    expect(appModeArgs('http://127.0.0.1:1/?token=t', 'C:\\tmp\\p')).toEqual(
      expect.arrayContaining(['--app=http://127.0.0.1:1/?token=t', '--user-data-dir=C:\\tmp\\p']),
    );
  });

  it('turns extensions off so installed ones cannot open onboarding pages', () => {
    expect(appModeArgs('http://127.0.0.1:1/?token=t', 'C:\\tmp\\p')).toEqual(
      expect.arrayContaining(['--disable-extensions', '--disable-default-apps']),
    );
  });

  it('keeps the throwaway profile from signing in and syncing', () => {
    expect(appModeArgs('http://127.0.0.1:1/?token=t', 'C:\\tmp\\p')).toEqual(
      expect.arrayContaining(['--disable-sync', '--disable-features=msImplicitSignin']),
    );
  });
});

describe('planEditorOpen', () => {
  const env = { PATH: '/bin' };
  const hasCode = (p: string) => p === '/bin/code';

  it('uses code -g file:line when code is on PATH', () => {
    expect(planEditorOpen('/p/a.ts', 12, env, 'linux', hasCode)).toEqual({
      file: '/bin/code',
      args: ['-g', '/p/a.ts:12'],
    });
  });

  it('falls back to the OS default opener without code', () => {
    expect(planEditorOpen('/p/a.ts', 1, env, 'linux', () => false)).toEqual({
      file: 'xdg-open',
      args: ['/p/a.ts'],
    });
  });

  it('never routes a path with shell metacharacters through code.cmd', () => {
    const plan = planEditorOpen(
      'C:\\p\\a&calc.ts',
      3,
      { PATH: 'C:\\bin', PATHEXT: '.CMD' },
      'win32',
      (p) => p.endsWith('code.cmd'),
    );
    expect(plan.shell).toBeUndefined();
    expect(plan.file).toBe('rundll32');
  });

  it('coerces a bad line number to 1', () => {
    expect(planEditorOpen('/p/a.ts', Number.NaN, env, 'linux', hasCode).args).toEqual([
      '-g',
      '/p/a.ts:1',
    ]);
  });
});
