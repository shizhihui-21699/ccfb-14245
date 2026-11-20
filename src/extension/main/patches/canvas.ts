/**
 * Canvas 2D.
 *
 * Every path out of a canvas that a page can read as pixels has to agree with
 * every other path, or the page has a free consistency check:
 *
 *      toDataURL()  ->  decode  ->  ImageData
 *      getImageData()
 *      toBlob()
 *
 * farbling only one of them is worse than farbling none. So the projection is
 * applied at the single point where pixels become readable — `getImageData`,
 * `toDataURL`, `toBlob` — and always identically for a given canvas content and
 * profile, because it is a pure function of (pixels, seed).
 *
 * Text measurement is a separate channel: `measureText().width` and the
 * bounding-box results feed font-enumeration scripts that compare rendered
 * widths against a fallback baseline. Those get a per-font, per-profile
 * sub-pixel scale taken from the profile's font table, which keeps
 * text-enumeration results consistent with `document.fonts.check()`.
 */

import { mask, replaceMethod } from '../native.js';
import { farbleRgba } from '../farble.js';
import type { Profile } from '../../shared/profile/types.js';

/**
 * Install everything canvas-shaped that this realm has.
 *
 * The window realm has `CanvasRenderingContext2D` and `<canvas>`; a worker has
 * only `OffscreenCanvas`. `OffscreenCanvasRenderingContext2D` is a *distinct*
 * prototype from `CanvasRenderingContext2D`, so patching one and not the other
 * leaves `offscreen.getContext('2d').getImageData()` returning raw pixels while
 * the same drawing in the window is farbled — exactly the cross-realm split a
 * tracker looks for, and what the lab's context matrix caught.
 */
export function patchCanvas(profile: Profile): void {
  if (typeof CanvasRenderingContext2D !== 'undefined') {
    patchContextPixels(CanvasRenderingContext2D.prototype, profile);
    patchTextMetrics(CanvasRenderingContext2D.prototype, profile);
  }
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    patchContextPixels(OffscreenCanvasRenderingContext2D.prototype, profile);
    patchTextMetrics(OffscreenCanvasRenderingContext2D.prototype, profile);
  }
  patchOffscreen(profile);
}

/**
 * Pixels of padding read around a sub-rectangle.
 *
 * The projection is edge-gated, so a neighbour two pixels away can decide a
 * border pixel's status indirectly: the neighbour only becomes an edge itself
 * because of *its* neighbour. A one-pixel pad leaves a seam one row inside the
 * rectangle (observed at rows 54-56 of the test pattern). Three pixels covers
 * every chain the 4-neighbour edge test can produce within one rectangle.
 */
const PAD = 3;

type Any2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function patchContextPixels(
  proto: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  profile: Profile,
): void {
  const seed = profile.noise.canvas.seed;

  /**
   * `getImageData`.
   *
   * The projection is applied to whatever rectangle was asked for, using the
   * rectangle's own coordinates, so a full-canvas read and a sub-rectangle read
   * of the same pixels agree where they overlap (a detector that reads a strip
   * and compares it to the corresponding part of a full read would otherwise
   * see a contradiction).
   *
   * The native method is captured first; our own `toDataURL`/`toBlob` copy path
   * uses it directly so a copy is transformed exactly once.
   */
  const nativeGetImageData = proto.getImageData;
  replaceMethod(proto, 'getImageData', function getImageData(
    this: Any2DContext,
    sx: number, sy: number, sw: number, sh: number,
  ) {
    /**
     * Read one pixel of padding on each side (clamped to the canvas) and run
     * the projection over the padded buffer, then crop.
     *
     * The projection is position-dependent and edge-gated, so a sub-rectangle
     * read must see the same neighbours a full-canvas read would see. Reading
     * only the requested pixels leaves the border pixels' outer neighbours
     * unknown, and any guess there makes the sub-read disagree with the full
     * read — a contradiction a detector finds by reading a strip and comparing
     * it to the same strip inside a full read. Padding removes the guesswork.
     */
    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;
    const clampX0 = (v: number) => Math.max(0, v);
    const clampY0 = (v: number) => Math.max(0, v);
    const clampX1 = (v: number) => Math.min(canvasW, v);
    const clampY1 = (v: number) => Math.min(canvasH, v);

    const px = clampX0(sx - PAD);
    const py = clampY0(sy - PAD);
    const pw = clampX1(sx + sw + PAD) - px;
    const ph = clampY1(sy + sh + PAD) - py;

    const padded = nativeGetImageData.call(this, px, py, pw, ph);
    farbleRgba(padded.data, pw, ph, seed, {
      originX: px,
      originY: py,
      canvasWidth: canvasW,
      canvasHeight: canvasH,
    });

    if (px === sx && py === sy && pw === sw && ph === sh) return padded;

    const out = new ImageData(sw, sh);
    const offX = sx - px;
    const offY = sy - py;
    for (let row = 0; row < sh; row++) {
      const srcStart = ((row + offY) * pw + offX) * 4;
      out.data.set(padded.data.subarray(srcStart, srcStart + sw * 4), row * sw * 4);
    }
    return out;
  });

  // --- toDataURL -----------------------------------------------------------
  const nativeToDataURL = HTMLCanvasElement.prototype.toDataURL;
  replaceMethod(HTMLCanvasElement.prototype, 'toDataURL', function toDataURL(
    this: HTMLCanvasElement,
    type?: string, quality?: unknown,
  ) {
    // The return value is the whole API; dropping it makes every page that
    // exports a canvas produce "undefined". (Caught by the lab's canvas probe.)
    return withFarbleCopy(this, seed, (copy) => nativeToDataURL.call(copy, type, quality as number));
  });

  // --- toBlob --------------------------------------------------------------
  const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
  replaceMethod(HTMLCanvasElement.prototype, 'toBlob', function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback, type?: string, quality?: unknown,
  ) {
    withFarbleCopy(this, seed, (copy) => nativeToBlob.call(copy, callback, type, quality as number));
    // The real toBlob is asynchronous; returning undefined matches the spec.
  });

}

/**
 * OffscreenCanvas works in both realms, so this half runs in workers too.
 * `OffscreenCanvasRenderingContext2D.getImageData` is patched by the same
 * `patchOffscreen` path on readback of the copy.
 */
function patchOffscreen(profile: Profile): void {
  const seed = profile.noise.canvas.seed;
  const Offscreen = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (!Offscreen) return;

  const offProto = Offscreen.prototype;
  const nativeConvert = offProto.convertToBlob;
  const nativeTransfer = offProto.transferToImageBitmap;
  if (typeof nativeConvert === 'function') {
    replaceMethod(offProto, 'convertToBlob', function convertToBlob(
      this: OffscreenCanvas, options?: ImageEncodeOptions,
    ) {
      return withFarbleOffscreen(this, seed, (copy) => nativeConvert.call(copy, options));
    });
  }
  // transferToImageBitmap detaches the source canvas; the farbled copy is
  // produced from a clone so the source is bit-identical to what the page drew.
  if (typeof nativeTransfer === 'function') {
    replaceMethod(offProto, 'transferToImageBitmap', function transferToImageBitmap(
      this: OffscreenCanvas,
    ) {
      return withFarbleOffscreen(this, seed, (copy) => nativeTransfer.call(copy));
    });
  }
}

/**
 * Run `produce` against a throwaway copy of `source` whose pixels have been
 * farbled, so the page's own canvas is never mutated (a page that draws, reads,
 * draws again must not accumulate our change).
 *
 * The copy is a same-type canvas, not an OffscreenCanvas: pages compare
 * `toDataURL` output of canvas vs offscreen canvas and expect the same encoder
 * behaviour.
 */
/**
 * The 2D context natives, captured lazily.
 *
 * These must NOT be evaluated at module scope: this module is bundled into the
 * worker shim, where `CanvasRenderingContext2D` does not exist. A top-level
 * reference threw `ReferenceError` at worker start, which surfaced as
 * `importScripts ... failed to load` and left the entire worker realm
 * unpatched — the page then saw the real fingerprint in one realm and the
 * virtual one in the other. (Found by the lab's worker comparison.)
 */
interface Natives2d {
  getImageData: (this: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sx: number, sy: number, sw: number, sh: number) => ImageData;
  putImageData: (this: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    image: ImageData, dx: number, dy: number) => void;
}

let native2d: Natives2d | null = null;

function capture2dNatives(): Natives2d | null {
  if (native2d) return native2d;
  if (typeof CanvasRenderingContext2D === 'undefined') return null;
  native2d = {
    getImageData: CanvasRenderingContext2D.prototype.getImageData as unknown as Natives2d['getImageData'],
    putImageData: CanvasRenderingContext2D.prototype.putImageData as unknown as Natives2d['putImageData'],
  };
  return native2d;
}

function withFarbleCopy<T>(
  source: HTMLCanvasElement,
  seed: number,
  produce: (copy: HTMLCanvasElement) => T,
): T {
  const w = source.width;
  const h = source.height;
  if (w === 0 || h === 0) return produce(source);

  const copy = document.createElement('canvas');
  copy.width = w;
  copy.height = h;
  const ctx = copy.getContext('2d', { willReadFrequently: false });
  if (!ctx) return produce(source);

  ctx.drawImage(source, 0, 0);

  /**
   * Read with the *native* getImageData, not the patched one: the patched
   * version already applies the projection, and applying it twice is not
   * idempotent across two different canvases (the copy would be transformed,
   * then transformed again when `produce` reads it back on engines that
   * re-farble on read).
   */
  const natives = capture2dNatives();
  if (!natives) return produce(source);
  const image = natives.getImageData.call(ctx, 0, 0, w, h);
  farbleRgba(image.data, w, h, seed);
  natives.putImageData.call(ctx, image, 0, 0);
  return produce(copy);
}

function withFarbleOffscreen<T>(
  source: OffscreenCanvas,
  seed: number,
  produce: (copy: OffscreenCanvas) => T,
): T {
  const w = source.width;
  const h = source.height;
  if (w === 0 || h === 0) return produce(source);
  const copy = new OffscreenCanvas(w, h);
  const ctx = copy.getContext('2d');
  if (!ctx) return produce(source);
  ctx.drawImage(source, 0, 0);
  // Read with the native context methods (captured before patching) so the
  // copy is transformed exactly once, even if the 2D context was patched.
  const natives = capture2dNatives();
  if (natives) {
    const image = natives.getImageData.call(ctx, 0, 0, w, h);
    farbleRgba(image.data, w, h, seed);
    natives.putImageData.call(ctx, image, 0, 0);
  }
  return produce(copy);
}

/**
 * Text metrics.
 *
 * `measureText` is used far more often for *font enumeration* than for layout:
 * render a probe at 12px in family X and compare its width to a fallback. If
 * the widths match, the font is absent.
 *
 * We scale widths per family from the profile's font table. Families the
 * profile marks absent must measure *identically to the fallback within the
 * same profile*, or enumeration scripts can tell them apart — so the scale for
 * an absent family is exactly the fallback's scale.
 */
function patchTextMetrics(
  proto: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  profile: Profile,
): void {
  const nativeMeasureText = proto.measureText;
  /**
   * Width scale per family. Two rules make measurement and
   * `document.fonts.check()` agree, which is the contradiction the lab looks for:
   *
   *  - a family the profile marks *present* gets a small non-unit scale, so its
   *    width differs from every generic fallback (the measurement test for
   *    presence);
   *  - a family the profile marks *absent* is forced to exactly the fallback
   *    width (scale = 1), so measurement also reports absence.
   *
   * Families the profile says nothing about keep their native width, which is
   * the truth for a font neither we nor the OS installed.
   */
  const fontScales = new Map<string, number>();
  for (const f of profile.fonts) {
    fontScales.set(f.family.toLowerCase(), f.present ? f.widthScale : 1);
  }
  const GENERIC_FALLBACKS = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

  replaceMethod(proto, 'measureText', function measureText(
    this: Any2DContext, text: string,
  ) {
    const metrics = nativeMeasureText.call(this, text);
    const family = extractPrimaryFamily(this.font);
    if (!family) return metrics;
    const key = family.toLowerCase();
    const scale = GENERIC_FALLBACKS.has(key) ? 1 : (fontScales.get(key) ?? 1);
    if (scale === 1) return metrics;

    // TextMetrics properties are readonly getters on the instance's prototype.
    // Patch the instance so identity and prototype stay untouched.
    const scaled: Array<[string, number]> = [
      ['width', metrics.width * scale],
      ['actualBoundingBoxLeft', metrics.actualBoundingBoxLeft],
      ['actualBoundingBoxRight', metrics.actualBoundingBoxRight],
    ];
    for (const [prop, value] of scaled) {
      const desc = Object.getOwnPropertyDescriptor(TextMetrics.prototype, prop);
      if (!desc?.get) continue;
      Object.defineProperty(metrics, prop, {
        get: mask(function getter() { return value; }, `get ${prop}`),
        enumerable: desc.enumerable,
        configurable: true,
      });
    }
    return metrics;
  });
}

/** Pull the first family out of a CSS font shorthand ("italic 12px 'Foo', serif"). */
function extractPrimaryFamily(font: string): string | null {
  const m = /(?:^|\s)(?:"([^"]+)"|'([^']+)'|([^\s,]+))\s*(?:,|$)/.exec(
    font.replace(/^[^"]*\d+(?:\.\d+)?px\s*/, ''),
  );
  if (!m) {
    // Fall back to taking the token after the size.
    const after = /\d+(?:\.\d+)?px\s+(.+)$/.exec(font);
    if (!after) return null;
    const first = after[1]!.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
    return first || null;
  }
  return m[1] ?? m[2] ?? m[3] ?? null;
}
