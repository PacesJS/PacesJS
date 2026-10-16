/** Fast non-cryptographic content hash (two FNV-1a lanes, 16 hex chars). For change detection only. */
export function contentHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] as number;
    a = Math.imul(a ^ v, 0x01000193) >>> 0;
    b = Math.imul(b ^ (v + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
