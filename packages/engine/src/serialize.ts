// Compact binary form of an execution model: a JSON header (everything except typed arrays and
// the string table's text), then the typed array buffers, each aligned to 8 bytes. A reopen skips
// analysis entirely. The header carries the engine version; a mismatch is reported, never guessed.

import { ENGINE_VERSION } from './config.js';
import { currentModelShape, modelShape, shapeCovers } from './model-shape.js';
import type { ExecutionModel } from './model.js';
import { utf8Decode, utf8Encode } from './util/encoding.js';

const MAGIC = [0x50, 0x41, 0x43, 0x4d]; // "PACM"
const FORMAT_VERSION = 1;

const ARRAY_TYPES = {
  Float64Array,
  Float32Array,
  Uint32Array,
  Int32Array,
  Uint16Array,
  Int16Array,
  Uint8Array,
  Int8Array,
} as const;
type ArrayName = keyof typeof ARRAY_TYPES;
type AnyTyped = InstanceType<(typeof ARRAY_TYPES)[ArrayName]>;

interface Placeholder {
  $ta: ArrayName;
  i: number;
}

interface BufferEntry {
  offset: number;
  bytes: number;
  length: number;
}

interface Header {
  formatVersion: number;
  engineVersion: string;
  /** Column fingerprint of the model; see model-shape.ts. Absent in files from older engines. */
  shape?: string;
  model: unknown;
  buffers: BufferEntry[];
}

/** Thrown when a cached model was written by a different engine; re-run `analyze` on the capture. */
export class ModelVersionError extends Error {
  constructor(
    readonly found: string,
    readonly expected: string,
  ) {
    super(
      `This model was written by engine ${found}, but this is engine ${expected}. Re-analyze the raw capture to rebuild it.`,
    );
    this.name = 'ModelVersionError';
  }
}

function arrayName(value: unknown): ArrayName | undefined {
  for (const name of Object.keys(ARRAY_TYPES) as ArrayName[]) {
    if (value instanceof ARRAY_TYPES[name]) return name;
  }
  return undefined;
}

const align8 = (n: number): number => (n + 7) & ~7;

export function serializeModel(model: ExecutionModel): Uint8Array {
  const arrays: AnyTyped[] = [];
  const seen = new Map<AnyTyped, number>();

  const encode = (value: unknown): unknown => {
    const name = arrayName(value);
    if (name) {
      const ta = value as AnyTyped;
      let i = seen.get(ta);
      if (i === undefined) {
        i = arrays.length;
        arrays.push(ta);
        seen.set(ta, i);
      }
      const placeholder: Placeholder = { $ta: name, i };
      return placeholder;
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = encode(v);
      return out;
    }
    return value;
  };

  const encoded = encode(model);
  const buffers: BufferEntry[] = [];
  let cursor = 0;
  for (const ta of arrays) {
    buffers.push({ offset: cursor, bytes: ta.byteLength, length: ta.length });
    cursor += align8(ta.byteLength);
  }
  const header: Header = {
    formatVersion: FORMAT_VERSION,
    engineVersion: ENGINE_VERSION,
    shape: modelShape(model),
    model: encoded,
    buffers,
  };
  const headerBytes = utf8Encode(JSON.stringify(header));
  const bodyStart = align8(12 + headerBytes.length);
  const out = new Uint8Array(bodyStart + cursor);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  arrays.forEach((ta, i) => {
    const entry = buffers[i];
    if (!entry) return;
    out.set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength), bodyStart + entry.offset);
  });
  return out;
}

function readHeader(bytes: Uint8Array): { header: Header; bodyStart: number } {
  if (bytes.length < 12 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('Not a paces model: the data does not start with the model signature.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint32(4, true);
  if (format !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported model format version ${format}; this engine reads ${FORMAT_VERSION}.`,
    );
  }
  const length = view.getUint32(8, true);
  const header = JSON.parse(utf8Decode(bytes.subarray(12, 12 + length))) as Header;
  return { header, bodyStart: align8(12 + length) };
}

/** The engine version a serialized model was written with, without decoding the body. */
export function readModelEngineVersion(bytes: Uint8Array): string {
  return readHeader(bytes).header.engineVersion;
}

export function deserializeModel(bytes: Uint8Array): ExecutionModel {
  const { header, bodyStart } = readHeader(bytes);
  if (header.engineVersion !== ENGINE_VERSION) {
    throw new ModelVersionError(header.engineVersion, ENGINE_VERSION);
  }
  if (!shapeCovers(header.shape, currentModelShape())) {
    throw new ModelVersionError(
      `${header.engineVersion} (different model columns)`,
      ENGINE_VERSION,
    );
  }
  // Typed array views need aligned offsets; copy once when the input is a misaligned slice.
  const base = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  const decoded = new Map<number, AnyTyped>();
  const arrayAt = (placeholder: Placeholder): AnyTyped => {
    const cached = decoded.get(placeholder.i);
    if (cached) return cached;
    const entry = header.buffers[placeholder.i];
    if (!entry) throw new Error('The model file is corrupt: a buffer reference is out of range.');
    const Ctor = ARRAY_TYPES[placeholder.$ta];
    const ta = new Ctor(
      base.buffer as ArrayBuffer,
      base.byteOffset + bodyStart + entry.offset,
      entry.length,
    );
    decoded.set(placeholder.i, ta);
    return ta;
  };
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.$ta === 'string' && typeof record.i === 'number') {
        return arrayAt(record as unknown as Placeholder);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) out[k] = decode(v);
      return out;
    }
    return value;
  };
  return decode(header.model) as ExecutionModel;
}
