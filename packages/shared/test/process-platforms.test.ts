import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killTree, removeDetached, removeQuietly } from '../src/process.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', () => ({ rmSync: vi.fn() }));

const psTable = (rows: Array<[number, number]>) => ({
  status: 0,
  stdout: rows.map(([pid, ppid]) => `  ${pid} ${ppid}`).join('\n') + '\n',
});

function fakeChild(pid: number | undefined): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return { pid, kill: vi.fn() } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(spawn).mockReset();
  vi.mocked(rmSync).mockReset();
});

describe('killTree on Windows', () => {
  it('asks taskkill to end the whole tree and leaves the child to it', () => {
    const child = fakeChild(42);
    killTree(child, 'win32');
    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/pid', '42', '/T', '/F'], {
      stdio: 'ignore',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('killTree on POSIX', () => {
  it('does nothing for a child that never started', () => {
    killTree(fakeChild(undefined), 'linux');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('lists every descendant before the root dies, then ends the root and each of them', () => {
    vi.mocked(spawnSync).mockReturnValue(
      psTable([
        [10, 1],
        [11, 10],
        [12, 11],
        [13, 10],
        [99, 1],
      ]) as ReturnType<typeof spawnSync>,
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild(10);
    killTree(child, 'linux');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(kill.mock.calls.map(([pid]) => pid).sort()).toEqual([11, 12, 13]);
    expect(kill.mock.calls.every(([, signal]) => signal === 'SIGKILL')).toBe(true);
  });

  it('skips table rows it cannot read', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'PID PPID\n\n  11 10\ngarbage\n',
    } as ReturnType<typeof spawnSync>);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killTree(fakeChild(10), 'linux');
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([11]);
  });

  it('still ends the root when the process table cannot be read', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as ReturnType<typeof spawnSync>);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild(10);
    killTree(child, 'linux');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(kill).not.toHaveBeenCalled();
  });

  it('carries on when a descendant is already gone', () => {
    vi.mocked(spawnSync).mockReturnValue(
      psTable([
        [11, 10],
        [12, 10],
      ]) as ReturnType<typeof spawnSync>,
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 11) throw new Error('ESRCH');
      return true;
    });
    expect(() => killTree(fakeChild(10), 'linux')).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(2);
  });
});

describe('removeDetached', () => {
  it('starts a detached remover that the CLI does not wait for', () => {
    const child = { once: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    removeDetached('/tmp/profile');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('/tmp/profile');
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('removes the directory itself when the remover cannot start', () => {
    const child = { once: vi.fn(), unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    removeDetached('/tmp/profile');
    const onError = child.once.mock.calls.find(([event]) => event === 'error')?.[1] as () => void;
    onError();
    expect(rmSync).toHaveBeenCalledWith('/tmp/profile', expect.objectContaining({ force: true }));
  });

  it('removes the directory itself when spawning throws', () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('EAGAIN');
    });
    removeDetached('/tmp/profile');
    expect(rmSync).toHaveBeenCalledOnce();
  });
});

describe('removeQuietly', () => {
  it('swallows a failure to remove, since a leftover temp profile is harmless', () => {
    vi.mocked(rmSync).mockImplementation(() => {
      throw new Error('EBUSY');
    });
    expect(() => removeQuietly('/tmp/profile')).not.toThrow();
  });
});
