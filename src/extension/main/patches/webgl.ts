/**
 * WebGL / WebGL2.
 *
 * WebGL leaks more identifying bits than any other single source: the unmasked
 * vendor and renderer strings, ~40 numeric limits, the extension list, the
 * shader precision query, and the actual rendered pixels. All of it has to
 * agree with the profile's GPU *and* with the OS — "NVIDIA" on a Mac is a
 * contradiction no coherent profile would produce, and a renderer string
 * claiming an RTX 3060 with a `MAX_TEXTURE_SIZE` of 8192 (which an integrated
 * chip would have) is just as readable.
 *
 * Patching strategy:
 *  - `getParameter` answers from a table keyed by the profile's GPU. Unknown
 *    parameters fall through to the real implementation, so a future enum does
 *    not start returning `undefined` and becoming a tell in the other direction.
 *  - `getSupportedExtensions` follows the normalised Chrome ordering of the
 *    profile's extension list. Each context gets a *separate* array instance,
 *    because Chrome does too, and sharing one would be observable.
 *  - `readPixels` applies the same projection as canvas 2D, so a page that
 *    draws through WebGL and reads back, and one that copies to a 2D canvas,
 *    get the same pixels for the same profile.
 *  - `getShaderPrecisionFormat` answers from the profile's precision row,
 *    which differs between GPU families in a way detectors check.
 */

import { replaceMethod, mask } from '../native.js';
import { farbleReadPixels } from '../farble.js';
import type { Profile } from '../../shared/profile/types.js';

/** WebGL enum values, spelled here so the mapping is auditable. */
const ENUM = {
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
  MAX_ELEMENT_INDEX: 0x8d6b,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_SAMPLES: 0x8d57,
  MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  RED_BITS: 0x0d52,
  GREEN_BITS: 0x0d53,
  BLUE_BITS: 0x0d54,
  ALPHA_BITS: 0x0d55,
  DEPTH_BITS: 0x0d56,
  STENCIL_BITS: 0x0d57,
  SUBPIXEL_BITS: 0x0d50,
  SAMPLES: 0x80a9,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  HIGH_FLOAT: 0x8df2,
  MEDIUM_FLOAT: 0x8df1,
  LOW_FLOAT: 0x8df0,
  HIGH_INT: 0x8df5,
  MEDIUM_INT: 0x8df4,
  LOW_INT: 0x8df3,
} as const;

const DEBUG_RENDERER_INFO = 'WEBGL_debug_renderer_info';

export function patchWebGL(profile: Profile): void {
  const contexts: Array<{ proto: WebGLRenderingContext; webgl2: boolean }> = [];
  if (typeof WebGLRenderingContext !== 'undefined') {
    contexts.push({ proto: WebGLRenderingContext.prototype as WebGLRenderingContext, webgl2: false });
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    contexts.push({ proto: WebGL2RenderingContext.prototype as WebGLRenderingContext, webgl2: true });
  }

  for (const { proto, webgl2 } of contexts) {
    patchGetParameter(proto, profile, webgl2);
    patchExtensions(proto, profile);
    patchReadPixels(proto, profile);
    patchPrecision(proto, profile);
  }
}

function parameterTable(profile: Profile, webgl2: boolean): Map<number, unknown> {
  const g = profile.gpu;
  const t = new Map<number, unknown>();
  t.set(ENUM.VENDOR, 'WebKit');
  t.set(ENUM.RENDERER, g.maskedRenderer);
  t.set(ENUM.VERSION, webgl2 ? 'WebGL 2.0 (OpenGL ES 3.0 Chromium)' : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)');
  t.set(ENUM.SHADING_LANGUAGE_VERSION,
    webgl2 ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)' : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)');

  t.set(ENUM.MAX_TEXTURE_SIZE, g.maxTextureSize);
  t.set(ENUM.MAX_RENDERBUFFER_SIZE, g.maxRenderbufferSize);
  t.set(ENUM.MAX_VIEWPORT_DIMS, new Int32Array([g.maxViewportDim, g.maxViewportDim]));
  t.set(ENUM.MAX_VERTEX_ATTRIBS, g.maxVertexAttribs);
  t.set(ENUM.MAX_VARYING_VECTORS, g.maxVaryingVectors);
  t.set(ENUM.MAX_COMBINED_TEXTURE_IMAGE_UNITS, g.maxCombinedTextureUnits);
  t.set(ENUM.MAX_TEXTURE_IMAGE_UNITS, g.maxTextureUnits);
  t.set(ENUM.MAX_FRAGMENT_UNIFORM_VECTORS, g.maxFragmentUniformVectors);
  t.set(ENUM.MAX_VERTEX_UNIFORM_VECTORS, g.maxVertexUniformVectors);
  t.set(ENUM.ALIASED_LINE_WIDTH_RANGE, new Float32Array(g.aliasedLineWidthRange));
  t.set(ENUM.ALIASED_POINT_SIZE_RANGE, new Float32Array(g.aliasedPointSizeRange));
  t.set(ENUM.RED_BITS, 8);
  t.set(ENUM.GREEN_BITS, 8);
  t.set(ENUM.BLUE_BITS, 8);
  t.set(ENUM.ALPHA_BITS, 8);
  t.set(ENUM.DEPTH_BITS, 24);
  t.set(ENUM.STENCIL_BITS, 8);
  t.set(ENUM.SUBPIXEL_BITS, 4);
  t.set(ENUM.SAMPLES, 4);

  if (webgl2) {
    t.set(ENUM.MAX_ELEMENT_INDEX, 4294967295);
    t.set(ENUM.MAX_3D_TEXTURE_SIZE, 2048);
    t.set(ENUM.MAX_ARRAY_TEXTURE_LAYERS, 2048);
    t.set(ENUM.MAX_CUBE_MAP_TEXTURE_SIZE, g.maxTextureSize);
    t.set(ENUM.MAX_DRAW_BUFFERS, 8);
    t.set(ENUM.MAX_COLOR_ATTACHMENTS, 8);
    t.set(ENUM.MAX_SAMPLES, 4);
    t.set(ENUM.MAX_UNIFORM_BLOCK_SIZE, 65536);
  }
  return t;
}

function patchGetParameter(proto: object, profile: Profile, webgl2: boolean): void {
  const table = parameterTable(profile, webgl2);
  const g = profile.gpu;

  replaceMethod(proto, 'getParameter', function getParameter(
    this: WebGLRenderingContext, pname: number,
  ) {
    if (pname === ENUM.UNMASKED_VENDOR_WEBGL || pname === ENUM.UNMASKED_RENDERER_WEBGL) {
      // Only answerable through WEBGL_debug_renderer_info; a context without
      // the extension returns null for these, as the browser does.
      if (!(this.getSupportedExtensions() ?? []).includes(DEBUG_RENDERER_INFO)) return null;
      return pname === ENUM.UNMASKED_VENDOR_WEBGL ? g.vendor : g.renderer;
    }
    if (table.has(pname)) {
      const v = table.get(pname);
      // Arrays are mutable objects on the page side; hand out a copy each call
      // so a page that mutates the result cannot change what the next call sees.
      if (ArrayBuffer.isView(v)) {
        return (v as Float32Array).slice();
      }
      return v;
    }
    return (nativeGetParameter as (...a: unknown[]) => unknown).call(this, pname);
  });
}

// Captured before patching so the fallthrough path never recurses.
const nativeGetParameter = (typeof WebGLRenderingContext !== 'undefined'
  ? WebGLRenderingContext.prototype.getParameter
  : undefined) as ((this: WebGLRenderingContext, p: number) => unknown) | undefined
  ?? (() => null);

function patchExtensions(proto: WebGLRenderingContext & { prototype?: object }, profile: Profile): void {
  const list = profile.gpu.extensions;

  replaceMethod(proto, 'getSupportedExtensions', function getSupportedExtensions() {
    // A fresh array per call: Chrome allocates per call and pages compare
    // identity across two calls as a cheap tampering probe.
    return list.slice();
  });

  // getExtension must agree with the list. The native method is kept for
  // extensions that exist, and returns null for ones the profile hides.
  const nativeGetExtension = proto.getExtension;
  replaceMethod(proto, 'getExtension', function getExtension(
    this: WebGLRenderingContext, name: string,
  ) {
    if (!list.includes(name)) return null;
    return (nativeGetExtension as (n: string) => unknown).call(this, name);
  });
}

function patchReadPixels(proto: WebGLRenderingContext, profile: Profile): void {
  /**
   * The canvas seed, not the WebGL seed: a page can copy a GL canvas into a 2D
   * canvas and read it through `getImageData`, which uses the canvas seed. Both
   * paths must land on the same bytes (see farbleReadPixels).
   */
  const seed = profile.noise.canvas.seed;
  const nativeReadPixels = proto.readPixels;

  replaceMethod(proto, 'readPixels', function readPixels(
    this: WebGLRenderingContext,
    x: number, y: number, width: number, height: number,
    format: number, type: number, pixels: ArrayBufferView | null,
  ) {
    const result = (nativeReadPixels as (...a: unknown[]) => unknown).call(
      this, x, y, width, height, format, type, pixels,
    );
    if (!pixels || type !== 0x1401 /* UNSIGNED_BYTE */) return result;
    /**
     * Pass the read origin and the drawing-buffer size so the edge test is
     * answered in absolute coordinates, exactly as the canvas-2D path answers
     * it. A readPixels of the whole buffer and a 2D copy of the same canvas
     * must land on identical bytes; without the origin they do not agree on
     * border pixels (caught by the lab's cross-path check).
     */
    const opts = {
      originX: x,
      originY: y,
      canvasWidth: this.drawingBufferWidth,
      canvasHeight: this.drawingBufferHeight,
    };
    if (format === 0x1908 /* RGBA */) {
      farbleReadPixels(pixels, width, height, 'rgba', seed, opts);
    } else if (format === 0x1907 /* RGB */) {
      farbleReadPixels(pixels, width, height, 'rgb', seed, opts);
    }
    return result;
  });
}

function patchPrecision(proto: WebGLRenderingContext, profile: Profile): void {
  const native = proto.getShaderPrecisionFormat;
  if (typeof native !== 'function') return;

  replaceMethod(proto, 'getShaderPrecisionFormat', function getShaderPrecisionFormat(
    this: WebGLRenderingContext, shaderType: number, precisionType: number,
  ) {
    const isFragment = shaderType === ENUM.FRAGMENT_SHADER;
    const row = isFragment ? profile.gpu.fragmentPrecision : profile.gpu.vertexPrecision;
    // Integer precisions are exact on every desktop GPU; only float differs.
    const isFloat = precisionType === ENUM.HIGH_FLOAT || precisionType === ENUM.MEDIUM_FLOAT || precisionType === ENUM.LOW_FLOAT;
    if (!isFloat) return (native as (...a: unknown[]) => unknown).call(this, shaderType, precisionType);
    // Hand back an object with the same shape as WebGLShaderPrecisionFormat.
    const obj = Object.create(WebGLShaderPrecisionFormat.prototype);
    Object.defineProperties(obj, {
      rangeMin: { get: mask(function getter() { return row.rangeMin; }, 'get rangeMin'), configurable: true, enumerable: true },
      rangeMax: { get: mask(function getter() { return row.rangeMax; }, 'get rangeMax'), configurable: true, enumerable: true },
      precision: { get: mask(function getter() { return row.precision; }, 'get precision'), configurable: true, enumerable: true },
    });
    return obj;
  });
}
