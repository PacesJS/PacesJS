// The ES2022 lib has no atob, TextDecoder or TextEncoder; these are the small parts we need.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
B64_LOOKUP['-'.charCodeAt(0)] = 62;
B64_LOOKUP['_'.charCodeAt(0)] = 63;

export function base64ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? (B64_LOOKUP[c] ?? -1) : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let chunk: number[] = [];
  const flush = (): void => {
    out += String.fromCharCode(...chunk);
    chunk = [];
  };
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i++] ?? 0;
    let cp = b0;
    if (b0 >= 0xf0) {
      cp = ((b0 & 7) << 18) | (((bytes[i++] ?? 0) & 63) << 12);
      cp |= ((bytes[i++] ?? 0) & 63) << 6;
      cp |= (bytes[i++] ?? 0) & 63;
    } else if (b0 >= 0xe0) {
      cp = ((b0 & 15) << 12) | (((bytes[i++] ?? 0) & 63) << 6);
      cp |= (bytes[i++] ?? 0) & 63;
    } else if (b0 >= 0xc0) {
      cp = ((b0 & 31) << 6) | ((bytes[i++] ?? 0) & 63);
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else chunk.push(cp);
    if (chunk.length > 8000) flush();
  }
  flush();
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < text.length) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

/** Decodes the payload of a `data:` URI. Returns undefined for anything that is not a data URI. */
export function decodeDataUri(uri: string): string | undefined {
  if (!uri.startsWith('data:')) return undefined;
  const comma = uri.indexOf(',');
  if (comma < 0) return undefined;
  const head = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (head.includes(';base64')) return utf8Decode(base64ToBytes(body));
  try {
    return decodeURIComponent(body);
  } catch {
    return undefined;
  }
}
