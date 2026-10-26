import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type DefaultBrowser =
  | { kind: 'chromium'; name: string; exe: string }
  | { kind: 'unsupported'; name: string }
  | { kind: 'unknown' };

export interface DetectDeps {
  platform?: string;
  /** Runs a program without a shell and returns its stdout. */
  exec?: (file: string, args: string[]) => Promise<string>;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => Promise<string>;
}

const run = promisify(execFile);

const WINDOWS_PROGIDS: [RegExp, string][] = [
  [/^ChromeHTML/, 'Chrome'],
  [/^MSEdgeHTM/, 'Edge'],
  [/^BraveHTML/, 'Brave'],
  [/^VivaldiHTM/, 'Vivaldi'],
  [/^OperaStable/, 'Opera'],
  [/^ChromiumHTM/, 'Chromium'],
];

const MAC_BUNDLES: Record<string, { name: string; app: string; bin: string }> = {
  'com.google.chrome': { name: 'Chrome', app: 'Google Chrome', bin: 'Google Chrome' },
  'com.microsoft.edgemac': { name: 'Edge', app: 'Microsoft Edge', bin: 'Microsoft Edge' },
  'com.brave.browser': { name: 'Brave', app: 'Brave Browser', bin: 'Brave Browser' },
  'com.vivaldi.vivaldi': { name: 'Vivaldi', app: 'Vivaldi', bin: 'Vivaldi' },
  'com.operasoftware.opera': { name: 'Opera', app: 'Opera', bin: 'Opera' },
  'org.chromium.chromium': { name: 'Chromium', app: 'Chromium', bin: 'Chromium' },
  'company.thebrowser.browser': { name: 'Arc', app: 'Arc', bin: 'Arc' },
};

const MAC_NAMES: Record<string, string> = { 'com.apple.safari': 'Safari' };

const LINUX_EXES: [RegExp, string][] = [
  [/^google-chrome/, 'Chrome'],
  [/^chromium/, 'Chromium'],
  [/^microsoft-edge/, 'Edge'],
  [/^brave/, 'Brave'],
  [/^vivaldi/, 'Vivaldi'],
  [/^opera/, 'Opera'],
];

/** The value of the first REG_SZ or REG_EXPAND_SZ line in `reg query` output. */
export function parseRegistryValue(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((l) => /\sREG_(SZ|EXPAND_SZ)\s/.test(l));
  return line?.replace(/^\s*.+?\s+REG_\w+\s+/, '').trim();
}

/** The bundle id of the `https` handler in `defaults read ... LSHandlers` output. */
export function parseLaunchServicesHandlers(output: string): string | undefined {
  for (const block of output.split(/\}\s*,?/)) {
    if (!/LSHandlerURLScheme\s*=\s*"?https"?\s*;/.test(block)) continue;
    const roles = [...block.matchAll(/LSHandlerRoleAll\s*=\s*"?([^";\s]+)"?\s*;/g)];
    const id = roles.map((m) => m[1]).find((v) => v !== undefined && v !== '-');
    if (id) return id;
  }
  return undefined;
}

/** The executable of the first `Exec=` line of a `.desktop` file. */
export function parseDesktopExec(entry: string): string | undefined {
  const line = entry.split(/\r?\n/).find((l) => l.startsWith('Exec='));
  if (!line) return undefined;
  const command = line.slice('Exec='.length).trim();
  const tokens: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) tokens.push(m[1] ?? m[2] ?? '');
  let i = 0;
  if (tokens[i] === 'env') {
    i++;
    while (tokens[i]?.includes('=')) i++;
  }
  return tokens[i] || undefined;
}

async function windows(
  deps: Required<Pick<DetectDeps, 'exec' | 'exists'>>,
): Promise<DefaultBrowser> {
  try {
    const progId = parseRegistryValue(
      await deps.exec('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
        '/v',
        'ProgId',
      ]),
    );
    if (!progId) return { kind: 'unknown' };
    const known = WINDOWS_PROGIDS.find(([re]) => re.test(progId));
    if (!known)
      return { kind: 'unsupported', name: progId.startsWith('Firefox') ? 'Firefox' : progId };
    const command = parseRegistryValue(
      await deps.exec('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']),
    );
    const exe = command?.match(/^"([^"]+)"/)?.[1] ?? command?.split(' ')[0];
    if (!exe || !deps.exists(exe)) return { kind: 'unknown' };
    return { kind: 'chromium', name: known[1], exe };
  } catch {
    return { kind: 'unknown' };
  }
}

async function mac(deps: Required<Pick<DetectDeps, 'exec' | 'exists'>>): Promise<DefaultBrowser> {
  try {
    const out = await deps.exec('defaults', [
      'read',
      'com.apple.LaunchServices/com.apple.launchservices.secure',
      'LSHandlers',
    ]);
    const bundle = parseLaunchServicesHandlers(out)?.toLowerCase();
    if (!bundle) return { kind: 'unknown' };
    const known = MAC_BUNDLES[bundle];
    if (!known) return { kind: 'unsupported', name: MAC_NAMES[bundle] ?? bundle };
    const rel = `${known.app}.app/Contents/MacOS/${known.bin}`;
    const exe = [`/Applications/${rel}`, join(homedir(), 'Applications', rel)].find(deps.exists);
    return exe ? { kind: 'chromium', name: known.name, exe } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

async function linux(
  deps: Required<Pick<DetectDeps, 'exec' | 'exists' | 'readFile'>>,
): Promise<DefaultBrowser> {
  try {
    const desktop = (await deps.exec('xdg-settings', ['get', 'default-web-browser'])).trim();
    if (!desktop) return { kind: 'unknown' };
    const dirs = [
      join(homedir(), '.local/share/applications'),
      '/usr/local/share/applications',
      '/usr/share/applications',
    ];
    let entry: string | undefined;
    for (const dir of dirs) {
      try {
        entry = await deps.readFile(join(dir, desktop));
        break;
      } catch {
        // Try the next applications directory.
      }
    }
    const exe = entry && parseDesktopExec(entry);
    if (!exe) return { kind: 'unknown' };
    const base = exe.split('/').pop() ?? exe;
    const known = LINUX_EXES.find(([re]) => re.test(base));
    if (!known) return { kind: 'unsupported', name: base };
    return { kind: 'chromium', name: known[1], exe };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Resolves the user's default `https` handler to an executable and says whether it is Chromium.
 * Never launches anything: opening a URL through the OS would hand it to a running instance that
 * ignores debugging flags.
 */
export async function detectDefaultBrowser(deps: DetectDeps = {}): Promise<DefaultBrowser> {
  const platform = deps.platform ?? process.platform;
  const exec =
    deps.exec ?? (async (file, args) => (await run(file, args, { windowsHide: true })).stdout);
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  if (platform === 'win32') return windows({ exec, exists });
  if (platform === 'darwin') return mac({ exec, exists });
  return linux({ exec, exists, readFile: read });
}
