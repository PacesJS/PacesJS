import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { RawCapture } from '@pacesjs/engine';
import {
  collectSources,
  defaultSessionPath,
  findProjectRoot,
  timestampName,
} from '../src/session-files.js';

describe('timestampName', () => {
  it('has no characters Windows forbids in file names', () => {
    expect(timestampName(new Date(2026, 9, 16, 14, 22, 33))).toBe('20261016-142233');
  });
});

describe('defaultSessionPath', () => {
  it('puts the session in ./.paces with a timestamped name', () => {
    const p = defaultSessionPath('/work', new Date(2026, 0, 2, 3, 4, 5), () => false);
    expect(p.replaceAll('\\', '/')).toBe('/work/.paces/20260102-030405.paces');
  });

  it('adds a suffix instead of overwriting a session from the same second', () => {
    const taken = new Set(['/work/.paces/20260102-030405.paces'].map((s) => join(s)));
    const p = defaultSessionPath('/work', new Date(2026, 0, 2, 3, 4, 5), (f) => taken.has(f));
    expect(p.replaceAll('\\', '/')).toBe('/work/.paces/20260102-030405-2.paces');
  });
});

const base = realpathSync(mkdtempSync(join(tmpdir(), 'paces-src-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('findProjectRoot', () => {
  it('walks up to the nearest package.json', () => {
    mkdirSync(join(base, 'proj', 'a', 'b'), { recursive: true });
    writeFileSync(join(base, 'proj', 'package.json'), '{}');
    expect(findProjectRoot(join(base, 'proj', 'a', 'b'))).toBe(join(base, 'proj'));
  });
});

describe('collectSources', () => {
  it('embeds project files and source-map originals, never node_modules or outside files', () => {
    const root = join(base, 'app');
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'dist', 'main.js'), 'js');
    writeFileSync(join(root, 'dist', 'main.js.map'), '{}');
    writeFileSync(join(root, 'src', 'main.ts'), 'ts');
    writeFileSync(join(root, 'node_modules', 'dep', 'i.js'), 'dep');
    writeFileSync(join(base, 'outside.js'), 'out');
    const url = (p: string) => pathToFileURL(p).href;
    const capture = {
      meta: { projectRoot: root },
      tracks: [
        {
          scripts: [
            { url: url(join(root, 'dist', 'main.js')) },
            { url: url(join(root, 'node_modules', 'dep', 'i.js')) },
            { url: url(join(base, 'outside.js')) },
            { url: 'node:fs' },
          ],
        },
      ],
      sourceMaps: {
        [url(join(root, 'dist', 'main.js'))]: JSON.stringify({ sources: ['../src/main.ts'] }),
      },
    } as unknown as RawCapture;
    expect(collectSources(capture).map((s) => s.path)).toEqual([
      'dist/main.js',
      'dist/main.js.map',
      'src/main.ts',
    ]);
  });
});
