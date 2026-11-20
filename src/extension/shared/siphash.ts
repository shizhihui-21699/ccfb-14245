/**
 * SipHash-2-4 — a keyed pseudorandom function.
 *
 * Why SipHash and not SHA-256: every derivation has to run *synchronously* at
 * document_start, before the page's first script, on every frame. WebCrypto is
 * async-only, and shipping a full SHA-256 adds weight for no benefit here. We
 * need a keyed PRF (the seed is the key), not a hash, and SipHash is exactly
 * that: short-input, keyed, fast, no timing side channel worth worrying about.
 *
 * Output is 64 bits, which is far more than enough to seed a per-site PRNG.
 */

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, b: bigint): bigint {
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

function readU64Le(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  }
  return v;
}

function sipRound(v0: bigint, v1: bigint, v2: bigint, v3: bigint): [bigint, bigint, bigint, bigint] {
  v0 = (v0 + v1) & MASK64;
  v1 = rotl(v1, 13n);
  v1 ^= v0;
  v0 = rotl(v0, 32n);
  v2 = (v2 + v3) & MASK64;
  v3 = rotl(v3, 16n);
  v3 ^= v2;
  v0 = (v0 + v3) & MASK64;
  v3 = rotl(v3, 21n);
  v3 ^= v0;
  v2 = (v2 + v1) & MASK64;
  v1 = rotl(v1, 17n);
  v1 ^= v2;
  v2 = rotl(v2, 32n);
  return [v0, v1, v2, v3];
}

/** SipHash-2-4 over `data`, keyed with a 16-byte key. Returns an unsigned 64-bit value. */
export function siphash24(key: Uint8Array, data: Uint8Array): bigint {
  if (key.length < 16) throw new Error('siphash key must be >= 16 bytes');
  const k0 = readU64Le(key, 0);
  const k1 = readU64Le(key, 8);

  let v0 = 0x736f6d6570736575n ^ k0;
  let v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0;
  let v3 = 0x7465646279746573n ^ k1;

  const len = data.length;
  const end = len - (len % 8);
  for (let i = 0; i < end; i += 8) {
    const m = readU64Le(data, i);
    v3 ^= m;
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 ^= m;
  }

  let b = BigInt(len & 0xff) << 56n;
  for (let i = 0; i < len % 8; i++) {
    b |= BigInt(data[end + i] ?? 0) << BigInt(8 * i);
  }
  v3 ^= b;
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 ^= b;

  v2 ^= 0xffn;
  for (let i = 0; i < 4; i++) [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);

  return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

/**
 * Derive a domain-separated 64-bit value from the master seed.
 * The label is length-prefixed so that ("ab","c") and ("a","bc") cannot collide.
 */
export function derive(seed: Uint8Array, label: string, ...parts: string[]): bigint {
  const chunks: Uint8Array[] = [];
  for (const s of [label, ...parts]) {
    const bytes = new TextEncoder().encode(s);
    const lenPrefix = new Uint8Array(4);
    new DataView(lenPrefix.buffer).setUint32(0, bytes.length, true);
    chunks.push(lenPrefix, bytes);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return siphash24(seed, buf);
}
