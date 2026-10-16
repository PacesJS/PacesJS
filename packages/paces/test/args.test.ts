import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('passes everything after -- to the target untouched, including look-alike flags', () => {
    const p = parseArgs(['--no-open', '--', 'node', 'app.js', '--no-open', '--interval', '5']);
    expect(p).toMatchObject({
      kind: 'profile',
      command: ['node', 'app.js', '--no-open', '--interval', '5'],
      flags: { noOpen: true },
    });
  });

  it('parses every profile flag, in spaced and equals form', () => {
    const p = parseArgs([
      '--interval',
      '100',
      '--async',
      '--duration=5',
      '--start-on',
      'SIGUSR2',
      '--out',
      'a.paces',
      '--embed-sources',
      '--include',
      '*a*',
      '--include=*b*',
      '--exclude',
      '*c*',
      '--',
      'node',
      'x.js',
    ]);
    expect(p).toMatchObject({
      flags: {
        interval: 100,
        async: true,
        duration: 5,
        startOn: 'SIGUSR2',
        out: 'a.paces',
        embedSources: true,
        include: ['*a*', '*b*'],
        exclude: ['*c*'],
      },
    });
  });

  it.each([
    [['open', 'a.paces'], { kind: 'open', files: ['a.paces'] }],
    [
      ['summary', 'a.paces', '--json'],
      { kind: 'summary', files: ['a.paces'], flags: { json: true } },
    ],
    [['diff', 'a.paces', 'b.paces'], { kind: 'diff', files: ['a.paces', 'b.paces'] }],
    [['import', 'p.cpuprofile'], { kind: 'import', files: ['p.cpuprofile'] }],
    [['mcp', 'a.paces'], { kind: 'mcp', files: ['a.paces'] }],
  ])('parses the subcommand %j', (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  it.each([
    [[], 'help'],
    [['--help'], 'help'],
    [['--version'], 'version'],
  ])('maps %j to %s', (argv, kind) => {
    expect(parseArgs(argv)).toEqual({ kind });
  });

  it.each([
    [['--'], /Nothing to run/],
    [['--bogus', '--', 'node'], /Unknown flag --bogus/],
    [['--interval'], /needs a value/],
    [['--interval', 'abc', '--', 'node'], /positive number/],
    [['--out'], /needs a value/],
    [['node', 'app.js'], /put it after "--"/],
    [['diff', 'a.paces'], /two files/],
    [['open'], /one file/],
    [['x', '--', 'node'], /Unexpected "x"/],
  ])('rejects %j with an actionable message', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
