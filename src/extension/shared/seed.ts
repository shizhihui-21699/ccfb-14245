/**
 * Install seed derivation, shared by the service worker and content scripts.
 *
 * seed = HMAC-SHA256-shaped keyed derivation of (buildSeed, installSalt).
 *
 * - buildSeed is identical for every install of a given build.
 * - installSalt is 16 random bytes generated per install by the service worker.
 *   It reaches content scripts through a dynamic DNR redirect (see
 *   background/install.ts and docs/spike-results.md) because storage is
 *   async-only and the profile must be ready before the page's first script.
 *
 * Two SipHash outputs with domain separation are concatenated to 16 bytes. The
 * PRF is the same one the profile builder uses, so there is one primitive to
 * audit rather than two.
 */

import { siphash24 } from './siphash.js';

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Text-encode with a length prefix so distinct inputs cannot concatenate alike. */
function encodeLengthPrefixed(parts: string[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks = parts.map((p) => {
    const b = enc.encode(p);
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, b.length, true);
    return [prefix, b] as const;
  });
  const total = chunks.reduce((n, [p, b]) => n + p.length + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const [p, b] of chunks) {
    out.set(p, off); off += p.length;
    out.set(b, off); off += b.length;
  }
  return out;
}

/**
 * Derive the 16-byte install seed.
 *
 * The build seed is the PRF key and the install salt is the message, so
 * knowing one build's seed does not reveal another install's derived seed, and
 * two installs of the same build diverge completely.
 *
 * A missing salt (`salt === null`) is a real state — the service worker has not
 * run yet — and is deliberately distinct from an empty string so the degraded
 * mode cannot accidentally equal a legitimate derivation.
 */
export function deriveInstallSeed(buildSeed: string, salt: string | null): Uint8Array {
  const key = fromHex(buildSeed.padEnd(32, '0').slice(0, 32));
  const label = salt === null ? 'install:no-salt' : `install:${salt}`;
  const lo = siphash24(key, encodeLengthPrefixed([label, 'lo']));
  const hi = siphash24(key, encodeLengthPrefixed([label, 'hi']));
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, lo, true);
  dv.setBigUint64(8, hi, true);
  return out;
}

