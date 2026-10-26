import { describe, expect, it } from 'vitest';
import { isOutsideProject, isWebScript, sourceReason } from '../../src/view/source-reason';
import type { SourceFacts } from '../../src/view/source-reason';

const ok: SourceFacts = {
  path: 'src/a.ts',
  exists: true,
  error: null,
  mapMissing: false,
  lineCount: 3,
};

describe('why the source is unavailable', () => {
  it('has nothing to say when the file is readable and has line time', () => {
    expect(sourceReason(ok)).toBeNull();
  });

  it('explains a function without a file as native or runtime code', () => {
    const r = sourceReason({ ...ok, path: '' });
    expect(r?.kind).toBe('no-file');
    expect(r?.hint).toMatch(/native or runtime/);
  });

  it('says the file is not on disk and names it', () => {
    const r = sourceReason({ ...ok, exists: false });
    expect(r?.kind).toBe('not-on-disk');
    expect(r?.hint).toContain('src/a.ts');
    expect(r?.showsText).toBe(false);
  });

  it.each(['../x/a.ts', '/etc/a.js', 'C:\\x\\a.js', 'node:fs', 'file:///x/a.js'])(
    'treats %s as outside the project root',
    (path) => {
      expect(isOutsideProject(path)).toBe(true);
      expect(sourceReason({ ...ok, path })?.kind).toBe('outside-root');
    },
  );

  it('does not treat a project-relative path as outside', () => {
    expect(isOutsideProject('zoo/orders-server/src/a.ts')).toBe(false);
  });

  it('relays a host refusal with the project-root hint', () => {
    const r = sourceReason({
      ...ok,
      exists: undefined,
      error: 'paces host: reading source failed with HTTP 403',
    });
    expect(r?.kind).toBe('outside-root');
    expect(r?.hint).toContain('HTTP 403');
  });

  it('keeps showing the code when the source map is missing, with the fix', () => {
    const r = sourceReason({ ...ok, mapMissing: true });
    expect(r).toMatchObject({ kind: 'map-missing', showsText: true });
    expect(r?.hint).toMatch(/--sourcemap/);
  });

  it('says a function with no line time ran only briefly and its time is in its callees', () => {
    const r = sourceReason({ ...ok, lineCount: 0, selfUs: 1_200, hasCallees: true });
    expect(r).toMatchObject({ kind: 'no-self-time', showsText: true });
    expect(r?.hint).toContain('ran only');
    expect(r?.hint).toContain('its time is in its callees');
  });

  it('gives the real reason when there is no line data and nothing it called', () => {
    const r = sourceReason({ ...ok, lineCount: 0, selfUs: 0, hasCallees: false });
    expect(r).toMatchObject({ kind: 'no-line-data', showsText: true });
    expect(r?.hint).toMatch(/line ticks/);
  });

  it('says the host is gone, not that it refused the file, when the connection was lost', () => {
    const r = sourceReason({ ...ok, error: 'Lost connection to the paces host', hostDown: true });
    expect(r?.kind).toBe('host-down');
    expect(r?.title).toMatch(/connection|stopped/i);
    expect(r?.hint).toMatch(/paces open/);
    expect(r?.hint).not.toMatch(/project root/);
  });

  describe('a script a page loaded', () => {
    const page = { ...ok, path: 'https://app.test/main.js' };

    it.each(['https://app.test/a.js', 'http://127.0.0.1:3000/a.js', 'chrome-extension://abc/x.js'])(
      'recognizes %s as a web script, not a file',
      (path) => {
        expect(isWebScript(path)).toBe(true);
      },
    );

    it('does not call a file path or a file URL a web script', () => {
      expect(isWebScript('src/a.ts')).toBe(false);
      expect(isWebScript('file:///x/a.js')).toBe(false);
    });

    it('shows the code when the session kept it, instead of calling it outside the project', () => {
      expect(sourceReason(page)).toBeNull();
    });

    it('says the script was not saved, rather than that it is missing from disk', () => {
      const r = sourceReason({ ...page, exists: false });
      expect(r?.kind).toBe('not-saved');
      expect(r?.showsText).toBe(false);
      expect(r?.hint).toMatch(/not saved with the session/);
      expect(r?.hint).not.toMatch(/disk/);
    });
  });
});
