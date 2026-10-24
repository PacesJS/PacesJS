import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { ENGINE_VERSION } from '../src/config.js';
import {
  deserializeModel,
  ModelVersionError,
  readModelEngineVersion,
  serializeModel,
} from '../src/serialize.js';
import { FIXTURES, loadCapture, loadModel } from './helpers/fixtures.js';

describe('model serialization', () => {
  it.each(FIXTURES)('round-trips the %s model exactly', (name) => {
    const model = loadModel(name);
    const back = deserializeModel(serializeModel(model));
    expect(back).toEqual(model);
  });

  it('keeps typed arrays typed and preserves sharing between tables', () => {
    const model = loadModel('orders-server');
    const back = deserializeModel(serializeModel(model));
    const track = back.tracks[0];
    expect(track?.samples.time).toBeInstanceOf(Float64Array);
    expect(track?.callTree.parent).toBeInstanceOf(Int32Array);
    expect(track?.callTree.parent).toBe(back.tracks[0]?.callTree.parent);
    expect(back.functions.origin).toBeInstanceOf(Uint8Array);
  });

  it('reads a model from a misaligned slice of a larger buffer', () => {
    const model = loadModel('sync-io');
    const bytes = serializeModel(model);
    const padded = new Uint8Array(bytes.length + 5);
    padded.set(bytes, 3);
    expect(deserializeModel(padded.subarray(3, 3 + bytes.length))).toEqual(model);
  });

  it('stamps the engine version and refuses a model from another engine', () => {
    const bytes = serializeModel(loadModel('sync-io'));
    expect(readModelEngineVersion(bytes)).toBe(ENGINE_VERSION);
    const text = new TextDecoder().decode(bytes.subarray(12, 400));
    const stamped = new TextEncoder().encode(
      text.replace(`"engineVersion":"${ENGINE_VERSION}"`, '"engineVersion":"9.9.9"'),
    );
    const tampered = bytes.slice();
    tampered.set(stamped, 12);
    expect(() => deserializeModel(tampered)).toThrow(ModelVersionError);
    expect(() => deserializeModel(tampered)).toThrow(/Re-analyze the raw capture/);
  });

  it('rejects data that is not a model with a clear message', () => {
    expect(() => deserializeModel(new Uint8Array([1, 2, 3]))).toThrow(/Not a paces model/);
  });

  it('stores a sampled profile in well under 100 bytes per sample', () => {
    const model = loadModel('orders-server');
    const samples = model.tracks.reduce((n, t) => n + t.samples.length, 0);
    expect(serializeModel(model).length / samples).toBeLessThan(100);
  });
});

describe('marks in the model', () => {
  it('keeps the capture marks in the model meta and through serialization', () => {
    const capture = loadCapture('hot-regex');
    const marks = [
      { at: capture.meta.startedAt + 120, label: 'Mark 1' },
      { at: capture.meta.startedAt + 340, label: 'Mark 2' },
    ];
    const model = analyze({ ...capture, meta: { ...capture.meta, marks } });
    expect(model.meta.marks).toEqual(marks);
    expect(deserializeModel(serializeModel(model)).meta.marks).toEqual(marks);
  });
});
