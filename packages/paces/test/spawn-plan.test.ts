import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planSpawn } from '../src/spawn-plan.js';
import { which } from '../src/which.js';

describe('planSpawn', () => {
  const env = { PATH: 'C:\\bin;C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'cmd.exe' };

  it('spawns directly on POSIX with arguments untouched', () => {
    expect(planSpawn(['npm', 'run', 'a b'], {}, 'linux')).toEqual({
      file: 'npm',
      args: ['run', 'a b'],
      verbatim: false,
    });
  });

  it('runs a .cmd shim through one quoted cmd.exe line, never a shell option', () => {
    const exists = (p: string) => p === 'C:\\nodejs\\npm.cmd';
    const plan = planSpawn(['npm', 'run', 'start app'], env, 'win32', exists);
    expect(plan).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', String.raw`""C:\nodejs\npm.cmd" ^^^"run^^^" ^^^"start app^^^""`],
      verbatim: true,
    });
  });

  it('spawns an .exe directly on Windows', () => {
    const exists = (p: string) => p === 'C:\\nodejs\\node.exe';
    expect(planSpawn(['node', 'app.js'], env, 'win32', exists)).toMatchObject({
      verbatim: false,
      file: 'node',
    });
  });
});

describe.runIf(process.platform === 'win32')(
  'a real .cmd shim keeps awkward arguments intact',
  () => {
    const tricky = [
      'plain',
      'has space',
      'say "hi"',
      'a&b',
      'a|b',
      '50%',
      '%NOPE_VAR_XYZ%',
      'caf\u00e9 \u4e2d\u6587',
      'back\\slash\\',
      '(paren)',
      'a^b',
      '!bang',
    ];
    for (const nodeModulesBin of [false, true]) {
      it(`${nodeModulesBin ? 'node_modules/.bin' : 'plain'} shim passes ${tricky.length} arguments`, () => {
        const dir = mkdtempSync(join(tmpdir(), nodeModulesBin ? 'paces sp ' : 'paces-sp-'));
        try {
          const bin = nodeModulesBin ? join(dir, 'node_modules', '.bin') : dir;
          mkdirSync(bin, { recursive: true });
          writeFileSync(
            join(dir, 'echo.js'),
            'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
          );
          writeFileSync(
            join(bin, 'echo.cmd'),
            `@echo off\r\nnode "${join(dir, 'echo.js')}" %*\r\n`,
          );
          const plan = planSpawn([join(bin, 'echo.cmd'), ...tricky], process.env, 'win32');
          const r = spawnSync(plan.file, plan.args, {
            encoding: 'utf8',
            windowsVerbatimArguments: plan.verbatim,
          });
          expect(JSON.parse(r.stdout)).toEqual(tricky);
          expect(r.stderr).not.toContain('DEP0190');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  },
);

describe('which', () => {
  it('prefers PATHEXT order and finds nothing for an unknown command', () => {
    const exists = (p: string) => p.endsWith('tsx.cmd');
    const env = { PATH: 'C:\\x', PATHEXT: '.EXE;.CMD' };
    expect(which('tsx', env, 'win32', exists)).toBe('C:\\x\\tsx.cmd');
    expect(which('nope', env, 'win32', () => false)).toBeUndefined();
  });
});
