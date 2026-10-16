import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { getEmbeddedSource } from '../../src/query/embedded-source.js';
import { serializeModel } from '../../src/serialize.js';
import { loadCapture } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

describe('embedded source from source maps', () => {
  const model = loadModel('orders-server');
  const capture = loadCapture('orders-server');

  it('returns the original file content when the map embeds it', () => {
    const text = getEmbeddedSource(model, capture, 'zoo/orders-server/src/util/money.ts');
    expect(text).toContain('export function lineTotal(qty: number, unitCents: number): number {');
  });

  it('accepts a file string id from the model', () => {
    const id = model.strings.indexOf('zoo/orders-server/src/util/money.ts');
    expect(id).toBeGreaterThan(0);
    expect(getEmbeddedSource(model, capture, id)).toBe(
      getEmbeddedSource(model, capture, 'zoo/orders-server/src/util/money.ts'),
    );
  });

  it('serves the line the model reports for a function', () => {
    const text = getEmbeddedSource(model, capture, 'zoo/orders-server/src/util/money.ts') ?? '';
    expect(text.split('\n')[5]).toContain('export function lineTotal');
  });

  it('has nothing for generated files, plain files and unknown files', () => {
    expect(getEmbeddedSource(model, capture, 'zoo/orders-server/dist/server.js')).toBeUndefined();
    expect(getEmbeddedSource(model, capture, 'nowhere/a.ts')).toBeUndefined();
    expect(getEmbeddedSource(model, capture, 99_999_999)).toBeUndefined();
  });

  it('does not put any source text into the model', () => {
    const bytes = serializeModel(model);
    const needle = 'export function lineTotal';
    const haystack = new TextDecoder().decode(bytes);
    expect(haystack.includes(needle)).toBe(false);
  });
});

describe('embedded source from inline maps', () => {
  const url = 'file:///project/dist/a.js';
  const map = (content: string | null) =>
    JSON.stringify({
      version: 3,
      file: 'a.js',
      sources: ['../src/a.ts', '../src/b.ts'],
      sourcesContent: ['export const a = 1;\n', content],
      names: [],
      mappings: 'AAAA;ACAA',
    });
  const inline = (text: string) => `data:application/json;base64,${btoa(text)}`;
  const build = (text: string) => {
    const capture = synthCapture([{ stack: [{ name: 'a', url, line: 0, col: 0 }], samples: 3 }], {
      scripts: [{ scriptId: '1', url, sourceMapURL: inline(text), hash: 'h' }],
    });
    return { capture, model: analyze(capture) };
  };

  it('decodes data: URI maps', () => {
    const { capture, model } = build(map('export const b = 2;\n'));
    expect(getEmbeddedSource(model, capture, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(getEmbeddedSource(model, capture, 'src/b.ts')).toBe('export const b = 2;\n');
  });

  it('treats a null sourcesContent entry as unavailable', () => {
    const { capture, model } = build(map(null));
    expect(getEmbeddedSource(model, capture, 'src/b.ts')).toBeUndefined();
  });

  it('survives a map that is not JSON', () => {
    const capture = synthCapture([{ stack: ['a'], samples: 1 }], {
      sourceMaps: { [url]: '{nope' },
    });
    expect(getEmbeddedSource(analyze(capture), capture, 'src/a.ts')).toBeUndefined();
  });
});
