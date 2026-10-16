import { describe, expect, it } from 'vitest';
import { displayEntry } from '../../src/util/format';

describe('entry path display', () => {
  it('shortens a pnpm-installed package script to its package-relative path', () => {
    expect(displayEntry('node_modules/.pnpm/eslint@9.39.5/node_modules/eslint/bin/eslint.js')).toBe(
      'eslint/bin/eslint.js',
    );
  });

  it('leaves a project script alone', () => {
    expect(displayEntry('zoo/orders-server/dist/server.js')).toBe(
      'zoo/orders-server/dist/server.js',
    );
  });
});
