import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { summarizeWarnings } from '../src/commands.js';
import { formatSummary } from '../src/summary.js';

describe('formatSummary', () => {
  const summary = {
    runKind: 'cli-tool',
    target: 'eslint',
    primaryTrack: 'main · pid 12',
    findings: [
      {
        severity: 'high',
        title: 'Hot function',
        summary: '`parse` takes 31% of busy time.',
        rule: 'share above 10%',
        evidence: [{ name: 'parse', file: 'src/parser.ts', line: 42 }],
      },
    ],
    topSelf: [{ name: 'walk', file: 'lib/walk.js', line: 7, selfMs: 120.5, share: 0.25 }],
    caveats: ['sampled at 1 ms'],
  };

  it('prints what ran before the findings', () => {
    const out = formatSummary(summary);
    expect(out).toContain('run: cli-tool');
    expect(out).toContain('target: eslint');
    expect(out).toContain('primary track: main · pid 12');
  });

  it('names each finding with function and file:line evidence', () => {
    expect(formatSummary(summary)).toContain('at parse (src/parser.ts:42)');
  });

  it('lists the top functions by self time with share', () => {
    expect(formatSummary(summary)).toContain('~120.5 ms 25.0%  walk (lib/walk.js:7)');
  });

  it('works for summaries from an engine without the new fields', () => {
    const out = formatSummary({ findings: [] });
    expect(out).toContain('No findings');
    expect(out).not.toContain('run:');
  });
});

describe('--focus', () => {
  it('is repeatable and defaults to empty', () => {
    expect(parseArgs(['summary', 'a.paces']).kind).toBe('summary');
    const p = parseArgs(['summary', 'a.paces', '--focus', 'eslint', '--focus=**/rules/*']);
    expect(p).toMatchObject({ flags: { focus: ['eslint', '**/rules/*'] } });
  });
});

describe('summarizeWarnings', () => {
  it('counts structured warnings by code and plain ones as "warning"', () => {
    expect(summarizeWarnings([{ code: 'map-missing' }, { code: 'map-missing' }, 'text'])).toEqual({
      total: 3,
      byCode: { 'map-missing': 2, warning: 1 },
    });
    expect(summarizeWarnings(undefined)).toEqual({ total: 0, byCode: {} });
  });
});

describe('formatSummary with a fix', () => {
  it('prints the fix under the finding that has one', () => {
    const out = formatSummary({
      findings: [
        {
          severity: 'low',
          title: 'V8 keeps deoptimizing a hot function',
          summary: 'price was deoptimized 10 times for "wrong map".',
          hint: 'Create objects with the same properties in the same order.',
        },
      ],
    });
    expect(out).toContain('fix: Create objects with the same properties in the same order.');
  });
});

describe('formatSummary: network', () => {
  const summary = {
    runKind: 'page',
    findings: [],
    network: {
      requests: 163,
      wireKB: 2434,
      decodedKB: 7099,
      byType: [
        { type: 'Script', count: 112, wireKB: 1573 },
        { type: 'Font', count: 9, wireKB: 597 },
      ],
      scripts: [
        {
          url: 'https://cdn.example.com/app.js',
          wireKB: 143,
          decodedKB: 486,
          downloadMs: 62,
          renderBlocking: true,
          cached: false,
          selfMs: 310.4,
        },
        {
          url: 'https://cdn.example.com/lazy.js',
          wireKB: 4.5,
          decodedKB: 12,
          downloadMs: null,
          renderBlocking: false,
          cached: true,
          selfMs: 2,
        },
      ],
    },
  };

  it('prints the totals and the bytes by type', () => {
    const out = formatSummary(summary);
    expect(out).toContain('Network: 163 requests, 2.4 MB (6.9 MB unpacked)');
    expect(out).toContain('Script 112 (1.5 MB)');
  });

  it('prints each script with its fetch cost beside its run cost', () => {
    const out = formatSummary(summary);
    expect(out).toContain(
      '143 KB (486 KB unpacked), fetched in 62 ms, ~310 ms to run, render-blocking',
    );
    expect(out).toContain('https://cdn.example.com/app.js');
    expect(out).toContain('from cache');
  });

  it('prints nothing about the network for a run without it', () => {
    expect(formatSummary({ runKind: 'script', findings: [] })).not.toContain('Network:');
  });
});
