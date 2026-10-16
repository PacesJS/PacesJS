import { describe, expect, it } from 'vitest';
import { planSpawn, quoteCmdArg } from '../src/spawn-plan.js';
import { which } from '../src/which.js';

describe('quoteCmdArg', () => {
  it.each([
    ['plain', 'plain'],
    ['has space', '"has space"'],
    ['', '""'],
    ['a&b', '"a&b"'],
    ['say "hi"', '"say \\"hi\\""'],
  ])('quotes %j as %s', (input, expected) => {
    expect(quoteCmdArg(input)).toBe(expected);
  });
});

describe('planSpawn', () => {
  const env = { PATH: 'C:\\bin;C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('spawns directly on POSIX with arguments untouched', () => {
    expect(planSpawn(['npm', 'run', 'a b'], {}, 'linux')).toEqual({
      file: 'npm',
      args: ['run', 'a b'],
      shell: false,
    });
  });

  it('uses a quoted shell command line for a .cmd shim on Windows', () => {
    const exists = (p: string) => p === 'C:\\nodejs\\npm.cmd';
    expect(planSpawn(['npm', 'run', 'start app'], env, 'win32', exists)).toEqual({
      file: 'C:\\nodejs\\npm.cmd',
      args: ['run', '"start app"'],
      shell: true,
    });
  });

  it('spawns an .exe directly on Windows', () => {
    const exists = (p: string) => p === 'C:\\nodejs\\node.exe';
    expect(planSpawn(['node', 'app.js'], env, 'win32', exists)).toMatchObject({
      shell: false,
      file: 'node',
    });
  });
});

describe('which', () => {
  it('prefers PATHEXT order and finds nothing for an unknown command', () => {
    const exists = (p: string) => p.endsWith('tsx.cmd');
    const env = { PATH: 'C:\\x', PATHEXT: '.EXE;.CMD' };
    expect(which('tsx', env, 'win32', exists)).toBe('C:\\x\\tsx.cmd');
    expect(which('nope', env, 'win32', () => false)).toBeUndefined();
  });
});
