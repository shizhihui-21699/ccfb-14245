/**
 * Lab collectors.
 *
 * Each collector measures one source the way a real fingerprinting script would,
 * including the redundant paths a careful attacker uses to cross-check itself:
 * canvas via `toDataURL` *and* `getImageData` *and* a round trip; WebGL via
 * `readPixels` *and* via a 2D canvas copy; fonts via `check()` *and* measurement.
 * Redundancy is the point: a defender that faked only one path is caught here.
 */

import type {
  AudioFacts, CanvasFacts, Collected, FontFacts, HardwareFacts, LocaleFacts,
  MediaFacts, NativeFacts, ScreenFacts, Snapshot, UaFacts, WebglFacts, WorkerFacts,
} from './types.js';

async function collect<T>(fn: () => T | Promise<T>): Promise<Collected<T>> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: +(performance.now() - t0).toFixed(2) };
  } catch (e) {
    return { ok: false, value: null, error: String((e as Error)?.message ?? e), ms: +(performance.now() - t0).toFixed(2) };
  }
}

/* ------------------------------------------------------------------ hashing */

/** FNV-1a over a string, hex. Small and dependency-free; collisions don't matter here. */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function hashBytes(bytes: Uint8ClampedArray | Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* --------------------------------------------------------------------- ua */

export async function collectUa(): Promise<Collected<UaFacts>> {
  return collect(async () => {
    const nav = navigator as Navigator & {
      userAgentData?: {
        brands?: Array<{ brand: string; version: string }>;
        platform?: string;
        mobile?: boolean;
        getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>>;
      };
      doNotTrack?: string | null;
    };
    let hev: Record<string, unknown> = {};
    let brands: Array<{ brand: string; version: string }> | null = null;
    if (nav.userAgentData) {
      brands = Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands.map((b) => ({ ...b })) : null;
      if (typeof nav.userAgentData.getHighEntropyValues === 'function') {
        hev = await nav.userAgentData.getHighEntropyValues([
          'architecture', 'bitness', 'uaFullVersion', 'fullVersionList',
          'model', 'platform', 'platformVersion', 'wow64',
        ]);
      }
    }
    return {
      ua: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      brands,
      uaDataPlatform: nav.userAgentData?.platform ?? null,
      uaFullVersion: (hev['uaFullVersion'] as string) ?? null,
      ah: (hev['architecture'] as string) ?? null,
      bitness: (hev['bitness'] as string) ?? null,
      wow64: (hev['wow64'] as boolean) ?? null,
      mobile: nav.userAgentData?.mobile ?? null,
      webdriver: navigator.webdriver === true,
      pdfViewerEnabled: navigator.pdfViewerEnabled === true,
      plugins: navigator.plugins?.length ?? 0,
      mimeTypes: navigator.mimeTypes?.length ?? 0,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      doNotTrack: nav.doNotTrack ?? null,
      language: navigator.language,
      languages: Array.from(navigator.languages ?? []),
      cookiesEnabled: navigator.cookieEnabled,
    };
  });
}

/* ----------------------------------------------------------------- screen */

export async function collectScreen(): Promise<Collected<ScreenFacts>> {
  return collect(() => {
    const so = (screen as Screen & { orientation?: ScreenOrientation }).orientation;
    return {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      dpr: devicePixelRatio,
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      orientationType: so?.type ?? null,
      orientationAngle: typeof so?.angle === 'number' ? so.angle : null,
      visualViewportScale: window.visualViewport?.scale ?? null,
      refreshHz: null,
    };
  });
}

/** Estimate display refresh rate by counting rAF callbacks for a short window. */
export async function measureRefreshHz(ms = 400): Promise<number | null> {
  if (typeof requestAnimationFrame !== 'function') return null;
  return new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = (): void => {
      frames++;
      if (performance.now() - start < ms) requestAnimationFrame(tick);
      else resolve(Math.round((frames * 1000) / (performance.now() - start)));
    };
    requestAnimationFrame(tick);
  });
}

/* --------------------------------------------------------------- hardware */

export async function collectHardware(): Promise<Collected<HardwareFacts>> {
  return collect(async () => {
      const nav = navigator as unknown as {
      deviceMemory?: number;
      getBattery?: () => Promise<{ charging: boolean; level: number; chargingTime: number; dischargingTime: number }>;
      connection?: { effectiveType: string; rtt: number; downlink: number; saveData: boolean };
    };
    let battery: HardwareFacts['battery'] = null;
    let batteryError: string | null = null;
    if (typeof nav.getBattery === 'function') {
      try {
        const b = await nav.getBattery();
        battery = {
          charging: b.charging,
          level: b.level,
          chargingTime: b.chargingTime,
          dischargingTime: b.dischargingTime,
        };
      } catch (e) {
        batteryError = (e as Error).name || String(e);
      }
    }
    return {
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: nav.deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints,
      battery,
      batteryError,
      connection: nav.connection
        ? {
            effectiveType: nav.connection.effectiveType,
            rtt: nav.connection.rtt,
            downlink: nav.connection.downlink,
            saveData: nav.connection.saveData,
          }
        : null,
    };
  });
}

/* ----------------------------------------------------------------- canvas */

/** The shared probe drawing — see probe-drawing.ts for why it is shared. */
import { drawProbe, PROBE_WIDTH, PROBE_HEIGHT } from './probe-drawing.js';

export async function collectCanvas(): Promise<Collected<CanvasFacts>> {
  return collect(() => {
    const W = PROBE_WIDTH;
    const H = PROBE_HEIGHT;
    const make = (): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      drawProbe(ctx);
      return c;
    };

    const a = make();
    const b = make();
    const dataUrlA = a.toDataURL();
    const dataUrlB = b.toDataURL();

    const ctx = a.getContext('2d')!;
    const imgData = ctx.getImageData(0, 0, W, H);
    const rawHash = hashBytes(imgData.data);

    // Round trip: decode the encoded output and read it back.
    const rt = document.createElement('canvas');
    rt.width = W;
    rt.height = H;
    const rtCtx = rt.getContext('2d')!;
    const img = new Image();
    // Synchronous decode is not available; the panel caller awaits this below.
    void img;

    // Solid fill: must be exactly one colour on any real browser.
    const solid = document.createElement('canvas');
    solid.width = 32;
    solid.height = 32;
    const sctx = solid.getContext('2d')!;
    sctx.fillStyle = '#ff6600';
    sctx.fillRect(0, 0, 32, 32);
    const solidColours = countColours(sctx.getImageData(0, 0, 32, 32).data, 32, 32);

    // Checkerboard: two colours, both flat.
    const check = document.createElement('canvas');
    check.width = 32;
    check.height = 32;
    const cctx = check.getContext('2d')!;
    for (let y = 0; y < 32; y += 8) {
      for (let x = 0; x < 32; x += 8) {
        cctx.fillStyle = ((x >> 3) + (y >> 3)) % 2 ? '#ffffff' : '#000000';
        cctx.fillRect(x, y, 8, 8);
      }
    }
    const checkerColours = countColours(cctx.getImageData(0, 0, 32, 32).data, 32, 32);

    // Max self-delta between two independent drawings of the same probe.
    const imgB = b.getContext('2d')!.getImageData(0, 0, W, H);
    let maxSelfDelta = 0;
    for (let i = 0; i < imgData.data.length; i++) {
      maxSelfDelta = Math.max(maxSelfDelta, Math.abs((imgData.data[i] ?? 0) - (imgB.data[i] ?? 0)));
    }

    return {
      textHash: hash32(dataUrlA),
      imageDataHash: rawHash,
      dataUrlHash: hash32(dataUrlA),
      roundTripHash: '',
      roundTripMaxDelta: 0,
      solidFillColours: solidColours,
      checkerColours,
      maxSelfDelta,
      stable: dataUrlA === dataUrlB,
      width: W,
      height: H,
    };
  });
}

/**
 * Second half of the canvas collector: decode the data URL and compare the
 * decoded pixels against the live canvas.
 *
 * Returns both a hash and the max per-channel delta, because a hash equality
 * check is the wrong test here: PNG round-tripping this drawing is not
 * bit-exact even on an untouched browser (measured up to 2 LSB on stock
 * Chrome). The meaningful question is whether the two paths describe the same
 * image, i.e. the difference stays within codec error. A farbling bug that
 * touches one path and not the other shows up as a delta of tens, not 2.
 */
export async function roundTripCanvas(
  dataUrl: string,
  reference: Uint8ClampedArray,
): Promise<{ hash: string; maxDelta: number; meanDelta: number }> {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  let maxDelta = 0;
  let sum = 0;
  for (let i = 0; i < d.data.length; i++) {
    const delta = Math.abs((d.data[i] ?? 0) - (reference[i] ?? 0));
    maxDelta = Math.max(maxDelta, delta);
    sum += delta;
  }
  return {
    hash: hashBytes(d.data),
    maxDelta,
    meanDelta: Number((sum / Math.max(1, d.data.length)).toFixed(4)),
  };
}

function countColours(data: Uint8ClampedArray, w: number, h: number): number {
  const seen = new Set<number>();
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    seen.add(((data[o] ?? 0) << 16) | ((data[o + 1] ?? 0) << 8) | (data[o + 2] ?? 0));
  }
  return seen.size;
}

/* ------------------------------------------------------------------ webgl */

export async function collectWebgl(): Promise<Collected<WebglFacts>> {
  return collect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) {
      return {
        supported: false, vendor: null, renderer: null, unmaskedVendor: null, unmaskedRenderer: null,
        version: null, shadingLanguageVersion: null, maxTextureSize: null, maxRenderbufferSize: null,
        maxViewport: null, maxVertexAttribs: null, maxVaryingVectors: null, maxCombinedTextureUnits: null,
        maxTextureUnits: null, maxFragmentUniformVectors: null, maxVertexUniformVectors: null,
        extensions: null, precision: { vertexHigh: null, fragmentHigh: null }, pixelHash: null,
        viaCanvasHash: null, webgl2: false,
      } satisfies WebglFacts;
    }
    const isWebgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');

    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    const vp = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
    const fp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);

    // Render a gradient through a shader and read the pixels back.
    let pixelHash: string | null = null;
    let viaCanvasHash: string | null = null;
    try {
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, `precision highp float;
        void main(){ vec2 uv = gl_FragCoord.xy / 64.0; gl_FragColor = vec4(uv.x, uv.y, 0.5 + 0.5 * sin(uv.x * 20.0), 1.0); }`);
      gl.compileShader(fs);
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 64, 64);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const pixels = new Uint8Array(64 * 64 * 4);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      /**
       * GL's origin is bottom-left; a 2D canvas is top-left. The two readouts
       * are the same image but not the same byte order, so the comparison must
       * normalise the row order first — otherwise an unmodified browser fails
       * this check (verified against a baseline run), and the detector blames
       * the defence instead of its own math.
       */
      const flipped = new Uint8Array(pixels.length);
      for (let y = 0; y < 64; y++) {
        flipped.set(pixels.subarray(y * 64 * 4, (y + 1) * 64 * 4), (63 - y) * 64 * 4);
      }
      pixelHash = hashBytes(flipped);

      const c2 = document.createElement('canvas');
      c2.width = 64;
      c2.height = 64;
      const ctx2 = c2.getContext('2d')!;
      ctx2.drawImage(canvas, 0, 0);
      viaCanvasHash = hashBytes(ctx2.getImageData(0, 0, 64, 64).data);
    } catch {
      // A shader failure is itself informative; leave hashes null.
    }

    return {
      supported: true,
      vendor: String(gl.getParameter(gl.VENDOR)),
      renderer: String(gl.getParameter(gl.RENDERER)),
      unmaskedVendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
      unmaskedRenderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
      version: String(gl.getParameter(gl.VERSION)),
      shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      maxViewport: dims ? [dims[0] ?? 0, dims[1] ?? 0] : null,
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
      maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS) as number,
      maxCombinedTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
      maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number,
      maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) as number,
      extensions: gl.getSupportedExtensions(),
      precision: {
        vertexHigh: vp ? vp.precision : null,
        fragmentHigh: fp ? fp.precision : null,
      },
      pixelHash,
      viaCanvasHash,
      webgl2: isWebgl2,
    };
  });
}

/* ------------------------------------------------------------------ audio */

export async function collectAudio(): Promise<Collected<AudioFacts>> {
  return collect(async () => {
    const render = async (): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext(1, 5000, 44100);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value = 40;
      comp.ratio.value = 12;
      comp.attack.value = 0;
      comp.release.value = 0.25;
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      return buffer.getChannelData(0).slice(0, 5000);
    };
    const a = await render();
    const b = await render();
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(a[i] ?? 0);
    let maxDelta = 0;
    for (let i = 0; i < a.length; i++) maxDelta = Math.max(maxDelta, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    return {
      hash: hashBytes(new Uint8Array(a.buffer.slice(0))),
      sum,
      sampleCount: a.length,
      stable: maxDelta === 0,
    };
  });
}

/* ------------------------------------------------------------------ fonts */

/**
 * Font enumeration the way fingerprinting libraries do it: measure a probe
 * string in the candidate family and in each of three generic fallbacks; if the
 * width differs from *all* three, the family is present. Then compare to what
 * `document.fonts.check()` claims. A profile that answers one but not the other
 * is caught by `disagreements`.
 */
const PROBE_FAMILIES = [
  'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas',
  'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Impact', 'Lucida Console',
  'Menlo', 'Monaco', 'Optima', 'Palatino', 'Palatino Linotype', 'Segoe UI', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana', 'Ubuntu', 'DejaVu Sans',
  'Liberation Sans', 'Noto Sans', 'PingFang SC', 'Microsoft YaHei', 'SimSun',
  'Yu Gothic', 'Malgun Gothic', 'Roboto', 'Open Sans', 'Lato', 'Fira Sans',
];
const GENERIC = ['monospace', 'sans-serif', 'serif'];
const PROBE_TEXT = 'mmmmmmmmmmlliWQ@#';

export async function collectFonts(): Promise<Collected<FontFacts>> {
  return collect(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const baseline: number[] = GENERIC.map((g) => {
      ctx.font = `72px ${g}`;
      return ctx.measureText(PROBE_TEXT).width;
    });

    const detected: string[] = [];
    const widths: Record<string, number> = {};
    for (const family of PROBE_FAMILIES) {
      let present = false;
      let width = 0;
      for (let i = 0; i < GENERIC.length; i++) {
        ctx.font = `72px "${family}", ${GENERIC[i]}`;
        width = ctx.measureText(PROBE_TEXT).width;
        if (Math.abs(width - (baseline[i] ?? 0)) > 0.01) {
          present = true;
          break;
        }
      }
      if (present) {
        detected.push(family);
        widths[family] = Number(width.toFixed(3));
      }
    }

    /**
     * `document.fonts.check()` is NOT a presence oracle on desktop Chrome: with
     * no webfont loaded, `document.fonts.size === 0` and check() returns true
     * for *any* name, because it reports "would this text render without a
     * fallback download", not "is this family installed". Measured against an
     * unmodified Chrome, a nonexistent family returns true.
     *
     * So the only real contradiction is the other direction: `check()` reports
     * a family unavailable that measurement says renders with its own metrics.
     * A profile that answers check() from a presence table is therefore *more*
     * detectable than one that leaves it native, which is what we do.
     */
    const checkAgree: string[] = [];
    const disagreements: string[] = [];
    for (const family of PROBE_FAMILIES) {
      const byMeasure = detected.includes(family);
      const byCheck = document.fonts.check(`12px "${family}"`);
      if (byCheck) checkAgree.push(family);
      if (byMeasure && !byCheck) disagreements.push(family);
    }

    return { detected, checkAgree, disagreements, widths };
  });
}

/* ----------------------------------------------------------------- locale */

export async function collectLocale(): Promise<Collected<LocaleFacts>> {
  return collect(() => {
    const dtf = new Intl.DateTimeFormat();
    const resolved = dtf.resolvedOptions();
    const nf = new Intl.NumberFormat();
    return {
      timeZone: resolved.timeZone ?? '',
      offsetMinutes: new Date(2024, 0, 15).getTimezoneOffset(),
      languages: Array.from(navigator.languages ?? []),
      resolvedLocale: resolved.locale,
      numberFormat: nf.format(1234567.89),
      dateFormat: dtf.format(new Date(2024, 0, 15, 13, 45)),
      currency: (() => {
        try {
          return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(1);
        } catch {
          return null;
        }
      })(),
      firstDayOfWeek: (() => {
        try {
          const loc = new Intl.Locale(resolved.locale) as Intl.Locale & {
            getWeekInfo?: () => { firstDay: number };
            weekInfo?: { firstDay: number };
          };
          const info = loc.getWeekInfo?.() ?? loc.weekInfo;
          return info ? String(info.firstDay) : null;
        } catch {
          return null;
        }
      })(),
    };
  });
}

/* ------------------------------------------------------------------ media */

export async function collectMedia(): Promise<Collected<MediaFacts>> {
  return collect(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { audioInputs: 0, audioOutputs: 0, videoInputs: 0, ids: [], stable: true, labelsVisible: false };
    }
    const a = await navigator.mediaDevices.enumerateDevices();
    const b = await navigator.mediaDevices.enumerateDevices();
    const count = (list: MediaDeviceInfo[], kind: MediaDeviceKind): number => list.filter((d) => d.kind === kind).length;
    const idsA = a.map((d) => d.deviceId);
    const stable = idsA.length === b.length && idsA.every((id, i) => id === b[i]?.deviceId);
    return {
      audioInputs: count(a, 'audioinput'),
      audioOutputs: count(a, 'audiooutput'),
      videoInputs: count(a, 'videoinput'),
      ids: idsA,
      stable,
      labelsVisible: a.some((d) => d.label !== ''),
    };
  });
}

/* ----------------------------------------------------------------- native */

/**
 * Native-code and shape checks.
 *
 * This is the cheapest and most common detection technique: read
 * `Function.prototype.toString` of the APIs a profile would have to patch, and
 * look for anything that is not `[native code]`. The second half checks for
 * artefacts of careless patching: a new own property on a prototype, a data
 * property turned into an accessor, or an extension URL leaking into a stack.
 */
const WATCHED_FUNCTIONS: Array<[string, () => unknown]> = [
  ['HTMLCanvasElement.prototype.toDataURL', () => HTMLCanvasElement.prototype.toDataURL],
  ['HTMLCanvasElement.prototype.toBlob', () => HTMLCanvasElement.prototype.toBlob],
  ['CanvasRenderingContext2D.prototype.getImageData', () => CanvasRenderingContext2D.prototype.getImageData],
  ['CanvasRenderingContext2D.prototype.measureText', () => CanvasRenderingContext2D.prototype.measureText],
  ['WebGLRenderingContext.prototype.getParameter', () => WebGLRenderingContext.prototype.getParameter],
  ['WebGLRenderingContext.prototype.readPixels', () => WebGLRenderingContext.prototype.readPixels],
  ['WebGLRenderingContext.prototype.getSupportedExtensions', () => WebGLRenderingContext.prototype.getSupportedExtensions],
  ['AudioBuffer.prototype.getChannelData', () => AudioBuffer.prototype.getChannelData],
  ['OfflineAudioContext.prototype.startRendering', () => OfflineAudioContext.prototype.startRendering],
  ['Navigator.prototype.getBattery', () => (Navigator.prototype as { getBattery?: unknown }).getBattery],
  ['Permissions.prototype.query', () => Permissions.prototype.query],
  ['Function.prototype.toString', () => Function.prototype.toString],
  ['MediaDevices.prototype.enumerateDevices', () => MediaDevices.prototype.enumerateDevices],
  ['Worker', () => Worker],
];

const NATIVE_RE = /\{\s*\[native code\]\s*\}$/;

export async function collectNative(): Promise<Collected<NativeFacts>> {
  return collect(() => {
    const nonNative: string[] = [];
    for (const [name, get] of WATCHED_FUNCTIONS) {
      try {
        const fn = get();
        if (typeof fn !== 'function') continue;
        const src = Function.prototype.toString.call(fn);
        if (!NATIVE_RE.test(src)) nonNative.push(`${name} -> ${src.slice(0, 80).replace(/\s+/g, ' ')}`);
        // Also check whether the plain String() path disagrees with the call
        // path; a bad toString patch often fixes one and not the other.
        const viaString = String(fn);
        if (!NATIVE_RE.test(viaString) && !nonNative.some((n) => n.startsWith(name))) {
          nonNative.push(`${name} (String()) -> ${viaString.slice(0, 80).replace(/\s+/g, ' ')}`);
        }
      } catch (e) {
        nonNative.push(`${name} threw ${(e as Error).name}`);
      }
    }

    // Own properties that should live on the prototype, not the instance, and
    // vice versa. A patch that defines a function on an instance is a tell.
    const ownProps: string[] = [];
    const protoTargets: Array<[string, object, string]> = [
      ['HTMLCanvasElement', HTMLCanvasElement.prototype, 'toDataURL'],
      ['CanvasRenderingContext2D', CanvasRenderingContext2D.prototype, 'getImageData'],
      ['Navigator', Navigator.prototype, 'userAgent'],
      ['Screen', Screen.prototype, 'width'],
    ];
    for (const [label, proto, method] of protoTargets) {
      const d = Object.getOwnPropertyDescriptor(proto, method);
      if (!d) ownProps.push(`${label}.${method} disappeared from the prototype`);
    }

    // Descriptor anomalies: the built-ins are data properties (methods) or
    // accessors; a method that is suddenly an accessor is detectable.
    const descriptorAnomalies: string[] = [];
    for (const [name, get] of WATCHED_FUNCTIONS) {
      const [path] = name.split(' ');
      if (!path) continue;
      const parts = path!.split('.');
      if (parts.length < 3) continue;
      const holderName = parts[0]!;
      const prop = parts[parts.length - 1]!;
      const holder = (window as unknown as Record<string, unknown>)[holderName];
      if (typeof holder !== 'function') continue;
      const proto = (holder as { prototype?: object }).prototype;
      if (!proto) continue;
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (d && !('value' in d) && !name.includes('Worker')) {
        descriptorAnomalies.push(`${path} is an accessor, expected a data property`);
      }
      if (d && Object.prototype.hasOwnProperty.call(d, 'writable') && d.writable !== true) {
        descriptorAnomalies.push(`${path}.writable is ${String(d.writable)}`);
      }
    }

    // Stack traces must not mention the extension or our injected bundles.
    const stackLeaks: string[] = [];
    try {
      const probe = (): string => new Error('probe').stack ?? '';
      const navWithUa = navigator as Navigator & { userAgentData?: { getHighEntropyValues?: unknown } };
      if (navWithUa.userAgentData) {
        void navWithUa.userAgentData.getHighEntropyValues;
      }
      // Force a patched function to be on the stack.
      const c = document.createElement('canvas');
      c.getContext('2d')?.measureText('x');
      HTMLCanvasElement.prototype.toDataURL.call(c);
      const stack = probe();
      for (const marker of ['chrome-extension://', 'worker-shim', 'main.js', 'isolated.js']) {
        if (stack.includes(marker)) stackLeaks.push(marker);
      }
    } catch {
      // ignore
    }

    // Extra keys: compare the prototype's own key set to a reference captured
    // before the extension could have patched anything (see index.ts).
    const extraKeys: string[] = [];
    const ref = (window as unknown as { __labRefKeys?: Record<string, string[]> }).__labRefKeys;
    if (ref) {
      const now = Object.getOwnPropertyNames(Navigator.prototype);
      const missing = now.filter((k) => !ref['Navigator']?.includes(k));
      const added = (ref['Navigator'] ?? []).filter((k) => !now.includes(k));
      if (missing.length || added.length) {
        extraKeys.push(`Navigator.prototype: +${JSON.stringify(added)} -${JSON.stringify(missing)}`);
      }
    }

    return { nonNative, ownProps, descriptorAnomalies, stackLeaks, extraKeys };
  });
}

/* ----------------------------------------------------------------- worker */

export async function collectWorker(): Promise<Collected<WorkerFacts>> {
  return collect(
    () =>
      new Promise<WorkerFacts>((resolve) => {
        let worker: Worker;
        try {
          worker = new Worker('./collector-worker.js');
        } catch (e) {
          resolve({
            ua: null, hardwareConcurrency: null, deviceMemory: null, platform: null,
            canvasHash: null, canvasMatchesWindow: null, timeZone: null, error: String(e),
          });
          return;
        }
        const timer = setTimeout(() => {
          worker.terminate();
          resolve({
            ua: null, hardwareConcurrency: null, deviceMemory: null, platform: null,
            canvasHash: null, canvasMatchesWindow: null, timeZone: null, error: 'timeout',
          });
        }, 4000);
        worker.onmessage = (ev: MessageEvent) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(ev.data as WorkerFacts);
        };
        worker.onerror = (ev) => {
          clearTimeout(timer);
          resolve({
            ua: null, hardwareConcurrency: null, deviceMemory: null, platform: null,
            canvasHash: null, canvasMatchesWindow: null, timeZone: null,
            error: ev.message || 'worker error',
          });
        };
        worker.postMessage({ type: 'collect' });
      }),
  );
}

/* ------------------------------------------------------------------ iframe */

/**
 * Draw the shared probe into a context that belongs to another realm.
 *
 * `drawProbe` only touches standard 2D APIs, so calling it with an iframe's
 * context object is safe; this thin wrapper exists to make that assumption
 * explicit at the one place it happens.
 */
function installDrawingInto(_win: Window, ctx: CanvasRenderingContext2D): void {
  drawProbe(ctx);
}

/**
 * Collect from a same-origin iframe.
 *
 * A tracker uses an iframe because defences sometimes only run in the top
 * frame, or run with different options there. A same-origin frame is a genuine
 * second realm with its own `window` and `navigator`, so comparing it against
 * the parent is a real cross-context check — not the same object read twice.
 */
export async function collectIframe(): Promise<Collected<{ canvasHash: string | null; ua: string | null; cores: number | null }>> {
  return collect(
    () =>
      new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;border:0;';
        frame.src = `${location.pathname}?frame=1`;
        const timer = setTimeout(() => {
          frame.remove();
          reject(new Error('iframe did not load in time'));
        }, 4000);
        frame.onload = () => {
          clearTimeout(timer);
          try {
            const w = frame.contentWindow as (Window & typeof globalThis) | null;
            if (!w) throw new Error('no contentWindow');
            let hash: string | null = null;
            try {
              const doc = w.document;
              const c = doc.createElement('canvas');
              c.width = PROBE_WIDTH; c.height = PROBE_HEIGHT;
              const ctx = c.getContext('2d');
              if (ctx) {
                // Same drawing as the window and worker paths.
                installDrawingInto(w, ctx);
                hash = hashBytes(ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data);
              }
            } catch {
              hash = null;
            }
            const nav = w.navigator;
            resolve({
              canvasHash: hash,
              ua: nav?.userAgent ?? null,
              cores: nav?.hardwareConcurrency ?? null,
            });
            frame.remove();
          } catch (e) {
            frame.remove();
            reject(e);
          }
        };
        frame.onerror = () => {
          clearTimeout(timer);
          frame.remove();
          reject(new Error('iframe failed to load'));
        };
        document.body.append(frame);
      }),
  );
}

/* -------------------------------------------------------------- orchestrator */

export interface CollectOptions {
  includeWorker?: boolean;
  includeAudio?: boolean;
  includeIframe?: boolean;
}

export async function collectAll(opts: CollectOptions = {}): Promise<Snapshot> {
  const takenAt = Date.now();
  const [ua, screenF, hardware, canvas, webgl, fonts, locale, media, native] = await Promise.all([
    collectUa(), collectScreen(), collectHardware(), collectCanvas(),
    collectWebgl(), collectFonts(), collectLocale(), collectMedia(), collectNative(),
  ]);

  const refresh = await measureRefreshHz();
  if (screenF.ok && screenF.value && refresh !== null) screenF.value.refreshHz = refresh;

  const audio = opts.includeAudio === false ? null : await collectAudio();

  /**
   * Complete the round-trip comparison. The reference is the *same* canvas
   * content read through getImageData, so the only difference left is the
   * encode/decode path plus whatever a defence did to one of the two paths.
   */
  if (canvas.ok && canvas.value) {
    try {
      const c = document.createElement('canvas');
      c.width = canvas.value.width;
      c.height = canvas.value.height;
      const ctx = c.getContext('2d')!;
      drawProbe(ctx);
      const reference = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height).data;
      const rt = await roundTripCanvas(c.toDataURL(), reference);
      canvas.value.roundTripHash = rt.hash;
      canvas.value.roundTripMaxDelta = rt.maxDelta;
    } catch {
      canvas.value.roundTripHash = 'error';
      canvas.value.roundTripMaxDelta = -1;
    }
  }

  const snapshot: Snapshot = {
    takenAt,
    url: location.href,
    ua, screen: screenF, hardware, canvas, webgl, audio, fonts, locale, media, native,
    worker: opts.includeWorker === false ? null : await collectWorker(),
    iframe: opts.includeIframe === false ? null : await collectIframe(),
  };
  return snapshot;
}

