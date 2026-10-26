import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Ends a process and everything it started. On Windows `child.kill()` only ends the root. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else child.kill('SIGKILL');
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
