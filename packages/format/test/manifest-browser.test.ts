import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { recordingToCapture } from '@pacesjs/engine';
import type { BrowserRecordingInput, RawCapture } from '@pacesjs/engine';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  FormatVersionError,
  readManifest,
  readSession,
  writeSession,
} from '../src/index.js';

interface Fixture {
  input: BrowserRecordingInput;
  screenshotJpegs: Array<{ id: number; base64: string }>;
}

function fixture(name: string): Fixture {
  const url = new URL(
    `../../engine/test/fixtures/browser/${name}.browser.json.gz`,
    import.meta.url,
  );
  return JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as Fixture;
}

function browserCapture(name = 'slow-click'): { capture: RawCapture; fixture: Fixture } {
  const f = fixture(name);
  return { capture: recordingToCapture(f.input), fixture: f };
}

const frames = (f: Fixture) =>
  f.screenshotJpegs.map((s) => ({
    id: s.id,
    bytes: Uint8Array.from(Buffer.from(s.base64, 'base64')),
  }));

describe('format 1.1: browser sessions', () => {
  it('is format 1.1.0', () => {
    expect(FORMAT_VERSION).toBe('1.1.0');
  });

  it('writes a manifest that says it is a browser session, with what was recorded', () => {
    const { capture, fixture: f } = browserCapture();
    const manifest = readManifest(
      writeSession(capture, {
        engineVersion: 'x',
        screenshots: { frames: frames(f), deduplicated: 4, cap: 600 },
      }),
    );
    expect(manifest.formatVersion).toBe('1.1.0');
    expect(manifest.kind).toBe('browser');
    expect(manifest.browser?.product).toMatch(/^Edg\/|^Chrome\//);
    expect(manifest.clock?.anchored).toBe(true);
    expect(manifest.segments).toHaveLength(1);
    expect(manifest.traceFilter?.version).toBe(1);
    expect(manifest.screenshots).toMatchObject({
      count: f.screenshotJpegs.length,
      deduplicated: 4,
      cap: 600,
    });
    expect(manifest.endedBy).toBe('duration');
  });

  it('records throttling and a cold cache when they were used', () => {
    const f = fixture('slow-click');
    const capture = recordingToCapture({ ...f.input, throttle: 4, cacheCold: true });
    const manifest = readManifest(writeSession(capture, { engineVersion: 'x' }));
    expect(manifest.throttle).toEqual({ cpu: 4 });
    expect(manifest.browser?.cacheCold).toBe(true);
  });

  it('round-trips a browser capture: tracks, timeline, page events, marks and clock', () => {
    const { capture } = browserCapture('worker-and-iframe');
    const back = readSession(writeSession(capture, { engineVersion: 'x' })).capture;
    expect(back.browser).toEqual(capture.browser);
    expect(back.tracks.map((t) => t.timeline)).toEqual(capture.tracks.map((t) => t.timeline));
    expect(back.tracks.map((t) => t.info)).toEqual(capture.tracks.map((t) => t.info));
    expect(back.meta.marks).toEqual(capture.meta.marks);
  });

  it('keeps the kind of every mark, so older readers can still show the manual ones', () => {
    const { capture } = browserCapture();
    const marks = readManifest(writeSession(capture, { engineVersion: 'x' })).marks ?? [];
    expect(marks.every((m) => typeof m.kind === 'string')).toBe(true);
  });

  it('stores screenshots as separate files, not deflated, with an index', () => {
    const { capture } = browserCapture();
    const bytes = new Uint8Array(4000);
    const zip = writeSession(capture, {
      engineVersion: 'x',
      screenshots: { frames: [{ id: 0, bytes }], deduplicated: 0, cap: 600 },
    });
    const files = unzipSync(zip);
    expect(files['raw/screenshots/0.jpg']?.length).toBe(4000);
    expect(JSON.parse(strFromU8(files['raw/screenshots.json'] ?? new Uint8Array()))).toEqual(
      capture.browser?.screenshots,
    );
    // 4000 zero bytes deflate to a few dozen: the zip is only that large if the file was stored.
    expect(zip.length).toBeGreaterThan(4000);
  });

  it('reads the screenshots back by id', () => {
    const { capture, fixture: f } = browserCapture();
    const session = readSession(
      writeSession(capture, {
        engineVersion: 'x',
        screenshots: { frames: frames(f), deduplicated: 0, cap: 600 },
      }),
    );
    const first = f.screenshotJpegs[0];
    expect(session.screenshots.get(first?.id ?? -1)).toEqual(
      Uint8Array.from(Buffer.from(first?.base64 ?? '', 'base64')),
    );
  });

  it('embeds page sources by content hash under their virtual path', () => {
    const { capture, fixture: f } = browserCapture();
    const sources = (f.input as unknown as { sources: Array<{ url: string; text: string }> })
      .sources;
    const session = readSession(
      writeSession(capture, {
        engineVersion: 'x',
        sources: sources.map((s) => ({ path: s.url, content: strToU8(s.text) })),
      }),
    );
    const entry = session.manifest.sources.find((s) => s.path.endsWith('/slow-click.html'));
    expect(strFromU8(session.sources[entry?.hash ?? ''] ?? new Uint8Array())).toContain(
      'busy(220)',
    );
  });

  it('writes no browser entries for a Node capture', () => {
    const manifest = readManifest(
      writeSession(
        { ...browserCapture().capture, browser: undefined, tracks: [] },
        { engineVersion: 'x' },
      ),
    );
    expect(manifest.kind).toBeUndefined();
    expect(manifest.clock).toBeUndefined();
  });
});

describe('format 1.1: compatibility', () => {
  const rewrite = (zip: Uint8Array, version: string): Uint8Array => {
    const files = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    files['manifest.json'] = strToU8(JSON.stringify({ ...manifest, formatVersion: version }));
    return zipSync(files);
  };

  it('keeps every file a 1.0 reader needs, so it opens a browser session as CPU-only', () => {
    const { capture } = browserCapture();
    const files = unzipSync(writeSession(capture, { engineVersion: 'x' }));
    const id = capture.tracks[0]?.info.id;
    for (const name of [
      'manifest.json',
      `raw/${id}.cpuprofile`,
      `raw/${id}.scripts`,
      `raw/${id}.events`,
      'raw/sourcemaps.json',
    ]) {
      expect(files[name], name).toBeDefined();
    }
  });

  it('opens a session written as 1.0, without a browser', () => {
    const { capture } = browserCapture();
    const old = rewrite(
      writeSession({ ...capture, browser: undefined }, { engineVersion: 'x' }),
      '1.0.0',
    );
    const session = readSession(old);
    expect(session.capture.browser).toBeUndefined();
    expect(session.capture.tracks.length).toBeGreaterThan(0);
  });

  it('accepts any later minor of the same major', () => {
    const { capture } = browserCapture();
    expect(() =>
      readManifest(rewrite(writeSession(capture, { engineVersion: 'x' }), '1.9.0')),
    ).not.toThrow();
  });

  it('refuses a newer major with a message that says to upgrade', () => {
    const { capture } = browserCapture();
    const future = rewrite(writeSession(capture, { engineVersion: 'x' }), '2.0.0');
    expect(() => readManifest(future)).toThrow(FormatVersionError);
    expect(() => readManifest(future)).toThrow(/upgrade/i);
  });
});
