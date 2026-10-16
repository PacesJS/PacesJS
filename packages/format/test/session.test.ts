import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '@pacesjs/engine';
import {
  FORMAT_VERSION,
  FormatVersionError,
  captureToFiles,
  contentHash,
  filesToCapture,
  loadModel,
  readSession,
  writeSession,
} from '../src/index.js';
import type { EngineApi } from '../src/index.js';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

function fixture(name: string): RawCapture {
  const url = new URL(`../../engine/test/fixtures/${name}.capture.json.gz`, import.meta.url);
  return JSON.parse(strFromU8(gunzipSync(readFileSync(url)))) as RawCapture;
}

describe('capture <-> files', () => {
  it('round-trips a real multi-track capture byte-for-byte in meaning', () => {
    const capture = fixture('worker-imbalance');
    const back = filesToCapture(captureToFiles(capture).files, captureToFiles(capture).manifest);
    expect(back).toEqual(capture);
  });

  it('writes one cpuprofile, scripts and events file per track', () => {
    const capture = fixture('worker-imbalance');
    const { files } = captureToFiles(capture);
    const id = capture.tracks[0]?.info.id;
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([`raw/${id}.cpuprofile`, `raw/${id}.scripts`, `raw/${id}.events`]),
    );
  });
});

describe('writeSession / readSession', () => {
  const engineVersion = '1.2.3';

  it('round-trips the capture and records the manifest fields', () => {
    const capture = fixture('hot-regex');
    const bytes = writeSession(capture, { engineVersion });
    const session = readSession(bytes);
    expect(session.capture).toEqual(capture);
    expect(session.manifest).toMatchObject({
      formatVersion: FORMAT_VERSION,
      engineVersion,
      command: capture.meta.command,
      cwd: capture.meta.cwd,
      nodeVersion: capture.meta.nodeVersion,
      platform: capture.meta.platform,
      mode: capture.meta.mode,
      intervalUs: capture.meta.intervalUs,
      startedAt: capture.meta.startedAt,
      endedAt: capture.meta.endedAt,
    });
    expect(session.manifest.tracks.map((t) => t.id)).toEqual(capture.tracks.map((t) => t.info.id));
  });

  it('keeps the model cache only for the engine version that wrote it', () => {
    const capture = fixture('hot-regex');
    const bytes = writeSession(capture, { engineVersion, model: new Uint8Array([1, 2, 3]) });
    expect(readSession(bytes, { engineVersion }).model).toEqual(new Uint8Array([1, 2, 3]));
    expect(readSession(bytes, { engineVersion: '9.9.9' }).model).toBeUndefined();
  });

  it('embeds sources by content hash when asked', () => {
    const capture = fixture('hot-regex');
    const text = 'export const a = 1;\n';
    const bytes = writeSession(capture, {
      engineVersion,
      sources: [{ path: 'src/a.ts', content: strToU8(text) }],
    });
    const session = readSession(bytes);
    const hash = contentHash(strToU8(text));
    expect(session.manifest.sources).toEqual([{ path: 'src/a.ts', hash }]);
    expect(strFromU8(session.sources[hash] ?? new Uint8Array())).toBe(text);
  });

  it('produces identical bytes for identical input', () => {
    const capture = fixture('hot-regex');
    expect(writeSession(capture, { engineVersion })).toEqual(
      writeSession(capture, { engineVersion }),
    );
  });

  it('refuses a file that is not a zip with an actionable message', () => {
    expect(() => readSession(strToU8('nope'))).toThrow(/not a .paces session/);
  });

  it('refuses a zip with no manifest', () => {
    const bytes = zipSync({ 'x.txt': strToU8('x') });
    expect(() => readSession(bytes)).toThrow(/manifest/);
  });
});

describe('format version policy', () => {
  function withVersion(version: string): Uint8Array {
    const bytes = writeSession(fixture('hot-regex'), { engineVersion: '1.0.0' });
    const files = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array()));
    manifest.formatVersion = version;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    return zipSync(files);
  }
  const major = Number(FORMAT_VERSION.split('.')[0]);

  it('accepts a newer minor of the same major', () => {
    expect(() => readSession(withVersion(`${major}.7.0`))).not.toThrow();
  });

  it('refuses a newer major and says to upgrade paces', () => {
    const attempt = () => readSession(withVersion(`${major + 1}.0.0`));
    expect(attempt).toThrow(FormatVersionError);
    expect(attempt).toThrow(/upgrade paces/);
  });

  it('refuses an older, unsupported major', () => {
    expect(() => readSession(withVersion('0.9.0'))).toThrow(FormatVersionError);
  });

  it('refuses a malformed version', () => {
    expect(() => readSession(withVersion('banana'))).toThrow(FormatVersionError);
  });
});

describe('loadModel', () => {
  const capture = fixture('hot-regex');
  const model = { tag: 'model' } as never;
  function engine(calls: string[]): EngineApi {
    return {
      engineVersion: '1.0.0',
      analyze: () => {
        calls.push('analyze');
        return model;
      },
      deserializeModel: () => {
        calls.push('deserialize');
        return model;
      },
      serializeModel: () => new Uint8Array([7]),
    };
  }

  it('deserializes the cache on a hit without analyzing', () => {
    const calls: string[] = [];
    const bytes = writeSession(capture, { engineVersion: '1.0.0', model: new Uint8Array([7]) });
    const result = loadModel(readSession(bytes, { engineVersion: '1.0.0' }), engine(calls));
    expect(calls).toEqual(['deserialize']);
    expect(result.fromCache).toBe(true);
  });

  it('rebuilds with analyze when there is no cache', () => {
    const calls: string[] = [];
    const bytes = writeSession(capture, { engineVersion: '1.0.0' });
    const result = loadModel(readSession(bytes, { engineVersion: '1.0.0' }), engine(calls));
    expect(calls).toEqual(['analyze']);
    expect(result.fromCache).toBe(false);
    expect(result.modelBytes).toEqual(new Uint8Array([7]));
  });

  it('rebuilds when the cache came from another engine version', () => {
    const calls: string[] = [];
    const bytes = writeSession(capture, { engineVersion: '0.5.0', model: new Uint8Array([7]) });
    loadModel(readSession(bytes, { engineVersion: '1.0.0' }), engine(calls));
    expect(calls).toEqual(['analyze']);
  });

  it('rebuilds when the cached bytes cannot be deserialized', () => {
    const calls: string[] = [];
    const e = engine(calls);
    e.deserializeModel = () => {
      throw new Error('corrupt');
    };
    const bytes = writeSession(capture, { engineVersion: '1.0.0', model: new Uint8Array([7]) });
    const result = loadModel(readSession(bytes, { engineVersion: '1.0.0' }), e);
    expect(calls).toEqual(['analyze']);
    expect(result.fromCache).toBe(false);
  });
});
