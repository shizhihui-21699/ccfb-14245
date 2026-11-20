/**
 * Detectors.
 *
 * Each detector takes a snapshot and returns findings. The design rule for this
 * file: **only compare independent sources**. A detector that merely reports
 * "canvas hash is X" is not a detector. One that reports "the UA says Windows
 * but the unmasked WebGL renderer is Apple" is.
 *
 * Findings carry a stable `key` so the UI can diff two runs and show what
 * changed — which is how an instability in the profile becomes visible.
 */

import type { Finding, Report, Severity, Snapshot } from './types.js';

type Detector = (s: Snapshot) => Finding[];

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

function f(
  id: string,
  title: string,
  severity: Severity,
  category: Finding['category'],
  explains: string,
  evidence: Record<string, unknown>,
): Finding {
  return { id, title, severity, category, explains, evidence, key: `${id}:${JSON.stringify(evidence)}` };
}

/* ------------------------------------------------------- cross-source rules */

/** UA OS token vs everything else that encodes an OS. */
const uaOsConsistency: Detector = (s) => {
  const out: Finding[] = [];
  const ua = s.ua.value;
  const gl = s.webgl.value;
  const hw = s.hardware.value;
  if (!ua) return out;

  const isWin = ua.ua.includes('Windows NT');
  const isMac = ua.ua.includes('Macintosh') || ua.ua.includes('Mac OS X');
  const isLinux = ua.ua.includes('Linux') && !ua.ua.includes('Android');
  const claimed = isWin ? 'windows' : isMac ? 'macos' : isLinux ? 'linux' : 'unknown';

  // 1. UA vs navigator.platform
  const platformOs = ua.platform === 'Win32' ? 'windows'
    : ua.platform === 'MacIntel' ? 'macos'
    : ua.platform.startsWith('Linux') ? 'linux'
    : 'unknown';
  if (claimed !== 'unknown' && platformOs !== 'unknown' && claimed !== platformOs) {
    out.push(f('ua-platform-mismatch', 'UA OS and navigator.platform disagree', 'critical', 'cross-source',
      'Every desktop browser keeps navigator.platform in lockstep with the OS token in the user agent. Detectors read both and treat a mismatch as proof of spoofing.',
      { uaOs: claimed, platform: ua.platform, platformOs }));
  }

  // 2. UA vs Client Hints platform
  if (ua.uaDataPlatform) {
    const chOs = ua.uaDataPlatform === 'Windows' ? 'windows'
      : ua.uaDataPlatform === 'macOS' ? 'macos'
      : ua.uaDataPlatform === 'Linux' ? 'linux' : 'unknown';
    if (claimed !== 'unknown' && chOs !== 'unknown' && claimed !== chOs) {
      out.push(f('ua-clienthints-mismatch', 'UA OS and User-Agent Client Hints platform disagree', 'critical', 'cross-source',
        'sec-ch-ua-platform (and userAgentData.platform) describe the OS. A UA string for one OS with Client Hints for another is the single most common spoofing error.',
        { uaOs: claimed, chPlatform: ua.uaDataPlatform }));
    }
  }

  // 3. UA vs WebGL GPU vendor. Apple GPUs only exist on macOS.
  if (gl?.supported && gl.unmaskedVendor) {
    const appleGpu = gl.unmaskedVendor.includes('Apple');
    const nvidiaGpu = gl.unmaskedVendor.includes('NVIDIA');
    const amdGpu = gl.unmaskedVendor.includes('AMD');
    const intelGpu = gl.unmaskedVendor.includes('Intel');
    if (appleGpu && claimed !== 'macos' && claimed !== 'unknown') {
      out.push(f('gpu-os-mismatch', 'Apple GPU reported on a non-Apple OS', 'critical', 'cross-source',
        'Apple GPUs appear only on macOS. An ANGLE Metal renderer alongside a Windows or Linux UA cannot occur on real hardware.',
        { uaOs: claimed, unmaskedVendor: gl.unmaskedVendor, unmaskedRenderer: gl.unmaskedRenderer }));
    }
    if ((nvidiaGpu || amdGpu) && claimed === 'macos') {
      out.push(f('gpu-os-mismatch-mac', 'Discrete NVIDIA/AMD GPU string on macOS', 'high', 'cross-source',
        'Current macOS machines expose Apple GPUs through ANGLE Metal. An NVIDIA or AMD desktop renderer string on macOS is either a very old Intel Mac with an eGPU (rare) or a spoof.',
        { uaOs: claimed, unmaskedVendor: gl.unmaskedVendor, unmaskedRenderer: gl.unmaskedRenderer }));
    }
    // 4. Renderer vs vendor pair.
    if (gl.unmaskedRenderer && gl.unmaskedVendor) {
      const rendererSays = gl.unmaskedRenderer.includes('NVIDIA') ? 'NVIDIA'
        : gl.unmaskedRenderer.includes('AMD') ? 'AMD'
        : gl.unmaskedRenderer.includes('Apple') ? 'Apple'
        : gl.unmaskedRenderer.includes('Intel') ? 'Intel' : null;
      const vendorSays = nvidiaGpu ? 'NVIDIA' : amdGpu ? 'AMD' : appleGpu ? 'Apple' : intelGpu ? 'Intel' : null;
      if (rendererSays && vendorSays && rendererSays !== vendorSays) {
        out.push(f('gpu-vendor-renderer-split', 'WebGL vendor and renderer name different GPU makers', 'high', 'cross-source',
          'The unmasked vendor and renderer strings are produced by one driver. A split between them means one of the two was rewritten.',
          { unmaskedVendor: gl.unmaskedVendor, unmaskedRenderer: gl.unmaskedRenderer }));
      }
    }
  }

  // 5. Client Hints high-entropy vs UA version.
  if (ua.uaFullVersion) {
    const uaMajor = /Chrome\/(\d+)\./.exec(ua.ua)?.[1];
    const chMajor = ua.uaFullVersion.split('.')[0];
    if (uaMajor && chMajor && uaMajor !== chMajor) {
      out.push(f('ua-version-split', 'UA Chrome version and uaFullVersion disagree', 'high', 'cross-source',
        'Both are generated by the same browser from the same version. Detectors compare the major version to detect a rewritten UA.',
        { uaMajor, uaFullVersion: ua.uaFullVersion }));
    }
  }

  // 6. Architecture vs GPU family.
  if (ua.ah && gl?.unmaskedRenderer) {
    const appleSilicon = gl.unmaskedRenderer.includes('Apple M');
    const d3d = gl.unmaskedRenderer.includes('D3D11');
    if (appleSilicon && ua.ah !== 'arm') {
      out.push(f('arch-gpu-split', 'Apple silicon GPU with x86 architecture claim', 'high', 'cross-source',
        'Apple M-series GPUs only appear with arm64. Client Hints reporting x86 while the renderer says Apple M is impossible.',
        { architecture: ua.ah, unmaskedRenderer: gl.unmaskedRenderer }));
    }
    if (d3d && ua.ah === 'arm' && claimed === 'windows') {
      out.push(f('arch-d3d-split', 'ANGLE D3D11 renderer with arm64 on Windows', 'medium', 'cross-source',
        'D3D11 ANGLE renderers are the x86/x64 path; Windows-on-ARM reports a different renderer family. Rare but readable.',
        { architecture: ua.ah, unmaskedRenderer: gl.unmaskedRenderer }));
    }
  }

  // 7. Cores vs memory sanity.
  if (hw) {
    const cores = hw.hardwareConcurrency;
    const mem = hw.deviceMemory;
    if (cores !== undefined && cores > 0) {
      if (cores > 128) {
        out.push(f('cores-impossible', 'Impossible hardwareConcurrency', 'high', 'unnatural',
          'No consumer machine reports more than 128 logical processors; values above that are a spoofing artefact.',
          { cores }));
      }
      if (mem !== null && cores === 2 && mem >= 32) {
        out.push(f('cores-memory-split', 'Two cores with 32 GB of memory', 'medium', 'cross-source',
          'Memory and core count correlate with the device class. Two cores with 32 GB describes no shipping machine.',
          { cores, deviceMemory: mem }));
      }
      if (mem !== null && cores >= 32 && mem <= 2) {
        out.push(f('cores-memory-split-2', '32+ cores with 2 GB of memory', 'medium', 'cross-source',
          'No real machine pairs a 32-core CPU with 2 GB of RAM.', { cores, deviceMemory: mem }));
      }
    }
  }

  // 8. Touch support vs OS.
  if (ua.maxTouchPoints > 0 && claimed === 'windows' && hw && hw.hardwareConcurrency > 20) {
    out.push(f('touch-workstation', 'Touch points on a workstation-class Windows machine', 'low', 'cross-source',
      'High-core Windows desktops rarely report touch. Not proof on its own; worth a second look.',
      { maxTouchPoints: ua.maxTouchPoints, cores: hw.hardwareConcurrency }));
  }

  // 9. Fonts vs OS.
  if (s.fonts.value) {
    const detected = new Set(s.fonts.value.detected.map((x) => x.toLowerCase()));
    const hasWindowsCore = ['segoe ui', 'tahoma', 'calibri', 'consolas'].filter((x) => detected.has(x)).length;
    const hasMacCore = ['menlo', 'monaco', 'optima', 'helvetica neue'].filter((x) => detected.has(x)).length;
    if (claimed === 'macos' && hasWindowsCore >= 3 && hasMacCore === 0) {
      out.push(f('fonts-os-mismatch', 'Windows font set on a macOS profile', 'high', 'cross-source',
        'Font presence is one of the most reliable OS signals. A macOS UA with the Windows core font set and none of the macOS set is a spoof.',
        { detected: s.fonts.value.detected.slice(0, 20), uaOs: claimed }));
    }
    if (claimed === 'windows' && hasMacCore >= 3 && hasWindowsCore === 0) {
      out.push(f('fonts-os-mismatch-win', 'macOS font set on a Windows profile', 'high', 'cross-source',
        'See above, in the other direction.', { detected: s.fonts.value.detected.slice(0, 20), uaOs: claimed }));
    }
  }

  // 10. Locale vs timezone vs language.
  if (s.locale.value) {
    const lang = s.ua.value?.languages[0] ?? '';
    const tz = s.locale.value.timeZone;
    const langRegion = lang.split('-')[1];
    const tzRegion = tz.split('/')[0];
    const expectedRegion: Record<string, string[]> = {
      CN: ['Asia'], TW: ['Asia'], HK: ['Asia'], JP: ['Asia'], KR: ['Asia'],
      US: ['America'], CA: ['America'], BR: ['America'], MX: ['America'],
      GB: ['Europe'], DE: ['Europe'], FR: ['Europe'], ES: ['Europe'], IT: ['Europe'],
      NL: ['Europe'], RU: ['Europe'], IN: ['Asia'], AU: ['Australia'],
    };
    const allowed = langRegion ? expectedRegion[langRegion] : undefined;
    if (allowed && !allowed.includes(tzRegion ?? '')) {
      out.push(f('locale-timezone-split', 'Language region and timezone are in different parts of the world', 'high', 'cross-source',
        'Browsers inherit both language and timezone from the OS locale settings. A zh-CN browser in America/Chicago is rare enough that trackers score it heavily.',
        { language: lang, timeZone: tz }));
    }
  }

  // 11. Worker vs window agreement.
  if (s.worker?.ok && s.worker.value) {
    const w = s.worker.value;
    if (ua && w.ua && w.ua !== ua.ua) {
      out.push(f('worker-ua-split', 'Worker sees a different user agent than the window', 'critical', 'cross-source',
        'A Worker and its creating window share one navigator configuration. A difference means one realm was patched and the other was not.',
        { windowUa: ua.ua, workerUa: w.ua }));
    }
    if (hw && w.hardwareConcurrency !== null && w.hardwareConcurrency !== hw.hardwareConcurrency) {
      out.push(f('worker-cores-split', 'Worker sees a different core count than the window', 'critical', 'cross-source',
        'Same reasoning as the user agent: one process, one value.',
        { windowCores: hw.hardwareConcurrency, workerCores: w.hardwareConcurrency }));
    }
    if (w.timeZone && s.locale.value && w.timeZone !== s.locale.value.timeZone) {
      out.push(f('worker-tz-split', 'Worker timezone differs from the window timezone', 'high', 'cross-source',
        'Intl resolves from the same OS setting in both realms.',
        { windowTz: s.locale.value.timeZone, workerTz: w.timeZone }));
    }
    if (w.error) {
      out.push(f('worker-error', 'The collector worker failed', 'low', 'informational',
        'A worker may fail for benign reasons (CSP, module type). Recorded for completeness.',
        { error: w.error }));
    }
  }

  return out;
};

/* --------------------------------------------------------------- screen */

const screenRules: Detector = (s) => {
  const out: Finding[] = [];
  const sc = s.screen.value;
  if (!sc) return out;

  if (sc.innerWidth > sc.width) {
    out.push(f('viewport-wider-than-screen', 'Viewport is wider than the screen', 'critical', 'unnatural',
      'The CSS viewport cannot exceed the physical screen. Any fingerprinting script that reads both catches this immediately.',
      { innerWidth: sc.innerWidth, screenWidth: sc.width }));
  }
  if (sc.innerHeight > sc.height) {
    out.push(f('viewport-taller-than-screen', 'Viewport is taller than the screen', 'high', 'unnatural',
      'Same as width, allowing for browser chrome above the document.',
      { innerHeight: sc.innerHeight, screenHeight: sc.height }));
  }
  if (sc.availWidth > sc.width || sc.availHeight > sc.height) {
    out.push(f('avail-exceeds-screen', 'availWidth/availHeight exceed width/height', 'critical', 'unnatural',
      'The available area is the screen minus OS chrome; it can never be larger.',
      { avail: [sc.availWidth, sc.availHeight], screen: [sc.width, sc.height] }));
  }
  if (sc.availWidth === sc.width && sc.availHeight === sc.height) {
    out.push(f('no-os-chrome', 'No OS chrome reserved from the screen area', 'medium', 'unnatural',
      'Every desktop OS reserves space for a taskbar, menubar or dock. availWidth/Height equal to width/height describes a kiosk, not a desktop.',
      { width: sc.width, height: sc.height, availWidth: sc.availWidth, availHeight: sc.availHeight }));
  }
  if (sc.dpr <= 0 || sc.dpr > 4) {
    out.push(f('dpr-impossible', 'Impossible devicePixelRatio', 'high', 'unnatural',
      'devicePixelRatio is a positive scale factor; values above 4 exist only on exotic embedded displays.',
      { dpr: sc.dpr }));
  }
  // Orientation agreement.
  if (sc.orientationType) {
    const shouldBeLandscape = sc.width >= sc.height;
    const isLandscape = sc.orientationType.startsWith('landscape');
    if (shouldBeLandscape !== isLandscape) {
      out.push(f('orientation-split', 'Screen orientation type contradicts screen dimensions', 'high', 'cross-source',
        'orientation.type is derived from the panel dimensions; they cannot disagree.',
        { orientation: sc.orientationType, width: sc.width, height: sc.height }));
    }
  }
  // Visual viewport scale should be 1 for a desktop browser zoom of 100%.
  if (sc.visualViewportScale !== null && sc.visualViewportScale !== 1) {
    out.push(f('visual-viewport-zoom', 'Visual viewport is zoomed', 'low', 'informational',
      'Not an inconsistency by itself; recorded because some detectors use it to normalise other measurements.',
      { scale: sc.visualViewportScale }));
  }
  return out;
};

/* --------------------------------------------------------------- canvas */

const canvasRules: Detector = (s) => {
  const out: Finding[] = [];
  const c = s.canvas.value;
  if (!c) return out;

  // Flat fills must stay flat on any real rasteriser.
  if (c.solidFillColours !== 1) {
    out.push(f('canvas-flat-not-flat', 'A solid fill read back as more than one colour', 'critical', 'unnatural',
      'Anti-aliasing does not apply to an axis-aligned rectangle on an integer boundary. Per-pixel noise on a flat fill is the classic signature of canvas farbling.',
      { colours: c.solidFillColours }));
  }
  if (c.checkerColours !== 2) {
    out.push(f('canvas-checker-not-two', 'A two-colour checkerboard read back with extra colours', 'high', 'unnatural',
      'Same reasoning as a solid fill: flat regions must be bit-exact.',
      { colours: c.checkerColours }));
  }
  // Two independent drawings of the same probe must be identical.
  if (!c.stable) {
    out.push(f('canvas-unstable', 'Two renders of the same drawing differ', 'critical', 'instability',
      'A real rasteriser is deterministic. Within one page load, drawing the same thing twice must produce identical bytes; if it does not, the fingerprint changes on every read.',
      { textHash: c.textHash, dataUrlHash: c.dataUrlHash }));
  }
  /**
   * The two readout paths must describe the same image. They are never bit
   * identical — PNG round-tripping this drawing moves pixels by up to 2 LSB on
   * a stock browser — so the test is a tolerance, not equality. A defence that
   * perturbs one path and not the other shows a delta of tens or hundreds.
   */
  if (c.roundTripMaxDelta > 6) {
    out.push(f('canvas-path-split', 'toDataURL and getImageData describe different images', 'critical', 'cross-source',
      'Both read the same backing store, so decoding a data URL must reproduce the pixels getImageData returns, up to PNG codec error (measured at <=2 LSB on an unmodified browser). A larger difference means one path was perturbed and the other was not.',
      { imageDataHash: c.imageDataHash, roundTripHash: c.roundTripHash, maxDelta: c.roundTripMaxDelta }));
  }
  if (c.maxSelfDelta > 2) {
    out.push(f('canvas-visible-delta', 'Two renders differ by a visible amount', 'high', 'unnatural',
      'Independent renders of one drawing should differ only by harmless rounding, never by more than a couple of LSBs.',
      { maxSelfDelta: c.maxSelfDelta }));
  }
  return out;
};

/* ---------------------------------------------------------------- webgl */

const webglRules: Detector = (s) => {
  const out: Finding[] = [];
  const g = s.webgl.value;
  if (!g || !g.supported) return out;

  // Limits must match the renderer family.
  const integrated = /UHD|Iris|HD Graphics|Apple M/.test(g.unmaskedRenderer ?? '');
  const discrete = /RTX|GeForce|Radeon|RX |Quadro/.test(g.unmaskedRenderer ?? '');
  if (integrated && g.maxTextureSize !== null && g.maxTextureSize > 16384) {
    out.push(f('webgl-limits-discrete', 'Integrated GPU with discrete-class texture limits', 'medium', 'cross-source',
      'Integrated GPUs and discrete GPUs expose different MAX_TEXTURE_SIZE and uniform limits. A renderer string for a UHD part with 32768 texture size is a rewritten parameter.',
      { renderer: g.unmaskedRenderer, maxTextureSize: g.maxTextureSize }));
  }
  if (discrete && g.maxTextureSize !== null && g.maxTextureSize < 8192) {
    out.push(f('webgl-limits-too-low', 'Discrete GPU with implausibly low texture limits', 'medium', 'cross-source',
      'Every discrete GPU in the last decade supports at least 16384.',
      { renderer: g.unmaskedRenderer, maxTextureSize: g.maxTextureSize }));
  }
  // Viewport dims must be square and large enough.
  if (g.maxViewport && (g.maxViewport[0] !== g.maxViewport[1] || g.maxViewport[0]! < 16384)) {
    out.push(f('webgl-viewport-odd', 'MAX_VIEWPORT_DIMS is implausible', 'medium', 'unnatural',
      'Desktop drivers report a square, large viewport limit (typically 32767x32767).',
      { maxViewport: g.maxViewport }));
  }
  // Precision must be the desktop value, not a mobile one.
  if (g.precision.vertexHigh !== null && g.precision.vertexHigh < 23) {
    out.push(f('webgl-precision-low', 'Vertex float precision below desktop class', 'medium', 'cross-source',
      'Desktop GPUs report 23 bits of precision for highp. A lower value means a mobile-oriented profile leaked in, or the value was randomised without matching the GPU family.',
      { vertexHigh: g.precision.vertexHigh }));
  }
  // WebGL canvas and 2D canvas must yield the same pixels for the same drawing.
  if (g.pixelHash && g.viaCanvasHash && g.pixelHash !== g.viaCanvasHash) {
    out.push(f('webgl-thread-split', 'readPixels output and the 2D canvas copy disagree', 'high', 'cross-source',
      'Copying a WebGL canvas into a 2D canvas and reading it is a standard cross-check (normalised for GL\'s bottom-up row order). If perturbation applies to one path with a different seed or without the row flip, the two diverge and the detector knows an API was rewritten.',
      { readPixelsHash: g.pixelHash, canvasHash: g.viaCanvasHash }));
  }
  if (!g.extensions || g.extensions.length === 0) {
    out.push(f('webgl-no-extensions', 'WebGL reports no supported extensions', 'medium', 'unnatural',
      'Every desktop GPU exposes a long extension list. An empty list is a strong signal of an incomplete spoof.',
      {}));
  }
  return out;
};

/* ---------------------------------------------------------------- audio */

const audioRules: Detector = (s) => {
  const out: Finding[] = [];
  const a = s.audio?.value;
  if (!a) return out;
  if (!a.stable) {
    out.push(f('audio-unstable', 'Two audio renders of the same graph differ', 'high', 'instability',
      'OfflineAudioContext rendering is deterministic. A profile that perturbs audio with a counter or time-based seed breaks this.',
      {}));
  }
  if (a.sampleCount === 0) {
    out.push(f('audio-empty', 'Audio render produced no samples', 'medium', 'unnatural',
      'An OfflineAudioContext always renders the requested length.', {}));
  }
  // Sum of this graph is normally a small non-zero float. An exactly-zero sum
  // means the render silently failed or output was zeroed.
  if (a.sum === 0) {
    out.push(f('audio-silent', 'Audio fingerprint render summed to exactly zero', 'high', 'unnatural',
      'The canonical graph (triangle osc -> compressor) always produces a non-zero tail.',
      { sum: a.sum }));
  }
  return out;
};

/* ---------------------------------------------------------------- fonts */

const fontRules: Detector = (s) => {
  const out: Finding[] = [];
  const ft = s.fonts.value;
  if (!ft) return out;
  if (ft.disagreements.length > 0) {
    out.push(f('font-check-measure-split', 'A font measures as present but check() says unavailable', 'high', 'cross-source',
      'Measurement and check() read the same font database. check() returning false for a family that clearly renders with its own metrics means one of the two answers was rewritten.',
      { disagreements: ft.disagreements }));
  }
  if (ft.detected.length === 0) {
    out.push(f('fonts-none-detected', 'No probe fonts detected at all', 'high', 'unnatural',
      'Every real OS has at least Arial or Helvetica or DejaVu Sans. Zero detected families means the measurement path is broken or actively blocked.',
      {}));
  }
  if (ft.detected.length > 60) {
    out.push(f('fonts-implausibly-many', 'Implausibly many fonts detected', 'medium', 'unnatural',
      'Consumer machines have between 20 and 50 detectable families from a probe list this size; far more suggests measurement noise being read as presence.',
      { count: ft.detected.length }));
  }
  return out;
};

/* ------------------------------------------------------------- native */

const nativeRules: Detector = (s) => {
  const out: Finding[] = [];
  const n = s.native.value;
  if (!n) return out;

  if (n.nonNative.length > 0) {
    out.push(f('native-toString', 'Patched functions are not disguised as native code', 'critical', 'unnatural',
      'Function.prototype.toString returning JavaScript source for a built-in is the single most reliable tampering signal. Every function in the list below is exposed.',
      { functions: n.nonNative }));
  }
  if (n.ownProps.length > 0) {
    out.push(f('native-own-props', 'Expected prototype members are missing', 'high', 'unnatural',
      'Replacing a prototype method by defining an instance property, or deleting the original, changes the shape pages inspect.',
      { issues: n.ownProps }));
  }
  if (n.descriptorAnomalies.length > 0) {
    out.push(f('native-descriptors', 'Property descriptors changed shape', 'medium', 'unnatural',
      'Built-in methods are writable data properties. Turning one into a getter, or making it non-writable, is detectable through getOwnPropertyDescriptor alone.',
      { issues: n.descriptorAnomalies }));
  }
  if (n.stackLeaks.length > 0) {
    out.push(f('native-stack-leak', 'An extension URL appears in an Error stack', 'high', 'unnatural',
      'Stack traces are a common leak path for injected code. Seeing chrome-extension:// or an injected bundle name tells the page exactly what happened.',
      { markers: n.stackLeaks }));
  }
  if (n.extraKeys.length > 0) {
    out.push(f('native-extra-keys', 'Prototype key sets changed', 'medium', 'unnatural',
      'Adding or removing a key on a built-in prototype changes Object.getOwnPropertyNames, which pages snapshot and compare.',
      { diffs: n.extraKeys }));
  }
  return out;
};

/* ------------------------------------------------------------- stability */

/**
 * Instability needs two snapshots; the panel passes the previous one through a
 * module-level slot (see runDetectors' second argument).
 */
export function stabilityDetector(prev: Snapshot | null, cur: Snapshot): Finding[] {
  const out: Finding[] = [];
  if (!prev) return out;

  const sameSite = siteOf(prev.url) === siteOf(cur.url);
  if (!sameSite) return out;

  const checks: Array<[string, string, unknown, unknown]> = [
    ['ua', 'user agent', prev.ua.value?.ua, cur.ua.value?.ua],
    ['cores', 'core count', prev.hardware.value?.hardwareConcurrency, cur.hardware.value?.hardwareConcurrency],
    ['canvas', 'canvas hash', prev.canvas.value?.imageDataHash, cur.canvas.value?.imageDataHash],
    ['webgl', 'WebGL renderer', prev.webgl.value?.unmaskedRenderer, cur.webgl.value?.unmaskedRenderer],
    ['audio', 'audio hash', prev.audio?.value?.hash, cur.audio?.value?.hash],
    ['tz', 'timezone', prev.locale.value?.timeZone, cur.locale.value?.timeZone],
    ['fonts', 'detected font set', prev.fonts.value?.detected.join(','), cur.fonts.value?.detected.join(',')],
  ];
  for (const [id, label, a, b] of checks) {
    if (a === undefined || b === undefined) continue;
    if (a !== b) {
      out.push(f(`unstable-${id}`, `${label} changed between two snapshots on the same site`, 'critical', 'instability',
        'A fingerprint must be stable within a session. A value that changes when re-read is both a fingerprint and a spoofing signal, and is the failure mode that makes users stand out most.',
        { before: a, after: b }));
    }
  }
  return out;
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------ orchestration */

const DETECTORS: Detector[] = [
  uaOsConsistency,
  screenRules,
  canvasRules,
  webglRules,
  audioRules,
  fontRules,
  nativeRules,
];

export function runDetectors(snapshot: Snapshot, previous: Snapshot | null = null): Report {
  const findings: Finding[] = [];
  for (const d of DETECTORS) {
    try {
      findings.push(...d(snapshot));
    } catch (e) {
      findings.push(f('detector-crash', 'A detector threw', 'low', 'informational',
        'A detector failing is not itself a fingerprint problem, but it means part of this report is missing.',
        { error: String((e as Error)?.message ?? e) }));
    }
  }
  findings.push(...stabilityDetector(previous, snapshot));

  // De-duplicate by key, keeping the first (detectors run cheapest first).
  const seen = new Set<string>();
  const unique = findings.filter((x) => {
    if (seen.has(x.key)) return false;
    seen.add(x.key);
    return true;
  });

  unique.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const score = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  for (const x of unique) {
    if (x.category === 'informational') score.informational++;
    else score[x.severity]++;
  }

  return { buildId: null, snapshot, findings: unique, score };
}

export { DETECTORS };
