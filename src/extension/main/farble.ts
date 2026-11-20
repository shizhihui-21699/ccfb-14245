/**
 * Canvas / WebGL pixel perturbation.
 *
 * Threats this has to survive, nastiest first:
 *
 *  1. *Detection by shape.* "Add random noise to every pixel" is trivially
 *     caught: fill a rectangle, read it back, and a real machine returns one
 *     uniform colour. Noise on a flat fill is a confession.
 *  2. *Detection by inversion.* A fixed global substitution (v -> table[v])
 *     with no position dependence can be inverted by drawing a 256-value strip
 *     and reading it back. Every profile then leaks one global lookup table,
 *     and the *same* table applied to a second canvas is enough to confirm
 *     the mapping.
 *  3. *Detection by magnitude.* A delta above ~1-2 LSB shows up as banding on
 *     gradients or shifts a page's own image processing.
 *  4. *Drift.* If re-reading a canvas after drawing its own output back gives a
 *     different result, the site has an unstable fingerprint.
 *
 * The scheme is **edge-masked parity projection**:
 *
 *  - A pixel is eligible only if it differs from a 4-neighbour by more than
 *    `EDGE_TOLERANCE` on some channel. Flat interiors are never touched, so
 *    solid fills stay bit-exact and a 256-value strip probe recovers nothing
 *    (its pixels are interior pixels).
 *  - For an eligible pixel, each channel is nudged by at most 1 so that its
 *    low bit matches a pseudorandom target parity for that (seed, x, y). The
 *    projection is idempotent: applying it again finds the parity already
 *    correct and changes nothing, so read -> redraw -> read is stable.
 *  - All three channels share the same target parity, so neutral grey stays
 *    neutral grey (a per-channel target would tint greys, which is itself a
 *    detectable artifact in a colour-management check).
 *  - 0 and 255 are fixed points: black and white stay bit-exact, as they do on
 *    real hardware at saturation.
 *
 * Entropy comes from edges — text, anti-aliasing, gradients, images — which is
 * where real machines already differ, and where fingerprinting scripts
 * actually measure. A flat-colour canvas carries no fingerprint on any real
 * machine either, and is left alone on purpose.
 */

/** Minimum neighbour difference (per channel) for a pixel to count as an edge. */
const EDGE_TOLERANCE = 0;

const mix32 = (x: number): number => {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
};

/**
 * Hash for pixel (x, y): the low bit is the target parity, the next bit picks
 * the direction when a nudge is needed. Both are stable per (seed, x, y).
 */
function pixelHash(seed: number, x: number, y: number): number {
  let h = seed >>> 0;
  h = mix32(h ^ Math.imul(x | 0, 0x9e3779b1));
  h = mix32(h ^ Math.imul(y | 0, 0x85ebca77));
  return h;
}

/**
 * Nudge `v` by exactly one so its low bit matches `want`. Idempotent (a value
 * already at the right parity is returned unchanged).
 *
 * The direction is *not* always up. Always rounding up would raise the mean
 * channel value by ~0.5 on textured content, which is a statistically
 * detectable brightness shift — a real artefact the unit test caught. Choosing
 * the direction from a second hash bit keeps the expected delta at zero, so
 * brightness and colour balance are unchanged in aggregate.
 */
function projectParity(v: number, want: number, upFirst: boolean): number {
  if (v === 0 || v === 255) return v;
  if ((v & 1) === want) return v;
  const up = v + 1;
  const down = v - 1;
  if (up > 255) return down;
  if (down < 0) return up;
  return upFirst ? up : down;
}

/**
 * Perturb an RGBA buffer in place. Deterministic in (pixels, width, height,
 * seed): the same canvas always produces the same bytes for the same profile.
 */
export function farbleRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: number,
  opts: {
    flipY?: boolean;
    originX?: number;
    originY?: number;
    canvasWidth?: number;
    canvasHeight?: number;
  } = {},
): void {
  const flipY = opts.flipY ?? false;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const canvasWidth = opts.canvasWidth ?? (originX + width);
  const canvasHeight = opts.canvasHeight ?? (originY + height);
  const w = width;
  const h = height;
  const rowBytes = w * 4;

  /**
   * Raw pixel accessor in *canvas* coordinates, via this buffer only.
   * Returns null when the coordinate is inside the canvas but outside this
   * buffer — the caller must then treat the pixel as undecidable rather than
   * guess, because a guess is exactly what makes a sub-rectangle read
   * contradict a full-canvas read.
   */
  const localX = (cx: number): number => cx - originX;
  const localY = (cy: number, flipped: boolean): number => (flipped ? h - 1 - (cy - originY) : cy - originY);

  const pixelAt = (cx: number, cy: number): number | null => {
    if (cx < 0 || cy < 0 || cx >= canvasWidth || cy >= canvasHeight) return -1; // outside canvas
    const lx = localX(cx);
    const ly = localY(cy, flipY);
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return null; // inside canvas, outside buffer
    return (ly * w + lx) * 4;
  };

  const differs = (a: number, b: number): boolean =>
    data[a] !== data[b] || data[a + 1] !== data[b + 1] || data[a + 2] !== data[b + 2];

  /**
   * Decide eligibility for every pixel *before* writing anything, against the
   * untouched buffer.
   *
   * Doing the test and the write in one pass is subtly wrong: a pixel already
   * projected changes the value its later neighbour compares against, so the
   * result depends on iteration order and two reads of the same canvas can
   * disagree by 1 LSB along a seam. That was visible as a row of interior
   * pixels reading 18,18,17,17,19 where the source was uniformly 18 — a
   * contradiction no real rasteriser produces.
   */
  const eligible = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if ((data[o + 3] ?? 0) === 0) continue;

      const cx = x + originX;
      const cy = flipY ? originY + (h - 1 - y) : y + originY;

      let onEdge = false;
      let undecidable = false;
      const inspect = (nx: number, ny: number): void => {
        const p = pixelAt(nx, ny);
        if (p === -1) return; // no such pixel on the canvas
        if (p === null) { undecidable = true; return; }
        if (!differs(o, p)) return;
        onEdge = true;
      };

      inspect(cx - 1, cy);
      if (undecidable) continue;
      inspect(cx + 1, cy);
      if (undecidable) continue;
      inspect(cx, cy - 1);
      if (undecidable) continue;
      inspect(cx, cy + 1);
      if (undecidable) continue;
      if (onEdge) eligible[y * w + x] = 1;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (eligible[y * w + x] !== 1) continue;
      const o = (y * w + x) * 4;
      const cy = flipY ? originY + (h - 1 - y) : y + originY;
      const hash = pixelHash(seed, x + originX, cy);
      const want = hash & 1;
      const upFirst = ((hash >>> 1) & 1) === 0;
      data[o] = projectParity(data[o] ?? 0, want, upFirst);
      data[o + 1] = projectParity(data[o + 1] ?? 0, want, upFirst);
      data[o + 2] = projectParity(data[o + 2] ?? 0, want, upFirst);
    }
  }
}

/**
 * WebGL `readPixels` output.
 *
 * This deliberately reuses the *same* edge-masked projection as canvas 2D, with
 * the *same* seed. The reason is a cross-path check every serious fingerprinting
 * script runs:
 *
 *     gl.readPixels(...)                       // path A
 *     ctx2d.drawImage(glCanvas, 0, 0)
 *     ctx2d.getImageData(...)                  // path B
 *
 * Both paths start from identical GPU pixels, so they must end at identical
 * bytes. If path A is perturbed with a different seed, or without the edge
 * mask, the two hashes diverge and the detector knows exactly which API was
 * rewritten. Sharing the seed and the transform makes `f(raw) == f(raw)` hold
 * by construction, including for flat clears, which real GPUs also render
 * bit-identically on every machine (so they carry no fingerprint and are
 * correctly left alone).
 */
export function farbleReadPixels(
  pixels: ArrayBufferView,
  width: number,
  height: number,
  format: 'rgb' | 'rgba',
  seed: number,
  opts: { originX?: number; originY?: number; canvasWidth?: number; canvasHeight?: number } = {},
): void {
  if (!(pixels instanceof Uint8Array)) return;
  const bytes = pixels;
  if (format === 'rgb') {
    // Repack to RGBA so the shared routine (which assumes 4-byte pixels and
    // skips fully transparent ones) applies unchanged.
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bytes[i * 3] ?? 0;
      rgba[i * 4 + 1] = bytes[i * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = bytes[i * 3 + 2] ?? 0;
      rgba[i * 4 + 3] = 255;
    }
    farbleRgba(rgba, width, height, seed, {
      flipY: true,
      originX: opts.originX,
      originY: opts.originY,
      canvasWidth: opts.canvasWidth,
      canvasHeight: opts.canvasHeight,
    });
    for (let i = 0; i < width * height; i++) {
      bytes[i * 3] = rgba[i * 4]!;
      bytes[i * 3 + 1] = rgba[i * 4 + 1]!;
      bytes[i * 3 + 2] = rgba[i * 4 + 2]!;
    }
    return;
  }
  const view = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, width * height * 4);
  farbleRgba(view, width, height, seed, {
    flipY: true,
    originX: opts.originX,
    originY: opts.originY,
    canvasWidth: opts.canvasWidth,
    canvasHeight: opts.canvasHeight,
  });
}

/**
 * Audio perturbation: add a tiny, deterministic, magnitude-proportional
 * offset to each sample. Audio fingerprints come from the low-order bits of
 * the summed spectrum of a rendered graph; scaling the offset with |sample|
 * reproduces the natural variation between two real resamplers while keeping
 * silence silent and quiet passages free of added hiss.
 */
export function farbleSamples(data: Float32Array, seed: number, amplitude: number): void {
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    if (v === 0) continue;
    const h = mix32((seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0);
    // Signed, roughly uniform in [-1, 1).
    const signed = (h / 0x80000000) - 1;
    data[i] = v + v * signed * amplitude;
  }
}
