import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSER_FIXTURES } from '../helpers/browser-fixtures.js';

const BUDGET_BYTES = 500 * 1024;

describe('browser fixtures', () => {
  it.each(BROWSER_FIXTURES)('%s stays within the size budget', (name) => {
    const url = new URL(`../fixtures/browser/${name}.browser.json.gz`, import.meta.url);
    expect(statSync(url).size).toBeLessThan(BUDGET_BYTES);
  });
});
