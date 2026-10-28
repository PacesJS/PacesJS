// launchBrowser with the process boundary replaced: the wiring of the pipe, the exit promise and kill.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ child: undefined as unknown }));
const killTree = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => spawned.child) }));
vi.mock('@pacesjs/shared', () => ({ killTree }));

const { spawn } = await import('node:child_process');
const { launchBrowser } = await import('../src/launch.js');

function fakeChild() {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    stdio: [null, null, null, toBrowser, fromBrowser],
  });
  spawned.child = child;
  return { child, toBrowser, fromBrowser };
}

describe('launchBrowser', () => {
  it('starts the executable with the pipe flags and the pipes on descriptors 3 and 4', () => {
    fakeChild();
    launchBrowser({ exe: 'chrome', profileDir: '/tmp/p', windowSize: '800,600' });
    const [exe, args, options] = vi.mocked(spawn).mock.calls.at(-1) ?? [];
    expect(exe).toBe('chrome');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--window-size=800,600');
    expect(options).toMatchObject({ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  });

  it('talks to the browser over the pipe: commands out on 3, replies in on 4', async () => {
    const { toBrowser, fromBrowser } = fakeChild();
    const { client } = launchBrowser({ exe: 'chrome', profileDir: '/tmp/p' });
    const written = new Promise<string>((resolve) =>
      toBrowser.once('data', (d) => resolve(String(d))),
    );
    const reply = client.send('Browser.getVersion');
    expect(JSON.parse((await written).replace(/\0$/, ''))).toMatchObject({
      method: 'Browser.getVersion',
    });
    fromBrowser.write(`${JSON.stringify({ id: 1, result: { product: 'Chrome/1' } })}\0`);
    await expect(reply).resolves.toEqual({ product: 'Chrome/1' });
  });

  it('resolves exited with the exit code', async () => {
    const { child } = fakeChild();
    const { exited } = launchBrowser({ exe: 'chrome', profileDir: '/tmp/p' });
    child.emit('exit', 7);
    await expect(exited).resolves.toBe(7);
  });

  it('resolves exited with null when the executable cannot start', async () => {
    const { child } = fakeChild();
    const { exited } = launchBrowser({ exe: 'nope', profileDir: '/tmp/p' });
    child.emit('error', new Error('ENOENT'));
    await expect(exited).resolves.toBeNull();
  });

  it('kills the whole process tree, not just the browser', () => {
    const { child } = fakeChild();
    launchBrowser({ exe: 'chrome', profileDir: '/tmp/p' }).kill();
    expect(killTree).toHaveBeenCalledWith(child);
  });
});
