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

  it('rejects a model with an extra column this engine does not know', () => {
    const model = analyze(fixture('orders-server'));
    (model.tracks[0] as unknown as Record<string, unknown>)['fromTheFuture'] = new Uint8Array(1);
    expect(() => deserializeModel(serializeModel(model))).toThrow(ModelVersionError);
  });
});
