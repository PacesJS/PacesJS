import { describe, expect, it } from 'vitest';
import { isHeadless } from '../src/headless.js';

describe('isHeadless', () => {
  it('treats SSH as headless and a Linux box without a display as headless', () => {
    expect(isHeadless({ SSH_CONNECTION: '1 2 3 4' }, 'win32')).toBe(true);
    expect(isHeadless({}, 'linux')).toBe(true);
    expect(isHeadless({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadless({}, 'win32')).toBe(false);
  });
});
