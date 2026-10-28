import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Every descendant of `root`, found from one table of (pid, parent pid) so none is missed. */
function descendants(root: number): number[] {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (table.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of table.stdout.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || parent === undefined || Number.isNaN(pid + parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  for (let queue = [root]; queue.length > 0;) {
    queue = queue.flatMap((pid) => children.get(pid) ?? []);
    found.push(...queue);
  }
  return found;
}

/**
 * Ends a process and everything it started. `child.kill()` only ends the root, on every platform:
 * a browser's renderer and GPU processes would outlive it and keep its profile directory busy.
 */
export function killTree(child: ChildProcess, platform: string = process.platform): void {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // Listed before the root dies: once it does, its children are handed to init and lose the link.
  const below = descendants(child.pid);
  child.kill('SIGKILL');
  for (const pid of below) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Removes a directory in a separate process so the CLI can exit at once. The browser's helper
 * processes may hold files for a second or more after the window closes, and waiting on them is
 * what made `paces` linger.
 */
export function removeDetached(dir: string): void {
  const script =
    "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:300})";
  try {
    const child = spawn(process.execPath, ['-e', script, dir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => removeQuietly(dir));
    child.unref();
  } catch {
    removeQuietly(dir);
  }
}

/** Removes a directory a browser may still be releasing; never throws. */
export function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp profile is harmless; a crash on exit is not.
  }
}
