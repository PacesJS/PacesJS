import { describe, expect, it } from 'vitest';
import { matchCallSites } from '../../src/view/call-sites';

describe('call-site chips', () => {
  it('pins a callee to the line that calls it', () => {
    const lines = [
      'export function load() {',
      "  const raw = fs.readFileSync(file, 'utf8');",
      '  return raw;',
      '}',
    ];
    const chips = matchCallSites(lines, [
      { fn: 1, name: 'fs.readFileSync', totalUs: 37_000, origin: 3 },
    ]);
    expect(chips).toEqual([expect.objectContaining({ lineIndex: 1, name: 'fs.readFileSync' })]);
  });

  it('skips callees whose name is not callable on any line', () => {
    expect(
      matchCallSites(['const x = 1;'], [{ fn: 2, name: 'ghost', totalUs: 1, origin: 0 }]),
    ).toEqual([]);
  });
});
