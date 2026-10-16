import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** User config directory; `PACES_CONFIG_DIR` overrides it (tests, portable setups). */
export function configDir(env: Env = process.env, platform: string = process.platform): string {
  if (env.PACES_CONFIG_DIR) return env.PACES_CONFIG_DIR;
  if (platform === 'win32')
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'paces');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'paces');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'paces');
}

export type Settings = Record<string, unknown>;

export function readSettings(dir: string): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Settings)
      : {};
  } catch {
    return {};
  }
}

export function writeSettings(dir: string, settings: Settings): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}
