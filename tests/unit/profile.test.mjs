/**
 * Unit tests for the derivation core.
 *
 * These exist because the profile is the single source of truth: a bug here is
 * not a cosmetic bug, it is "every user looks the same" or "the profile changes
 * on every read", both of which are worse than shipping nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { siphash24, derive } from '../../dist-test/siphash.js';
import { Rng, rngFrom } from '../../dist-test/rng.js';
import { registrableDomain, siteKeyOf } from '../../dist-test/etld.js';
import { deriveProfile } from '../../dist-test/builder.js';
import { failedInvariants, INVARIANTS } from '../../dist-test/invariants.js';

const SEED_A = new Uint8Array(32).fill(0x11);
const SEED_B = new Uint8Array(32).fill(0x22);

test('siphash matches the reference vector', () => {
  // SipHash-2-4 with key 00..0f over the empty string is a published vector.
  const key = Uint8Array.from({ length: 16 }, (_, i) => i);
  assert.equal(siphash24(key, new Uint8Array(0)), 0x726fdb47dd0e0e31n);
  assert.equal(siphash24(key, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])), 0x93f5f5799a932462n);
});

test('derive is domain separated and length-prefixed', () => {
  assert.notEqual(derive(SEED_A, 'a', 'bc'), derive(SEED_A, 'ab', 'c'));
  assert.notEqual(derive(SEED_A, 'a'), derive(SEED_A, 'b'));
  assert.notEqual(derive(SEED_A, 'a'), derive(SEED_B, 'a'));
  assert.equal(derive(SEED_A, 'a', 'b'), derive(SEED_A, 'a', 'b'));
});

test('rng is deterministic and within range', () => {
  const a = rngFrom(1n, 2n);
  const b = rngFrom(1n, 2n);
  for (let i = 0; i < 1000; i++) assert.equal(a.nextU32(), b.nextU32());

  const r = new Rng(new Uint8Array(16).fill(7));
  const seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const v = r.int(3, 9);
    assert.ok(v >= 3 && v <= 9);
    seen.add(v);
  }
  assert.equal(seen.size, 7, 'int() should cover the whole inclusive range');
});

test('registrable domain handles the cases that matter', () => {
  assert.equal(registrableDomain('a.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('x.y.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('news.example.com.cn'), 'example.com.cn');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.equal(registrableDomain('[::1]'), null);

  // Two subdomains of one registrable domain share a site key; different
  // registrable domains do not.
  assert.equal(
    siteKeyOf({ protocol: 'https:', hostname: 'a.example.com' }),
    siteKeyOf({ protocol: 'https:', hostname: 'b.example.com' }),
  );
  assert.notEqual(
    siteKeyOf({ protocol: 'https:', hostname: 'example.com' }),
    siteKeyOf({ protocol: 'https:', hostname: 'example.net' }),
  );
});

test('profile derivation is a pure function of (seed, site)', () => {
  const a = deriveProfile(SEED_A, 'example.com', { runtimeMajor: 157 });
  const b = deriveProfile(SEED_A, 'example.com', { runtimeMajor: 157 });
  assert.deepEqual(a, b, 'same seed and site must give an identical profile');

  const other = deriveProfile(SEED_A, 'other.com', { runtimeMajor: 157 });
  assert.notDeepEqual(a, other, 'different sites must give different profiles');

  const otherSeed = deriveProfile(SEED_B, 'example.com', { runtimeMajor: 157 });
  assert.notDeepEqual(a, otherSeed, 'different installs must give different profiles');
});

test('every generated profile satisfies every invariant', () => {
  for (let i = 0; i < 400; i++) {
    const site = `site${i}.example.com`;
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const profile = deriveProfile(seed, site, { runtimeMajor: 157 });
    assert.deepEqual(failedInvariants(profile), [], `profile for ${site} violated invariants`);
  }
});

test('the invariant suite actually rejects bad profiles', () => {
  const profile = deriveProfile(SEED_A, 'example.com', { runtimeMajor: 157 });

  const brokenScreen = structuredClone(profile);
  brokenScreen.screen.width = 4000;
  brokenScreen.screen.availWidth = 5000;
  assert.ok(failedInvariants(brokenScreen).includes('avail-within-screen'));

  const brokenGpu = structuredClone(profile);
  brokenGpu.hardware.os = 'windows';
  brokenGpu.gpu.vendor = 'Google Inc. (Apple)';
  assert.ok(failedInvariants(brokenGpu).includes('gpu-vendor-matches-os'));

  const brokenNoise = structuredClone(profile);
  brokenNoise.noise.webgl.seed = profile.noise.canvas.seed + 1;
  assert.ok(failedInvariants(brokenNoise).includes('noise-canvas-webgl-share-seed'));

  const brokenLocale = structuredClone(profile);
  brokenLocale.ua.languages = ['zh-CN', 'zh'];
  brokenLocale.ua.timeZone = 'America/Chicago';
  assert.ok(failedInvariants(brokenLocale).includes('locale-timezone-coherent'));
});

test('Chrome version never claims to be newer than the running browser', () => {
  for (let runtimeMajor = 140; runtimeMajor <= 200; runtimeMajor += 5) {
    for (let i = 0; i < 20; i++) {
      const p = deriveProfile(SEED_A, `s${i}.com`, { runtimeMajor });
      assert.ok(p.ua.chromeMajor <= runtimeMajor, `claimed ${p.ua.chromeMajor} > ${runtimeMajor}`);
      assert.ok(p.ua.chromeMajor >= runtimeMajor - 2, `claimed ${p.ua.chromeMajor} too far behind ${runtimeMajor}`);
    }
  }
});

test('profile spread is wide enough to be useful', () => {
  // A defence that maps many sites onto a handful of identities is itself a
  // fingerprint. Count distinct high-level identities over 300 sites.
  const identities = new Set();
  for (let i = 0; i < 300; i++) {
    const p = deriveProfile(SEED_A, `site${i}.com`, { runtimeMajor: 157 });
    identities.add([
      p.hardware.deviceClass,
      p.hardware.cores,
      p.screen.width,
      p.gpu.renderer,
      p.ua.languages[0],
      p.ua.timeZone,
      p.noise.canvas.seed,
    ].join('|'));
  }
  assert.ok(identities.size > 250, `only ${identities.size} distinct identities over 300 sites`);
});

test('the invariant list is non-trivial', () => {
  assert.ok(INVARIANTS.length >= 15, 'the coherence contract has lost most of its rules');
  const ids = new Set(INVARIANTS.map((i) => i.id));
  assert.equal(ids.size, INVARIANTS.length, 'duplicate invariant ids');
});

test('every profile exposes WEBGL_debug_renderer_info', () => {
  /**
   * Regression: the canonical extension list had 44 entries with
   * debug_renderer_info at index 35, while GPU families declared 34-36, so
   * `slice(0, count)` silently dropped it for the smaller families. Without the
   * extension, `getParameter(UNMASKED_RENDERER_WEBGL)` returns null and the
   * profile's GPU is unreadable — the exact opposite of the goal.
   */
  for (const forceOs of [undefined, 'windows', 'macos', 'linux']) {
    for (let i = 0; i < 120; i++) {
      const p = deriveProfile(SEED_A, `gpu${i}.example`, { runtimeMajor: 157, forceOs });
      assert.ok(
        p.gpu.extensions.includes('WEBGL_debug_renderer_info'),
        `profile ${p.hardware.deviceClass} (${forceOs ?? 'any'}) lacks debug_renderer_info`,
      );
    }
  }
});

test('a profile never claims a screen smaller than the real viewport', () => {
  /**
   * `innerWidth > screen.width` is the easiest contradiction in fingerprinting,
   * and a naive random screen draw produces it constantly on a large window.
   * The derivation therefore takes the real viewport as a constraint.
   */
  const viewport = { width: 1680, height: 1050 };
  for (let i = 0; i < 200; i++) {
    const p = deriveProfile(SEED_A, `vp${i}.example`, { runtimeMajor: 157, minViewport: viewport });
    assert.ok(
      p.screen.width >= viewport.width && p.screen.height >= viewport.height,
      `profile ${p.hardware.deviceClass} claims ${p.screen.width}x${p.screen.height} for a ${viewport.width}x${viewport.height} window`,
    );
  }
});

test('a very large viewport still yields a coherent profile', () => {
  // Screens have a maximum size in the corpus; an absurd window (e.g. a huge
  // external display) must not make derivation fail. The fallback is to ignore
  // the constraint rather than throw, because a page that renders at all must
  // not be left unpatched.
  const p = deriveProfile(SEED_A, 'huge.example', {
    runtimeMajor: 157,
    minViewport: { width: 10000, height: 6000 },
  });
  assert.ok(p.screen.width > 0);
  assert.deepEqual(failedInvariants(p), []);
});

test('3000 derived identities are all distinct', () => {
  /**
   * The whole point is that a tracker cannot join two sites on the identity
   * vector. Individual fields collide by design (a small hardware corpus is more
   * plausible than an unlimited one), so the guarantee is on the vector.
   */
  const seen = new Map();
  for (let i = 0; i < 3000; i++) {
    const p = deriveProfile(SEED_A, `site${i}.com`, { runtimeMajor: 157 });
    const v = [
      p.ua.ua, p.ua.platform, p.hardware.cores, p.hardware.memoryGB,
      p.ua.languages.join(','), p.ua.timeZone,
      p.screen.width, p.screen.height, p.screen.dpr,
      p.gpu.renderer, p.ua.chromeMajor, p.noise.canvas.seed,
    ].join('|');
    seen.set(v, (seen.get(v) ?? 0) + 1);
  }
  assert.equal(seen.size, 3000, `${3000 - seen.size} identity collision(s) across 3000 sites`);
});
