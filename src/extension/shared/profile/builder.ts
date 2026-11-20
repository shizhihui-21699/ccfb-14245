/**
 * Profile derivation: (install seed, site key) -> coherent profile.
 *
 * Determinism is the whole design. There is no cache, no shared mutable state,
 * and no async step, so a tab opened at any time, before or after a service
 * worker restart, in any frame, derives the same profile. Rejection sampling
 * against the invariant set means an incoherent candidate never leaks out;
 * the retry counter is part of the derivation input, so even the retries are
 * deterministic.
 */

import { derive } from '../siphash.js';
import { rngFrom } from '../rng.js';
import {
  DEVICE_CLASSES, DEVICE_CLASS_BY_ID, LOCALE_CORPUS, extensionsForCount,
  type DeviceClass, type GpuSpec,
} from './devices.js';
import type { FontSpec, Profile, UaProfile } from './types.js';
import { INVARIANTS } from './invariants.js';

/** Chrome versions we are willing to claim. The page runs on `runtimeMajor`;
 *  profiles never claim a version newer than the browser itself (impossible)
 *  nor older than the support window (stale but plausible). */
export const MIN_MAJOR_OFFSET = 2;

const NOT_A_BRAND_POOL = [
  { brand: 'Not)A;Brand', version: '24' },
  { brand: 'Not=A?Brand', version: '8' },
  { brand: 'Not-A.Brand', version: '99' },
  { brand: 'Not_A Brand', version: '24' },
];

export interface DeriveOptions {
  /** The browser's real Chrome major version. Profiles stay within [real-2, real]. */
  runtimeMajor: number;
  /** Forces a particular OS family; used by the test lab to check consistency rules. */
  forceOs?: 'windows' | 'macos' | 'linux';
  /** Ignore invariants (test-only, to prove the lab catches the failures). */
  unsafe?: boolean;
  /**
   * The window's actual CSS viewport, when known.
   *
   * A profile may only claim a screen at least this large. Claiming a
   * 1366x768 panel while the window is 1440 CSS px wide produces
   * `innerWidth > screen.width`, which is the single easiest contradiction in
   * browser fingerprinting and the first thing the lab's screen rules check.
   * When omitted (worker realms, tests) the constraint is not applied.
   */
  minViewport?: { width: number; height: number };
}

export function deriveProfile(seed: Uint8Array, siteKey: string, opts: DeriveOptions): Profile {
  for (let attempt = 0; attempt < 64; attempt++) {
    const profile = buildOnce(seed, siteKey, attempt, opts);
    if (opts.unsafe) return profile;
    const failed = INVARIANTS.filter((inv) => {
      try {
        return !inv.check(profile);
      } catch {
        return true;
      }
    });
    if (failed.length === 0) return profile;
  }
  // The corpus is constructed so that at least one candidate always passes;
  // reaching this point means the corpus or an invariant is broken.
  throw new Error(`no coherent profile for site ${siteKey} after 64 attempts`);
}

function buildOnce(seed: Uint8Array, siteKey: string, attempt: number, opts: DeriveOptions): Profile {
  const attemptLabel = `attempt:${attempt}`;
  const hi = derive(seed, 'profile-root', siteKey, attemptLabel);
  const lo = derive(seed, 'profile-root-2', siteKey, attemptLabel);
  const rng = rngFrom(hi, lo);

  const basePool = opts.forceOs ? DEVICE_CLASSES.filter((d) => d.os === opts.forceOs) : DEVICE_CLASSES;
  /**
   * Drop device classes none of whose panels could contain the real viewport.
   * The per-panel filter below narrows further; both are needed because a
   * class can mix a small laptop panel with a large external monitor.
   */
  const pool = opts.minViewport
    ? basePool.filter((d) => d.screens.some((sc) => fits(sc, opts.minViewport!)))
    : basePool;
  const device: DeviceClass = (pool.length > 0 ? rng.pick(pool) : rng.pick(basePool));

  const cores = rng.pick(device.cores);
  const memoryGB = rng.pick(device.memoryGB);
  const eligibleScreens = opts.minViewport
    ? device.screens.filter((sc) => fits(sc, opts.minViewport!))
    : device.screens;
  const screen = rng.pick(eligibleScreens.length > 0 ? eligibleScreens : device.screens);
  const gpu: GpuSpec = rng.pick(device.gpus);
  const locale = rng.pick(LOCALE_CORPUS);

  const chromeMajor = opts.runtimeMajor - rng.int(0, MIN_MAJOR_OFFSET);
  const fullVersionTail = `${rng.int(4000, 7999)}.${rng.int(0, 249)}`;
  const notABrand = rng.pick(NOT_A_BRAND_POOL);

  const ua = buildUa(device.os, chromeMajor);
  const platform = device.os === 'windows' ? 'Win32' : device.os === 'macos' ? 'MacIntel' : 'Linux x86_64';
  const uaDataPlatform = device.os === 'windows' ? 'Windows' : device.os === 'macos' ? 'macOS' : 'Linux';

  const uaProfile: UaProfile = {
    ua,
    platform,
    uaDataPlatform,
    chromeMajor,
    chromeFullVersion: `${chromeMajor}.0.${fullVersionTail}`,
    notABrand,
    vendor: 'Google Inc.',
    languages: locale.languages,
    timeZone: locale.timeZone,
    tzOffsetMinutes: locale.tzOffsetMinutes,
    maxTouchPoints: device.laptop && rng.bool(0.25) ? rng.int(1, 10) : 0,
    pdfViewerEnabled: true,
    hasBattery: device.laptop,
    platformVersion: device.platformVersion,
    connectionType: rng.weighted([['wifi', 0.45], ['4g', 0.55]] as const),
    connectionDownlink: Number(rng.floatIn(1.2, 10, 1).toFixed(1)),
    connectionRtt: rng.pick([50, 100, 150, 200]),
  };

  // Use the family's count, but never below the required entries — see
  // extensionsForCount for the bug this prevents.
  const extensions = extensionsForCount(gpu.extensionCount);

  const fonts = buildFonts(rng, device);

  return {
    version: 1,
    siteKey,
    hardware: {
      os: device.os,
      cores,
      memoryGB,
      arch: device.arch,
      bitness: '64',
      deviceClass: device.id,
    },
    gpu: {
      vendor: gpu.vendor,
      renderer: gpu.renderer,
      maskedRenderer: 'WebKit WebGL',
      maxTextureSize: gpu.maxTextureSize,
      maxRenderbufferSize: gpu.maxRenderbufferSize,
      maxViewportDim: gpu.maxViewportDim,
      maxVertexAttribs: gpu.maxVertexAttribs,
      maxVaryingVectors: gpu.maxVaryingVectors,
      maxCombinedTextureUnits: gpu.maxCombinedTextureUnits,
      maxTextureUnits: gpu.maxTextureUnits,
      maxFragmentUniformVectors: gpu.maxFragmentUniformVectors,
      maxVertexUniformVectors: gpu.maxVertexUniformVectors,
      aliasedLineWidthRange: [1, 1],
      aliasedPointSizeRange: [1, 1023],
      extensions,
      vertexPrecision: gpu.vendor.includes('Apple')
        ? { rangeMin: 127, rangeMax: 127, precision: 23 }
        : { rangeMin: 127, rangeMax: 127, precision: 23 },
      fragmentPrecision: gpu.vendor.includes('Apple')
        ? { rangeMin: 127, rangeMax: 127, precision: 23 }
        : { rangeMin: 1023, rangeMax: 1023, precision: 23 },
      noiseSeed: Number(derive(seed, 'webgl-noise', siteKey) & 0xffffffffn),
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: 24,
      pixelDepth: 24,
      dpr: screen.dpr,
      orientation: screen.width >= screen.height ? 'landscape-primary' : 'portrait-primary',
      refreshHz: screen.refreshHz,
    },
    ua: uaProfile,
    fonts,
    noise: {
      canvas: {
        seed: Number(derive(seed, 'canvas-noise', siteKey) & 0xffffffffn),
        amplitude: 1,
        textJitter: rng.floatIn(0.02, 0.09, 3),
      },
      audio: {
        seed: Number(derive(seed, 'audio-noise', siteKey) & 0xffffffffn),
        amplitude: rng.floatIn(2e-5, 8e-5, 7),
      },
      /**
       * MUST equal `canvas.seed`. A GL canvas copied into a 2D canvas and read
       * with getImageData must produce the same bytes as readPixels; both
       * transforms are keyed on this value. (Invariant `noise-canvas-webgl-share-seed`.)
       */
      webgl: {
        seed: Number(derive(seed, 'canvas-noise', siteKey) & 0xffffffffn),
        amplitude: 1,
      },
      rect: {
        seed: Number(derive(seed, 'rect-noise', siteKey) & 0xffffffffn),
        amplitude: rng.floatIn(0.0001, 0.0009, 6),
      },
    },
    media: {
      audioInputs: device.laptop ? rng.pick([1, 1, 2]) : rng.pick([0, 1]),
      audioOutputs: rng.pick([1, 1, 2]),
      videoInputs: device.laptop ? rng.pick([0, 1, 1, 2]) : rng.pick([0, 0, 1]),
      ids: Array.from({ length: 6 }, () => rng.deviceId()),
    },
    doNotTrack: null,
  };
}

/** Whether a panel could contain a window of this CSS size. */
function fits(screen: { width: number; height: number }, viewport: { width: number; height: number }): boolean {
  /**
   * A small margin covers window chrome: `innerWidth`/`innerHeight` describe the
   * document area, which is never larger than the screen and in practice is
   * noticeably smaller on the height axis. Allowing a few pixels of slack
   * avoids rejecting a panel that is *exactly* the window size.
   */
  return screen.width >= viewport.width && screen.height >= viewport.height;
}

function buildUa(os: 'windows' | 'macos' | 'linux', chromeMajor: number): string {
  const base = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  switch (os) {
    case 'windows':
      // Windows 10 and 11 both report NT 10.0; that is not a bug, it's the truth.
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${base}`;
    case 'macos':
      // macOS reports a frozen 10_15_7 by design for compatibility.
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${base}`;
    case 'linux':
      return `Mozilla/5.0 (X11; Linux x86_64) ${base}`;
  }
}

/**
 * Fonts: the required set for the OS is always present; optional families are
 * drawn per profile. Each family gets a small width/ascent scale so that
 * measurement-based enumeration stays coherent across runs.
 */
function buildFonts(rng: ReturnType<typeof rngFrom>, device: DeviceClass): FontSpec[] {
  const specs: FontSpec[] = [];
  const seen = new Set<string>();
  const add = (family: string, present: boolean) => {
    const key = family.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({
      family,
      widthScale: rng.floatIn(0.97, 1.03, 4),
      ascentScale: rng.floatIn(0.985, 1.015, 4),
      present,
    });
  };
  for (const f of device.requiredFonts) add(f, true);
  // Office / CJK packs are present on roughly a third of machines.
  const optional = rng.shuffle(device.optionalFonts);
  const optionalCount = rng.int(0, Math.min(optional.length, 10));
  for (let i = 0; i < optional.length; i++) add(optional[i]!, i < optionalCount);
  return specs;
}

export function deviceClassFor(profile: Profile): DeviceClass | undefined {
  return DEVICE_CLASS_BY_ID.get(profile.hardware.deviceClass);
}
