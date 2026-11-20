/**
 * Pixel-perturbation properties.
 *
 * The transform is the part of the design most likely to be "obviously wrong in
 * a way that looks right". These tests encode the four properties that make it
 * survivable, each of which a plausible naive implementation fails:
 *
 *  1. flat regions are untouched (a solid fill must stay one colour);
 *  2. the transform is idempotent (read -> redraw -> read is stable);
 *  3. the histogram is preserved (brightness/contrast unchanged);
 *  4. different seeds give different fingerprints on textured content.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// farble.ts imports nothing from the DOM at module scope, so a direct import of
// the bundled test build works.
import { farbleRgba, farbleSamples } from '../../dist-test/farble.js';

function canvas(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return data;
}

function digest(data) {
  return createHash('sha256').update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest('hex').slice(0, 16);
}

function distinctColours(data, width, height) {
  const set = new Set();
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    set.add(`${data[o]},${data[o + 1]},${data[o + 2]}`);
  }
  return set.size;
}

/** The canonical probe: text-ish edges plus a flat gradient. */
function texturedCanvas(width = 200, height = 60) {
  return canvas(width, height, (x, y) => {
    if (y >= 30) return [Math.round(255 * (x / width)), 128, Math.round(255 * (1 - x / width))];
    const d = Math.abs(((x * 5 + y * 11) % 37) - 18) / 18;
    return [Math.round(255 - 200 * d), Math.round(255 - 90 * d), Math.round(255 - 40 * d)];
  });
}

test('a flat fill stays exactly one colour', () => {
  const data = canvas(32, 32, () => [255, 102, 0]);
  const before = digest(data);
  farbleRgba(data, 32, 32, 0xbeef);
  assert.equal(distinctColours(data, 32, 32), 1, 'flat fill gained a second colour');
  assert.equal(digest(data), before, 'flat fill bytes changed');
});

test('a two-colour checkerboard stays two colours', () => {
  const data = canvas(32, 32, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [255, 255, 255] : [0, 0, 0]));
  farbleRgba(data, 32, 32, 0x1234);
  assert.equal(distinctColours(data, 32, 32), 2);
});

test('textured content changes by at most one LSB per channel', () => {
  const W = 200;
  const H = 60;
  const original = texturedCanvas(W, H);
  const data = texturedContentCopy(original);
  farbleRgba(data, W, H, 0xdeadbeef);
  let changed = 0;
  for (let i = 0; i < original.length; i++) {
    const d = Math.abs((data[i] ?? 0) - (original[i] ?? 0));
    assert.ok(d <= 1, `delta ${d} at byte ${i} exceeds 1 LSB`);
    if (d > 0) changed++;
  }
  assert.ok(changed > 100, `only ${changed} bytes changed; the profile is barely distinguishable`);
});

test('the transform is idempotent', () => {
  const W = 200;
  const H = 60;
  const once = texturedCanvas(W, H);
  farbleRgba(once, W, H, 0xc0ffee);
  const twice = texturedContentCopy(once);
  farbleRgba(twice, W, H, 0xc0ffee);
  assert.equal(digest(twice), digest(once), 'applying the transform twice changed the result');
});

test('the value distribution is not shifted wholesale', () => {
  const W = 200;
  const H = 60;
  const original = texturedCanvas(W, H);
  const data = texturedContentCopy(original);
  farbleRgba(data, W, H, 0x5555);
  const hist = (buf) => {
    const h = new Uint32Array(256);
    for (let i = 0; i < buf.length; i++) h[buf[i]]++;
    return h;
  };
  const a = hist(original);
  const b = hist(data);

  /**
   * A parity projection does NOT preserve the histogram exactly — it moves each
   * eligible value by one, so counts shift between neighbouring bins. What must
   * hold is that the distribution is not *shifted*: the mean and the total are
   * unchanged, so brightness and contrast are unaffected.
   */
  let sumA = 0;
  let sumB = 0;
  let totalA = 0;
  let totalB = 0;
  for (let v = 0; v < 256; v++) {
    sumA += v * a[v];
    sumB += v * b[v];
    totalA += a[v];
    totalB += b[v];
  }
  assert.equal(totalA, totalB, 'pixel count changed');
  const meanA = sumA / totalA;
  const meanB = sumB / totalB;
  assert.ok(Math.abs(meanA - meanB) < 0.05,
    `mean channel value shifted from ${meanA.toFixed(3)} to ${meanB.toFixed(3)}`);
});

test('different seeds produce different fingerprints on textured content', () => {
  const W = 200;
  const H = 60;
  const base = texturedCanvas(W, H);
  const signatures = new Set();
  for (let seed = 0; seed < 200; seed++) {
    const copy = texturedContentCopy(base);
    farbleRgba(copy, W, H, seed * 2654435761 >>> 0);
    signatures.add(digest(copy));
  }
  assert.ok(signatures.size > 190, `only ${signatures.size}/200 seeds gave a distinct fingerprint`);
});

test('the same seed and input always give the same output', () => {
  const base = texturedCanvas();
  const a = texturedContentCopy(base);
  const b = texturedContentCopy(base);
  farbleRgba(a, 200, 60, 42);
  farbleRgba(b, 200, 60, 42);
  assert.equal(digest(a), digest(b));
});

test('readPixels flipY makes a GL readback match the canvas copy', () => {
  // Simulate a GL readback (bottom-up) of an image also available top-down.
  const W = 16;
  const H = 16;
  const topDown = texturedCanvas(W, H);
  const bottomUp = new Uint8Array(topDown.length);
  for (let y = 0; y < H; y++) {
    bottomUp.set(topDown.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
  }

  const canvasCopy = new Uint8ClampedArray(topDown);
  farbleRgba(canvasCopy, W, H, 7);

  const glCopy = new Uint8Array(bottomUp);
  farbleRgba(new Uint8ClampedArray(glCopy.buffer), W, H, 7, { flipY: true });

  // Undo the row flip to compare in one coordinate system.
  const glTopDown = new Uint8Array(glCopy.length);
  for (let y = 0; y < H; y++) {
    glTopDown.set(glCopy.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
  }
  assert.equal(digest(glTopDown), digest(canvasCopy), 'GL and canvas paths diverge');
});

test('audio perturbation is silent-stable, bounded and idempotent per render', () => {
  const n = 5000;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin(i / 40) * 0.1;
  samples[100] = 0;
  samples[101] = 0;

  const amplitude = 5e-5;
  farbleSamples(samples, 12345, amplitude);

  assert.equal(samples[100], 0, 'silence gained a non-zero sample');
  assert.equal(samples[101], 0, 'silence gained a non-zero sample');

  // The offset is proportional to |sample|, not absolute: that is what keeps
  // quiet passages quiet while still changing the low-order bits that audio
  // fingerprints are computed from.
  for (let i = 0; i < n; i++) {
    if (i === 100 || i === 101) continue;
    const expected = Math.sin(i / 40) * 0.1;
    const delta = Math.abs((samples[i] ?? 0) - expected);
    // `expected` is the float64 value; the buffer holds float32, so allow one
    // float32 ulp on top of the perturbation bound.
    const f32Ulp = Math.max(Math.abs(expected), 1e-30) * 1.2e-7;
    assert.ok(delta <= Math.abs(expected) * amplitude + f32Ulp + 1e-15,
      `sample ${i} moved by ${delta}`);
  }

  // And it must actually change something, or the fingerprint would be shared.
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (samples[i] !== Math.sin(i / 40) * 0.1) changed++;
  }
  assert.ok(changed > n * 0.9, `only ${changed}/${n} samples were perturbed`);
});

/** Deep copy that preserves the Uint8ClampedArray type. */
function texturedContentCopy(src) {
  return new Uint8ClampedArray(src);
}

test('interior pixels of a uniform band are untouched (order-independent)', () => {
  /**
   * Regression: evaluating eligibility and writing in one pass made a pixel's
   * projection depend on whether an earlier pixel in the same row had already
   * changed, so a uniform band read back as 18,18,17,17,19. Any real rasteriser
   * returns one value for a uniform run.
   */
  const W = 100;
  const H = 100;
  const data = canvas(W, H, (x, y) => (Math.floor(y / 10) % 2 ? [0xab, 0xcd, 0xef] : [0x12, 0x34, 0x56]));
  farbleRgba(data, W, H, 0x1234);

  for (let y = 0; y < H; y++) {
    const inBandBoundary = y % 10 === 0 || y % 10 === 9;
    if (inBandBoundary) continue;
    const row = new Set();
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      row.add(`${data[o]},${data[o + 1]},${data[o + 2]}`);
    }
    assert.equal(row.size, 1, `row ${y} is not uniform after perturbation: ${[...row].join(' | ')}`);
  }
});

test('a sub-rectangle matches the same pixels in a full read', () => {
  const W = 100;
  const H = 100;
  const raw = canvas(W, H, (x, y) => (Math.floor(y / 10) % 2 ? [0xab, 0xcd, 0xef] : [0x12, 0x34, 0x56]));

  const full = new Uint8ClampedArray(raw);
  farbleRgba(full, W, H, 0x77, { originX: 0, originY: 0, canvasWidth: W, canvasHeight: H });

  for (const [x, y, w, h] of [[10, 20, 30, 40], [0, 0, 50, 50], [70, 60, 30, 30]]) {
    // Crop the raw pixels, then transform as if this were a padded sub-read.
    const px = Math.max(0, x - 3);
    const py = Math.max(0, y - 3);
    const pw = Math.min(W, x + w + 3) - px;
    const ph = Math.min(H, y + h + 3) - py;
    const buffer = new Uint8ClampedArray(pw * ph * 4);
    for (let row = 0; row < ph; row++) {
      const src = ((py + row) * W + px) * 4;
      buffer.set(raw.subarray(src, src + pw * 4), row * pw * 4);
    }
    farbleRgba(buffer, pw, ph, 0x77, { originX: px, originY: py, canvasWidth: W, canvasHeight: H });

    let mismatches = 0;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const fullO = ((y + row) * W + (x + col)) * 4;
        const subO = ((y + row - py) * pw + (x + col - px)) * 4;
        for (let c = 0; c < 4; c++) {
          if (full[fullO + c] !== buffer[subO + c]) mismatches++;
        }
      }
    }
    assert.equal(mismatches, 0, `rect ${[x, y, w, h]} disagreed with the full read`);
  }
});
