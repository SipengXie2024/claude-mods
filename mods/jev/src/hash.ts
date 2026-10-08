/**
 * Synchronous, dependency-free 80-bit hash as 20 hex characters: what
 * jev-opus took from sha256 (node:crypto), which a hooks module cannot reach,
 * and crypto.subtle is async while the reducer is not. Identities only need
 * to be stable and collision-unlikely within one prompt's issues, and never
 * to carry the raw text; this is not a cryptographic hash.
 */
export function hash20(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // Three FNV-1a 32-bit lanes with distinct offsets, each mixed with murmur3's finalizer.
  const lanes = [0x811c9dc5, 0x01000193 ^ 0x9e3779b9, 0x85ebca6b];
  for (const b of bytes) {
    for (let l = 0; l < lanes.length; l++) lanes[l] = Math.imul(lanes[l]! ^ b ^ l, 0x01000193) >>> 0;
  }
  const out = lanes.map((h, l) => {
    let x = (h ^ Math.imul(bytes.length + l, 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0).toString(16).padStart(8, '0');
  });
  return out.join('').slice(0, 20);
}
