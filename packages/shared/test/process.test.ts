import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killTree, removeDetached, removeQuietly } from '../src/process.js';

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

describe('removeDetached', () => {
  it('removes the directory in a separate process, without waiting for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-shared-'));
    writeFileSync(join(dir, 'leftover'), 'x');
    removeDetached(dir);
    await waitFor(() => !existsSync(dir));
    expect(existsSync(dir)).toBe(false);
  });
});

describe('removeQuietly', () => {
  it('removes a directory and does not throw when it is already gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-shared-'));
    removeQuietly(dir);
    expect(() => removeQuietly(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('killTree', () => {
  it('ends a running process and resolves its exit', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killTree(child);
    await expect(exited).resolves.toBeDefined();
  });

  it('ends a grandchild as well as the root process', async () => {
    const script =
      "const {spawn}=require('node:child_process');" +
      "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
      'console.log(c.pid);setInterval(()=>{},1000)';
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))),
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killTree(child);
    await exited;
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => !alive());
    expect(alive()).toBe(false);
  });

  it('does nothing for a process that has already exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    expect(() => killTree(child)).not.toThrow();
  });
});
