import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { ModelVersionError, deserializeModel, serializeModel } from '../src/serialize.js';
import type { RawCapture } from '../src/raw.js';

function fixture(name: string): RawCapture {
  const file = new URL(`./fixtures/${name}.capture.json.gz`, import.meta.url);
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RawCapture;
}

describe('a cached model whose shape differs from this engine is rejected', () => {
  it('round-trips a model written by this engine', () => {
    const model = analyze(fixture('orders-server'));
    expect(deserializeModel(serializeModel(model)).tracks).toHaveLength(model.tracks.length);
  });

  it('rejects a model missing a column that current views read (stale cache, same version)', () => {
    const model = analyze(fixture('orders-server'));
    // What a model cached before the stitching columns existed looks like.
    delete (model.tracks[0]?.tasks as unknown as Record<string, unknown>)['parentSpan'];
    expect(() => deserializeModel(serializeModel(model))).toThrow(ModelVersionError);
  });

  it('accepts optional columns that only some models have (e.g. a child process track parent)', () => {
    const model = analyze(fixture('eslint-cli'));
    expect(deserializeModel(serializeModel(model)).tracks).toHaveLength(model.tracks.length);
  });

  it('tolerates extra columns it does not know: older views ignore them', () => {
    const model = analyze(fixture('orders-server'));
    (model.tracks[0] as unknown as Record<string, unknown>)['fromTheFuture'] = new Uint8Array(1);
    expect(() => deserializeModel(serializeModel(model))).not.toThrow();
  });
});
