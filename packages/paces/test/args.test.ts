import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('reads --no-panel as noPanel', () => {
    const p = parseArgs(['--no-panel', '--', 'node', 'app.js']);
    expect(p.kind === 'profile' ? p.flags.noPanel : 'not a profile').toBe(true);
  });

  it.each([
    [['--keys'], true],
    [['--no-keys'], false],
    [[], undefined],
  ])('reads the hotkey flags %j as keys: %s', (own, keys) => {
    const p = parseArgs([...own, '--', 'node', 'app.js']);
    expect(p).toMatchObject({ kind: 'profile' });
    expect(p.kind === 'profile' ? p.flags.keys : 'not a profile').toBe(keys);
  });

  it('leaves --keys after -- to the target', () => {
    const p = parseArgs(['--', 'node', 'app.js', '--keys']);
    expect(p).toMatchObject({ command: ['node', 'app.js', '--keys'] });
    expect(p.kind === 'profile' ? p.flags.keys : 'not a profile').toBeUndefined();
  });

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

describe('report flags', () => {
  it('--report before -- puts the profile in report mode and keeps the command untouched', () => {
    const p = parseArgs(['--report', '--tree', '--depth', '3', '--', 'node', 'a.js', '--tree']);
    expect(p).toMatchObject({
      kind: 'profile',
      command: ['node', 'a.js', '--tree'],
      flags: { report: { runMode: true, tree: true, depth: 3 } },
    });
  });

  it('parses every drill-down flag', () => {
    const p = parseArgs([
      'report',
      'a.paces',
      '--callers',
      'verify,runRules',
      '--callees',
      'f12',
      '--lines',
      'linter.js:1007',
      '--pkg',
      '@scope/pkg',
      '--top',
      'total',
      '--from',
      'x',
      '--depth',
      '4',
      '--min-ms',
      '2.5',
      '--min-share',
      '1%',
      '--sort',
      'time',
      '--limit',
      '9',
      '--origin',
      'user,dependency',
      '--expand',
      'a',
      '--expand=b',
      '--no-collapse',
      '--task',
      '3',
      '--track',
      'primary',
      '--max-lines',
      '30',
      '--phases',
      '--tasks',
      '--no-color',
      '--json',
    ]);
    expect(p).toMatchObject({
      kind: 'report',
      files: ['a.paces'],
      flags: {
        json: true,
        report: {
          callers: 'verify,runRules',
          callees: 'f12',
          lines: 'linter.js:1007',
          pkg: '@scope/pkg',
          top: 'total',
          from: 'x',
          depth: 4,
          minMs: 2.5,
          minShare: 0.01,
          sort: 'time',
          limit: 9,
          origin: ['user', 'dependency'],
          expand: ['a', 'b'],
          noCollapse: true,
          task: '3',
          track: 'primary',
          maxLines: 30,
          phases: true,
          tasks: true,
          noColor: true,
        },
      },
    });
  });

  it.each([
    ['--min-share', '0.05', 0.05],
    ['--min-share', '5', 0.05],
    ['--min-share', '5%', 0.05],
  ])('%s %s means %f of the root', (flag, value, expected) => {
    const p = parseArgs(['report', 'a.paces', flag, value]);
    expect(p).toMatchObject({ flags: { report: { minShare: expected } } });
  });

  it.each([
    [['--top', 'sideways'], /--top must be one of/],
    [['--sort', 'x'], /--sort must be one of/],
    [['--origin', 'martian'], /--origin must be one of/],
    [['--depth', '0'], /whole number/],
    [['--task', 'two'], /whole number/],
    [['--max-lines', '3'], /at least 8/],
  ])('rejects %j', (flags, message) => {
    expect(() => parseArgs(['report', 'a.paces', ...flags])).toThrow(message);
  });

  it('knows guide', () => {
    expect(parseArgs(['guide'])).toEqual({ kind: 'guide' });
  });
});
