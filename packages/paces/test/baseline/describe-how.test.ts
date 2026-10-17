// Characterization test for the safe-refactor run: how an ambiguous selector says it was matched.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyze } from '@pacesjs/engine';
import type { RawCapture } from '@pacesjs/engine';
import { parseArgs } from '../../src/args.js';
import { renderReport } from '../../src/report/report.js';

const model = analyze(
  JSON.parse(
    gunzipSync(
      readFileSync(
        new URL('../../../engine/test/fixtures/eslint-cli.capture.json.gz', import.meta.url),
      ),
    ).toString('utf8'),
  ) as RawCapture,
);

function error(selector: string): string {
  const parsed = parseArgs(['report', 'x.paces', '--from', selector]);
  if (parsed.kind !== 'report') throw new Error('not a report');
  try {
    renderReport({ model, file: 'S.paces', color: false }, parsed.flags);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('ambiguous selectors', () => {
  it.each([
    ['ntext', /^"ntext" is ambiguous: it matched 6 functions by substring:\n/],
    ['get', /^"get" is ambiguous: it matched 6 functions exactly:\n/],
    ['eslint.js:1', /^"eslint.js:1" is ambiguous: it matched 2 functions by file:line:\n/],
  ])('says how %s was matched', (selector, expected) => {
    expect(error(selector)).toMatch(expected);
  });

  it('ends with the way out', () => {
    expect(error('ntext')).toMatch(
      /\nPick one by id \(e\.g\. f\d+\), by file:line, or with a path like parent,ntext\.$/,
    );
  });
});
