import { describe, expect, it } from 'vitest';
import { globToRegExp, shouldProfile } from '../src/glob.js';

describe('globToRegExp', () => {
  it.each([
    ['*.js', 'app.js', true],
    ['*.js', 'src/app.js', false],
    ['**/app.js', 'a/b/app.js', true],
    ['**/*.cjs', 'zoo/apps/x.cjs', true],
    ['a?c', 'abc', true],
    ['a.c', 'abc', false],
  ])('%s against %s is %s', (glob, text, expected) => {
    expect(globToRegExp(glob).test(text)).toBe(expected);
  });
});

describe('shouldProfile', () => {
  const server = ['node', 'C:\\proj\\server.js'];
  const worker = ['node', 'C:\\proj\\worker.js'];

  it('profiles everything with no filters', () => {
    expect(shouldProfile(server, [], [])).toBe(true);
  });

  it('keeps only included processes', () => {
    expect(shouldProfile(server, ['**/server.js'], [])).toBe(true);
    expect(shouldProfile(worker, ['**/server.js'], [])).toBe(false);
  });

  it('drops excluded processes', () => {
    expect(shouldProfile(worker, [], ['*worker*'])).toBe(false);
    expect(shouldProfile(server, [], ['*worker*'])).toBe(true);
  });
});
