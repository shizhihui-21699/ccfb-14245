/**
 * A small deterministic PRNG (xoshiro128**) plus a stream facade with the
 * operations the profile builder needs: int ranges, weighted picks, floats,
 * hex strings.
 *
 * Everything is seeded from a single 128-bit state, so a profile is a pure
 * function of (seed, site) — no randomness is drawn from the host machine and
 * nothing depends on when or where the code runs.
 */

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: Uint8Array) {
    if (state.length < 16) throw new Error('rng state must be >= 16 bytes');
    const dv = new DataView(state.buffer, state.byteOffset, state.byteLength);
    this.s0 = dv.getUint32(0, true);
    this.s1 = dv.getUint32(4, true);
    this.s2 = dv.getUint32(8, true);
    this.s3 = dv.getUint32(12, true);
    // xoshiro is undefined for an all-zero state; fold in a constant.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
  }

  /** Raw unsigned 32-bit output. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform float in [0, 1) with 32 bits of entropy. */
  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`int(${min}, ${max}): empty range`);
    const span = max - min + 1;
    // Rejection sampling to avoid modulo bias.
    const limit = Math.floor(0x100000000 / span) * span;
    let v: number;
    do {
      v = this.nextU32();
    } while (v >= limit);
    return min + (v % span);
  }

  bool(p = 0.5): boolean {
    return this.nextFloat() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() on empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Weighted pick; weights are relative, not required to sum to anything. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((n, [, w]) => n + w, 0);
    let r = this.nextFloat() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  /** Fisher-Yates shuffle; returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i]!;
      out[i] = out[j]!;
      out[j] = a;
    }
    return out;
  }

  /** Deterministic lowercase hex string of `bytes` bytes. */
  hex(bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i++) {
      out += (this.nextU32() & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }

  /** Deterministic base32-ish id, the shape media device ids take. */
  deviceId(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 64; i++) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }

  /** A float with `digits` decimal places in [min, max]. */
  floatIn(min: number, max: number, digits = 6): number {
    const v = min + this.nextFloat() * (max - min);
    return Number(v.toFixed(digits));
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Build a Rng from the low 128 bits of a derived 64-bit value plus a counter. */
export function rngFrom(hi: bigint, lo: bigint): Rng {
  const state = new Uint8Array(16);
  const dv = new DataView(state.buffer);
  dv.setBigUint64(0, hi & 0xffffffffffffffffn, true);
  dv.setBigUint64(8, lo & 0xffffffffffffffffn, true);
  return new Rng(state);
}
