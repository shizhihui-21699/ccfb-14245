/**
 * The profile: the single source of truth every patched API reads from.
 *
 * A profile is derived purely from (install seed, site key). It holds
 * *parameters* rather than finished values wherever a value must be produced
 * by a rendering pipeline (canvas pixels, audio samples), so the same profile
 * produces the same output on any machine.
 *
 * The `Invariant` type below is the enforcement point for self-consistency:
 * candidates that fail are re-drawn before the profile is ever handed out.
 */

export type OsFamily = 'windows' | 'macos' | 'linux';

export interface HardwareProfile {
  os: OsFamily;
  /** Reported by navigator.hardwareConcurrency. */
  cores: number;
  /** Reported by navigator.deviceMemory. */
  memoryGB: number;
  arch: 'x86' | 'arm';
  bitness: '32' | '64';
  /** Human-readable device class, drives CPU/GPU pairing. Must be a key of CPU_DEVICE_CLASSES. */
  deviceClass: string;
}

export interface GpuProfile {
  /** Unmasked vendor from WEBGL_debug_renderer_info, e.g. "Google Inc. (NVIDIA)". */
  vendor: string;
  /** Unmasked renderer, e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)". */
  renderer: string;
  /** Plain (masked) renderer, e.g. "WebKit WebGL". */
  maskedRenderer: string;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDim: number;
  maxVertexAttribs: number;
  maxVaryingVectors: number;
  maxCombinedTextureUnits: number;
  maxTextureUnits: number;
  maxFragmentUniformVectors: number;
  maxVertexUniformVectors: number;
  aliasedLineWidthRange: [number, number];
  aliasedPointSizeRange: [number, number];
  extensions: string[];
  /** Precision strings are stable across a GPU family; decided per family. */
  vertexPrecision: { rangeMin: number; rangeMax: number; precision: number };
  fragmentPrecision: { rangeMin: number; rangeMax: number; precision: number };
  /** Derived sub-seed for deterministic readPixels noise. */
  noiseSeed: number;
}

export interface ScreenProfile {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  dpr: number;
  orientation: 'landscape-primary' | 'portrait-primary';
  /** Nominal frame rate reported through `requestVideoFrameCallback` timing hints. */
  refreshHz: number;
}

export interface UaProfile {
  /** Full user-agent string. */
  ua: string;
  /** navigator.platform, e.g. "Win32", "MacIntel", "Linux x86_64". */
  platform: string;
  uaDataPlatform: 'Windows' | 'macOS' | 'Linux';
  /** Chrome major version, in the supported window. */
  chromeMajor: number;
  /** Full Chrome version string for getHighEntropyValues().uaFullVersion. */
  chromeFullVersion: string;
  /** RE2-compatible "Not A Brand" entry; there are two since Chrome 131. */
  notABrand: { brand: string; version: string };
  /** navigator.vendor. */
  vendor: string;
  /** navigator.languages, ordered. */
  languages: string[];
  /** IANA timezone id. */
  timeZone: string;
  /** UTC offset in minutes for the chosen timezone (east positive). */
  tzOffsetMinutes: number;
  /** navigator.maxTouchPoints. */
  maxTouchPoints: number;
  /** navigator.pdfViewerEnabled. */
  pdfViewerEnabled: boolean;
  /** Whether the OS exposes a battery (laptops true, desktops often false). */
  hasBattery: boolean;
  /** Platform version string reported by getHighEntropyValues(). */
  platformVersion: string;
  /** navigator.connection effectiveType. */
  connectionType: '4g' | '3g' | 'wifi';
  connectionDownlink: number;
  connectionRtt: number;
}

export interface FontSpec {
  /** Family name as the page would use it. */
  family: string;
  /** Per-family width scale applied by measureText, ~[0.97, 1.03]. */
  widthScale: number;
  /** Per-family ascent scale, ~[0.98, 1.02]. */
  ascentScale: number;
  /** Whether document.fonts.check() should claim it exists. */
  present: boolean;
}

export interface NoiseProfile {
  canvas: { seed: number; amplitude: number; textJitter: number };
  audio: { seed: number; amplitude: number };
  webgl: { seed: number; amplitude: number };
  /** ClientRects sub-pixel jitter for measurement-based font detection. */
  rect: { seed: number; amplitude: number };
}

export interface MediaProfile {
  audioInputs: number;
  audioOutputs: number;
  videoInputs: number;
  /** Stable per-profile device ids, parallel to the device list order. */
  ids: string[];
}

export interface Profile {
  version: 1;
  siteKey: string;
  hardware: HardwareProfile;
  gpu: GpuProfile;
  screen: ScreenProfile;
  ua: UaProfile;
  fonts: FontSpec[];
  noise: NoiseProfile;
  media: MediaProfile;
  /** navigator.doNotTrack: "1" | null. Chosen per-install by the user, not per-site. */
  doNotTrack: '1' | null;
}

/** A named check used to reject incoherent candidates before they are used. */
export interface Invariant {
  id: string;
  description: string;
  check(p: Profile): boolean;
}
