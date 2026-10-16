import type { ExecutionModel } from '@pacesjs/engine';

/**
 * Development-only model codec (JSON with base64 typed arrays), used by the dev host until the
 * engine's binary `serializeModel` is the only path. Real hosts send the engine's own bytes.
 */
const MAGIC = 'PACESDEV1\n';

const ARRAYS = {
  Float64Array,
  Float32Array,
  Uint32Array,
  Int32Array,
  Uint16Array,
  Uint8Array,
} as const;
type ArrayName = keyof typeof ARRAYS;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeDevModel(model: ExecutionModel): Uint8Array {
  const json = JSON.stringify(model, (_k, v: unknown) => {
    for (const name of Object.keys(ARRAYS) as ArrayName[]) {
      if (v instanceof ARRAYS[name]) {
        const view = v as Uint8Array;
        return {
          $t: name,
          b: toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
        };
      }
    }
    return v;
  });
  return new TextEncoder().encode(MAGIC + json);
}

export function isDevModel(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) === MAGIC;
}

export function decodeDevModel(bytes: Uint8Array): ExecutionModel {
  const text = new TextDecoder().decode(bytes).slice(MAGIC.length);
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object' && '$t' in v && 'b' in v) {
      const { $t, b } = v as { $t: ArrayName; b: string };
      const raw = fromBase64(b);
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
      return new ARRAYS[$t](buf);
    }
    return v;
  }) as ExecutionModel;
}
