// Turns a value into plain JSON so equal data always hashes the same. Shared by both golden helpers.
export function plain(value: unknown): unknown {
  if (value === undefined) return { undef: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { num: String(value) };
  if (ArrayBuffer.isView(value))
    return { typed: Array.from(value as unknown as ArrayLike<number>) };
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return { map: [...value.entries()].map(plain) };
  if (value instanceof Set) return { set: [...value].map(plain) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}
