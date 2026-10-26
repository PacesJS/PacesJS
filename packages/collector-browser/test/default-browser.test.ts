import { describe, expect, it } from 'vitest';
import {
  detectDefaultBrowser,
  parseDesktopExec,
  parseLaunchServicesHandlers,
  parseRegistryValue,
} from '../src/default-browser.js';

const EDGE_COMMAND =
  '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1';

const regOutput = (name: string, type: string, value: string): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\Example\r\n    ${name}    ${type}    ${value}\r\n\r\n`;

describe('parseRegistryValue', () => {
  it('reads the value of a named REG_SZ entry', () => {
    expect(parseRegistryValue(regOutput('ProgId', 'REG_SZ', 'MSEdgeHTM'))).toBe('MSEdgeHTM');
  });

  it('reads the default value, which reg prints as (Default)', () => {
    expect(parseRegistryValue(regOutput('(Default)', 'REG_SZ', EDGE_COMMAND))).toBe(EDGE_COMMAND);
  });

  it('reads REG_EXPAND_SZ values', () => {
    expect(parseRegistryValue(regOutput('(Default)', 'REG_EXPAND_SZ', '%windir%\\x.exe'))).toBe(
      '%windir%\\x.exe',
    );
  });

  it('returns undefined when no value line is present', () => {
    expect(
      parseRegistryValue('ERROR: The system was unable to find the specified registry key'),
    ).toBe(undefined);
  });
});

describe('parseLaunchServicesHandlers', () => {
  const plist = `(
        {
        LSHandlerContentType = "public.html";
        LSHandlerRoleAll = "com.apple.safari";
    },
        {
        LSHandlerPreferredVersions = {
            LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "com.google.chrome";
        LSHandlerURLScheme = https;
    }
)`;

  it('returns the bundle id registered for the https scheme', () => {
    expect(parseLaunchServicesHandlers(plist)).toBe('com.google.chrome');
  });

  it('returns undefined when no https handler is registered', () => {
    expect(parseLaunchServicesHandlers('(\n)')).toBe(undefined);
  });
});

describe('parseDesktopExec', () => {
  it('returns the executable from the first Exec line', () => {
    const entry = '[Desktop Entry]\nName=Chrome\nExec=/usr/bin/google-chrome-stable %U\nIcon=x\n';
    expect(parseDesktopExec(entry)).toBe('/usr/bin/google-chrome-stable');
  });

  it('keeps a quoted executable path with spaces whole', () => {
    expect(parseDesktopExec('Exec="/opt/my browser/browser" %U')).toBe('/opt/my browser/browser');
  });

  it('skips an env wrapper', () => {
    expect(parseDesktopExec('Exec=env BAMF_DESKTOP_FILE_HINT=x /usr/bin/brave-browser %U')).toBe(
      '/usr/bin/brave-browser',
    );
  });
});

describe('detectDefaultBrowser on Windows', () => {
  const win = (progId: string, command: string) => ({
    platform: 'win32',
    exists: () => true,
    exec: (_file: string, args: string[]) =>
      Promise.resolve(
        args.some((a) => a.includes('UserChoice'))
          ? regOutput('ProgId', 'REG_SZ', progId)
          : regOutput('(Default)', 'REG_SZ', command),
      ),
  });

  it.each([
    ['ChromeHTML', 'Chrome'],
    ['MSEdgeHTM', 'Edge'],
    ['BraveHTML', 'Brave'],
    ['VivaldiHTM.ABC123', 'Vivaldi'],
    ['OperaStable', 'Opera'],
    ['ChromiumHTM.XYZ', 'Chromium'],
  ])('accepts the Chromium ProgId %s', async (progId, name) => {
    const found = await detectDefaultBrowser(win(progId, EDGE_COMMAND));
    expect(found).toMatchObject({ kind: 'chromium', name });
  });

  it('extracts the quoted executable from the open command', async () => {
    const found = await detectDefaultBrowser(win('MSEdgeHTM', EDGE_COMMAND));
    expect(found).toMatchObject({
      kind: 'chromium',
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    });
  });

  it('refuses Firefox', async () => {
    const found = await detectDefaultBrowser(win('FirefoxURL-308046B0AF4A39CB', '"C:\\ff.exe" %1'));
    expect(found).toEqual({ kind: 'unsupported', name: 'Firefox' });
  });

  it('reports unknown when the registry has no https choice', async () => {
    const found = await detectDefaultBrowser({
      platform: 'win32',
      exists: () => true,
      exec: () => Promise.reject(new Error('not found')),
    });
    expect(found).toEqual({ kind: 'unknown' });
  });

  it('reports unknown when the resolved executable does not exist', async () => {
    const found = await detectDefaultBrowser({
      ...win('MSEdgeHTM', EDGE_COMMAND),
      exists: () => false,
    });
    expect(found).toEqual({ kind: 'unknown' });
  });
});

describe('detectDefaultBrowser on macOS', () => {
  const mac = (bundle: string) => ({
    platform: 'darwin',
    exists: () => true,
    exec: () =>
      Promise.resolve(`( { LSHandlerRoleAll = "${bundle}"; LSHandlerURLScheme = https; } )`),
  });

  it('matches the bundle id case-insensitively and resolves the app executable', async () => {
    const found = await detectDefaultBrowser(mac('com.brave.browser'));
    expect(found).toEqual({
      kind: 'chromium',
      name: 'Brave',
      exe: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    });
  });

  it('refuses Safari', async () => {
    expect(await detectDefaultBrowser(mac('com.apple.safari'))).toEqual({
      kind: 'unsupported',
      name: 'Safari',
    });
  });
});

describe('detectDefaultBrowser on Linux', () => {
  const linux = (desktop: string, entry: string) => ({
    platform: 'linux',
    exists: () => true,
    readFile: () => Promise.resolve(entry),
    exec: () => Promise.resolve(desktop + '\n'),
  });

  it('matches the Exec executable against the Chromium allowlist', async () => {
    const found = await detectDefaultBrowser(
      linux('microsoft-edge.desktop', 'Exec=/usr/bin/microsoft-edge-stable %U'),
    );
    expect(found).toEqual({
      kind: 'chromium',
      name: 'Edge',
      exe: '/usr/bin/microsoft-edge-stable',
    });
  });

  it('refuses Firefox', async () => {
    const found = await detectDefaultBrowser(linux('firefox.desktop', 'Exec=/usr/bin/firefox %u'));
    expect(found).toEqual({ kind: 'unsupported', name: 'firefox' });
  });
});
