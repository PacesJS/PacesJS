import { describe, expect, it } from 'vitest';
import { fmtPct, fmtUs, place, shortPath } from '../src/report/format.js';

describe('report formatting', () => {
  it.each([
    [0, '~0 ms'],
    [4_200, '~4.2 ms'],
    [49_600, '~50 ms'],
    [3_922_300, '~3922 ms'],
    [9_999_000, '~9999 ms'],
    [10_000_000, '~10.0 s'],
    [12_960_000, '~13.0 s'],
  ])('%i us is %s', (us, text) => {
    expect(fmtUs(us)).toBe(text);
  });

  it.each([
    [1, '100%'],
    [0.356, '36%'],
    [0.0451, '4.5%'],
    [0.00004, '<0.1%'],
  ])('share %f is %s', (share, text) => {
    expect(fmtPct(share)).toBe(text);
  });

  it('shortens pnpm and npm paths to the package-relative path', () => {
    expect(shortPath('node_modules/.pnpm/eslint@9/node_modules/eslint/lib/a.js')).toBe(
      'eslint/lib/a.js',
    );
    expect(shortPath('src/app.js')).toBe('src/app.js');
    expect(place('src/app.js', 12)).toBe('src/app.js:12');
    expect(place('', 3)).toBe('');
  });
});
