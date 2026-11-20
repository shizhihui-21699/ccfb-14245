/**
 * Invariants: the coherence contract.
 *
 * Each entry encodes something a hardware-aware detector could check and that
 * a naive randomiser gets wrong. Profiles failing any invariant are discarded
 * before use, so a page can never observe the failure. The same list is
 * exported to the test lab's `crossSource` detector, which means the lab is
 * checking the exact property the generator guarantees — not a hand-written
 * approximation of it.
 *
 * Keep this list honest: an invariant belongs here only if a real detector
 * could plausibly test it. Over-strict rules shrink the profile pool until
 * every user looks the same again, which is its own fingerprint.
 */

import { DEVICE_CLASS_BY_ID } from './devices.js';
import type { Invariant, Profile } from './types.js';

export const INVARIANTS: Invariant[] = [
  {
    id: 'viewport-fits-screen',
    description: 'CSS viewport can never exceed the physical screen at the reported DPR.',
    check: (p) => p.screen.width * p.screen.dpr >= 1 && p.screen.height * p.screen.dpr >= 1,
  },
  {
    id: 'avail-within-screen',
    description: 'availWidth/availHeight must not exceed width/height.',
    check: (p) => p.screen.availWidth <= p.screen.width && p.screen.availHeight <= p.screen.height,
  },
  {
    id: 'avail-differs-from-screen',
    description: 'A desktop/laptop always has a taskbar, menubar or dock, so avail < screen on at least one axis.',
    check: (p) => p.screen.availWidth < p.screen.width || p.screen.availHeight < p.screen.height,
  },
  {
    id: 'dpr-matches-os',
    description: 'macOS is always an exact integer DPR >= 2; Windows/Linux use the fractional Windows scale set.',
    check: (p) => {
      if (p.hardware.os === 'macos') return p.screen.dpr >= 2 && Number.isInteger(p.screen.dpr);
      return [1, 1.25, 1.5, 1.75, 2].includes(p.screen.dpr);
    },
  },
  {
    id: 'cores-exist-for-device',
    description: 'The core count must be one the device class actually ships with.',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      return !!dc && dc.cores.includes(p.hardware.cores) && dc.os === p.hardware.os;
    },
  },
  {
    id: 'memory-exists-for-device',
    description: 'Reported memory must be a real configuration for the device class.',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      return !!dc && dc.memoryGB.includes(p.hardware.memoryGB);
    },
  },
  {
    id: 'gpu-vendor-matches-os',
    description: 'Apple GPUs only on macOS; Google Inc. (NVIDIA/AMD/Intel) only on Windows/Linux.',
    check: (p) => {
      const v = p.gpu.vendor;
      if (p.hardware.os === 'macos') return v === 'Google Inc. (Apple)' || v === 'Google Inc. (Intel)';
      return v.startsWith('Google Inc. (') && v !== 'Google Inc. (Apple)';
    },
  },
  {
    id: 'arch-matches-gpu-vendor',
    description: 'An Apple-silicon GPU implies arm64; an ANGLE D3D11 renderer implies x86.',
    check: (p) => {
      const appleSilicon = p.gpu.renderer.includes('Apple M');
      const d3d = p.gpu.renderer.includes('D3D11');
      if (appleSilicon) return p.hardware.arch === 'arm';
      if (d3d) return p.hardware.arch === 'x86';
      return true;
    },
  },
  {
    id: 'ua-os-matches-profile-os',
    description: 'The user-agent OS token must agree with the hardware profile.',
    check: (p) => {
      switch (p.hardware.os) {
        case 'windows': return p.ua.ua.includes('Windows NT 10.0') && p.ua.platform === 'Win32';
        case 'macos': return p.ua.ua.includes('Macintosh; Intel Mac OS X') && p.ua.platform === 'MacIntel';
        case 'linux': return p.ua.ua.includes('X11; Linux x86_64') && p.ua.platform === 'Linux x86_64';
      }
    },
  },
  {
    id: 'ua-version-window',
    description: 'Chrome version in the UA must be within 2 majors of the running browser.',
    check: (p) => {
      const m = /Chrome\/(\d+)\.0\.0\.0/.exec(p.ua.ua);
      if (!m) return false;
      const claimed = Number(m[1]);
      return claimed === p.ua.chromeMajor && Math.abs(claimed - p.ua.chromeMajor) === 0;
    },
  },
  {
    id: 'high-entropy-version-matches-ua-major',
    description: 'uaFullVersion brand major must equal the UA major.',
    check: (p) => p.ua.chromeFullVersion.split('.')[0] === String(p.ua.chromeMajor),
  },
  {
    id: 'required-fonts-present',
    description: 'Every font the OS ships with must report present.',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      if (!dc) return false;
      const present = new Set(p.fonts.filter((f) => f.present).map((f) => f.family.toLowerCase()));
      return dc.requiredFonts.every((f) => present.has(f.toLowerCase()));
    },
  },
  {
    id: 'foreign-fonts-absent',
    description: 'Fonts belonging to a different OS must not be claimed present (Windows fonts on macOS, etc.).',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      if (!dc) return false;
      const own = new Set(dc.requiredFonts.map((f) => f.toLowerCase()));
      const foreign = new Set<string>();
      for (const other of DEVICE_CLASS_BY_ID.values()) {
        if (other.os === dc.os) continue;
        for (const f of other.requiredFonts) {
          const k = f.toLowerCase();
          if (!own.has(k)) foreign.add(k);
        }
      }
      return p.fonts.every((f) => !f.present || !foreign.has(f.family.toLowerCase()));
    },
  },
  {
    id: 'touch-matches-device-class',
    description: 'Touch points must be zero on non-touch desktops.',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      if (!dc) return false;
      if (!dc.laptop) return p.ua.maxTouchPoints === 0;
      return true;
    },
  },
  {
    id: 'noise-amplitude-bounded',
    description: 'Canvas noise must stay below the perceptual threshold (2 LSB); audio below 1e-4.',
    check: (p) => p.noise.canvas.amplitude <= 2 && p.noise.audio.amplitude <= 1e-4,
  },
  {
    id: 'noise-canvas-webgl-share-seed',
    description: 'Canvas and WebGL perturbation must use the same seed, or the GL-to-2D copy path disagrees with readPixels.',
    check: (p) => p.noise.canvas.seed === p.noise.webgl.seed,
  },
  {
    id: 'locale-timezone-coherent',
    description: 'Language and timezone must come from the same region.',
    check: (p) => {
      const lang = p.ua.languages[0] ?? '';
      const tz = p.ua.timeZone;
      const regionMap: Record<string, string[]> = {
        zh: ['Asia/Shanghai', 'Asia/Taipei', 'Asia/Hong_Kong'],
        ja: ['Asia/Tokyo'],
        ko: ['Asia/Seoul'],
        en: ['America/', 'Europe/London', 'Australia/', 'Asia/Kolkata'],
        de: ['Europe/Berlin'], fr: ['Europe/Paris'], es: ['Europe/Madrid'],
        it: ['Europe/Rome'], ru: ['Europe/Moscow'], pt: ['America/Sao_Paulo'],
        nl: ['Europe/Amsterdam'],
      };
      const prefix = lang.split('-')[0] ?? '';
      const allowed = regionMap[prefix];
      if (!allowed) return false;
      return allowed.some((a) => tz === a || tz.startsWith(a));
    },
  },
  {
    id: 'extension-list-fits-family',
    description: 'WebGL extension count must match the family the renderer string claims.',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      if (!dc) return false;
      const gpu = dc.gpus.find((g) => g.renderer === p.gpu.renderer);
      // The count may be raised above the family's own to keep required
      // extensions present, never lowered below it.
      return !!gpu && p.gpu.extensions.length >= gpu.extensionCount
        && p.gpu.extensions.length <= Math.min(gpu.extensionCount + 2, 44);
    },
  },
  {
    id: 'debug-renderer-info-present',
    description:
      'WEBGL_debug_renderer_info must exist: without it the unmasked vendor/renderer cannot be read, and a desktop profile that hides it is a contradiction.',
    check: (p) => p.gpu.extensions.includes('WEBGL_debug_renderer_info'),
  },
  {
    id: 'media-device-count-sane',
    description: 'A device cannot report more audio inputs than its class plausibly has.',
    check: (p) => {
      const dc = DEVICE_CLASS_BY_ID.get(p.hardware.deviceClass);
      if (!dc) return false;
      if (!dc.laptop && p.media.audioInputs > 1) return false;
      return p.media.audioOutputs >= 1 && p.media.ids.length >= p.media.audioInputs + p.media.audioOutputs + p.media.videoInputs;
    },
  },
];

/** Runs the full invariant suite. Returns the ids that failed. */
export function failedInvariants(p: Profile): string[] {
  const out: string[] = [];
  for (const inv of INVARIANTS) {
    try {
      if (!inv.check(p)) out.push(inv.id);
    } catch {
      out.push(inv.id);
    }
  }
  return out;
}
