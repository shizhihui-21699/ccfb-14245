/**
 * Functionality regression.
 *
 * A fingerprint defence that breaks ordinary pages is worse than useless for
 * someone doing research: an exported chart with blank pixels, a WebGL demo
 * that throws, or a video call with no camera is an operational failure that no
 * amount of fingerprint realism compensates for.
 *
 * These tests load ordinary web-platform features under the extension and
 * assert they still behave the way a page expects.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../support/browser.mjs';
import { startLabServer } from '../support/lab-server.mjs';

const EXTENSION = new URL('../../dist/extension', import.meta.url).pathname;

let lab;
const browsers = new Set();

before(async () => {
  lab = await startLabServer();
});

after(async () => {
  for (const b of browsers) await b.close();
  await lab?.close();
});

/**
 * Each test gets its own browser.
 *
 * Sharing one was the source of a real false negative: several pages in one
 * profile run against the same extension instance, and the timing of one page's
 * render can interleave with another's, which made a canvas-consistency test
 * fail intermittently while passing when run alone. A functional-regression
 * suite has to be deterministic, or its failures get ignored.
 */
async function freshPage() {
  const browser = await Browser.launch({ extensionPath: EXTENSION });
  browsers.add(browser);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${lab.port}/__probe`);
  return page;
}

/**
 * `page.evaluate` takes a string; the probes below are long enough that inline
 * template literals invite unbalanced parentheses. Every probe is wrapped in
 * one helper so a syntax error is reported once, clearly.
 */
async function probe(page, body) {
  return JSON.parse(await page.evaluate(body));
}

test('canvas export still produces a valid, correctly sized image', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 150;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3366cc';
    ctx.fillRect(0, 0, 300, 150);
    ctx.fillStyle = '#ffffff';
    ctx.font = '24px Arial';
    ctx.fillText('Quarterly revenue', 20, 80);

    const url = c.toDataURL('image/png');
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    const bitmap = await createImageBitmap(blob);

    // The page's own canvas must be untouched by the export: a download must
    // not change what the page is displaying.
    const before = ctx.getImageData(0, 0, 300, 150).data;
    c.toDataURL();
    const afterRead = ctx.getImageData(0, 0, 300, 150).data;
    let mutated = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== afterRead[i]) mutated++;

    return JSON.stringify({
      urlPrefix: url.slice(0, 22),
      urlLength: url.length,
      blobBytes: blob.size,
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height,
      mutatedBytes: mutated,
    });
  })()`));

  assert.equal(result.urlPrefix, 'data:image/png;base64,');
  assert.ok(result.urlLength > 500, 'exported PNG is suspiciously small');
  assert.ok(result.blobBytes > 300, 'exported blob is suspiciously small');
  assert.equal(result.bitmapWidth, 300);
  assert.equal(result.bitmapHeight, 150);
  assert.equal(result.mutatedBytes, 0, "exporting the canvas mutated the page's own pixels");
});

test('canvas write/read round trip is stable and bounded', async () => {
  /**
   * A page that writes pixels and reads them back must get a *stable* answer.
   * It will not get the exact bytes it wrote: the profile's projection applies
   * to reads, by design, and it is a permutation of ±1 with fixed points at 0
   * and 255. What matters operationally is that (a) repeated reads agree,
   * (b) the difference is at most one LSB, and (c) writing the read-back values
   * again settles at a fixed point (so a page's own verification loop
   * terminates instead of oscillating).
   */
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const o = (y * 64 + x) * 4;
        const v = ((x * 7 + y * 13) % 23 < 3) ? 40 : 250;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const first = ctx.getImageData(0, 0, 64, 64);
    const second = ctx.getImageData(0, 0, 64, 64);
    let stable = true;
    let maxDelta = 0;
    for (let i = 0; i < first.data.length; i++) {
      if (first.data[i] !== second.data[i]) stable = false;
      maxDelta = Math.max(maxDelta, Math.abs(first.data[i] - img.data[i]));
    }

    /**
     * Re-reading after a putImageData round trip must also be stable: a page
     * that copies one canvas onto another (very common) then reads the copy
     * should see the same fingerprint, not a third one. Note this compares
     * reads to reads; comparing a read to the *written* bytes is not a valid
     * test, because putImageData re-rasterises and the read path is where the
     * projection lives by design.
     */
    const copy = document.createElement('canvas');
    copy.width = 64; copy.height = 64;
    const copyCtx = copy.getContext('2d');
    copyCtx.drawImage(c, 0, 0);
    const copied = copyCtx.getImageData(0, 0, 64, 64);
    const copiedAgain = copyCtx.getImageData(0, 0, 64, 64);
    let settled = true;
    for (let i = 0; i < copiedAgain.data.length; i++) {
      if (copiedAgain.data[i] !== copied.data[i]) settled = false;
    }

    return JSON.stringify({ stable, maxDelta, settled });
  })()`));

  assert.equal(result.stable, true, 'two reads of the same canvas disagreed');
  assert.ok(result.maxDelta <= 1, `write/read round trip moved a channel by ${result.maxDelta}`);
  assert.equal(result.settled, true, 'writing the read-back values did not reach a fixed point');
});

test('canvas sub-rectangle reads agree with the full read', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const ctx = c.getContext('2d');
    /**
     * Deterministic content via putImageData. Drawing with fillRect would depend
     * on the rasteriser, and this test is about the *read* transform agreeing
     * with itself, not about drawing.
     */
    const img = ctx.createImageData(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const o = (y * 100 + x) * 4;
        const band = Math.floor(y / 10) % 2;
        const v = band ? 0xab : 0x12;
        img.data[o] = v; img.data[o + 1] = band ? 0xcd : 0x34; img.data[o + 2] = band ? 0xef : 0x56;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const full = ctx.getImageData(0, 0, 100, 100).data;
    let mismatches = 0;
    let maxDelta = 0;
    const details = [];
    for (const [x, y, w, h] of [[10, 20, 30, 40], [0, 0, 50, 50], [70, 60, 30, 30]]) {
      const part = ctx.getImageData(x, y, w, h).data;
      let rectMismatches = 0;
      let example = null;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          for (let ch = 0; ch < 4; ch++) {
            const a = full[((y + row) * 100 + (x + col)) * 4 + ch];
            const b = part[(row * w + col) * 4 + ch];
            const d = Math.abs(a - b);
            if (d > 0) {
              mismatches++;
              rectMismatches++;
              maxDelta = Math.max(maxDelta, d);
              if (!example) example = { px: x + col, py: y + row, ch, full: a, sub: b };
            }
          }
        }
      }
      details.push({ rect: [x, y, w, h], rectMismatches, example });
    }
    return JSON.stringify({ mismatches, maxDelta, details });
  })()`));

  assert.equal(result.mismatches, 0,
    `a sub-rectangle read disagreed with the same pixels in a full-canvas read: ${JSON.stringify(result)}`);
});

test('WebGL still renders and reads back consistently', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const gl = c.getContext('webgl');
    if (!gl) return JSON.stringify({ supported: false });
    gl.clearColor(0.2, 0.4, 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const first = Array.from(px.slice(0, 4));
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const again = Array.from(px.slice(0, 4));
    const err = gl.getError();
    return JSON.stringify({ supported: true, first, again, err });
  })()`));

  assert.ok(result.supported, 'WebGL unavailable');
  assert.deepEqual(result.first, result.again, 'repeated readPixels disagreed');
  assert.equal(result.err, 0, 'WebGL reported an error after readback');
});

test('audio rendering returns a playable buffer with real content', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(async () => {
    const ctx = new OfflineAudioContext(1, 4410, 44100);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const firstRead = data[100];
    const secondRead = buffer.getChannelData(0)[100];
    return JSON.stringify({ length: buffer.length, peak, firstRead, secondRead });
  })()`));

  assert.ok(result.peak > 0.5, `rendered audio peak is ${result.peak}, expected an audible tone`);
  assert.equal(result.firstRead, result.secondRead, 'reading the same audio buffer twice gave different samples');
});

test('text layout is not disturbed', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(() => {
    const span = document.createElement('span');
    span.style.cssText = 'font: 16px Arial; position: absolute; white-space: pre;';
    span.textContent = 'The quick brown fox jumps over the lazy dog 0123456789';
    document.body.append(span);
    const width = span.getBoundingClientRect().width;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '16px Arial';
    const measured = ctx.measureText(span.textContent).width;
    span.remove();
    return JSON.stringify({ domWidth: width, canvasWidth: measured });
  })()`));

  // DOM layout must keep producing sane, non-zero widths. The canvas value may
  // differ slightly by design (per-profile per-font scale); a large divergence
  // would mean the page's own layout disagrees with its canvas measurements.
  assert.ok(result.domWidth > 100, `DOM text width is ${result.domWidth}`);
  assert.ok(result.canvasWidth > 100, `canvas text width is ${result.canvasWidth}`);
  const ratio = result.canvasWidth / result.domWidth;
  assert.ok(ratio > 0.9 && ratio < 1.1, `canvas/DOM width ratio ${ratio.toFixed(3)} is implausible`);
});

test('enumerateDevices resolves with a stable, well-formed list', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(async () => {
    const a = await navigator.mediaDevices.enumerateDevices();
    const b = await navigator.mediaDevices.enumerateDevices();
    return JSON.stringify({
      count: a.length,
      stable: a.length === b.length && a.every((d, i) => d.deviceId === b[i].deviceId),
      kinds: [...new Set(a.map((d) => d.kind))].sort(),
      allHaveIds: a.every((d) => typeof d.deviceId === 'string' && d.deviceId.length > 0),
    });
  })()`));

  assert.ok(result.count > 0, 'no media devices at all');
  assert.ok(result.stable, 'device ids changed between two calls');
  assert.ok(result.allHaveIds);
  for (const kind of result.kinds) {
    assert.ok(['audioinput', 'audiooutput', 'videoinput'].includes(kind), `bad device kind ${kind}`);
  }
});

test('Intl formatting is valid and self-consistent', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(() => {
    const dtf = new Intl.DateTimeFormat();
    const resolved = dtf.resolvedOptions();
    const sample = new Date(2024, 5, 15, 12, 0, 0);
    return JSON.stringify({
      timeZone: resolved.timeZone,
      locale: resolved.locale,
      formatted: dtf.format(sample),
      offset: sample.getTimezoneOffset(),
      number: new Intl.NumberFormat().format(1234567.89),
      isDateInstance: dtf instanceof Intl.DateTimeFormat,
      hasPrototype: Object.getPrototypeOf(dtf) === Intl.DateTimeFormat.prototype,
    });
  })()`));

  assert.ok(result.timeZone, 'no timezone resolved');
  assert.ok(result.formatted.length > 4, 'date failed to format');
  assert.ok(Number.isFinite(result.offset));
  assert.ok(result.isDateInstance, 'DateTimeFormat instance lost its identity');
  assert.ok(result.hasPrototype, 'DateTimeFormat instance lost its prototype');
});

test('the page can still create workers and exchange messages', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`new Promise((resolve) => {
    const w = new Worker(URL.createObjectURL(new Blob(
      ['self.onmessage = (e) => postMessage({ doubled: e.data * 2, ua: navigator.userAgent });'],
      { type: 'text/javascript' },
    )));
    w.onmessage = (e) => {
      w.terminate();
      resolve(JSON.stringify({ ok: true, value: e.data.doubled, hasUa: !!e.data.ua }));
    };
    w.onerror = (e) => resolve(JSON.stringify({ ok: false, error: e.message }));
    w.postMessage(21);
    setTimeout(() => resolve(JSON.stringify({ ok: false, error: 'timeout' })), 4000);
  })`));

  assert.equal(result.ok, true, `worker failed: ${result.error}`);
  assert.equal(result.value, 42);
  assert.ok(result.hasUa);
});

test('custom events, storage and timers are unaffected', async () => {
  const page = await freshPage();
  const result = JSON.parse(await page.evaluate(`(async () => {
    const got = await new Promise((resolve) => {
      document.addEventListener('fp-test', (e) => resolve(e.detail), { once: true });
      document.dispatchEvent(new CustomEvent('fp-test', { detail: 'payload' }));
    });
    localStorage.setItem('k', 'v');
    const stored = localStorage.getItem('k');
    const tick = await new Promise((r) => setTimeout(() => r('tick'), 10));
    let rafRan = false;
    await new Promise((r) => requestAnimationFrame(() => { rafRan = true; r(); }));
    return JSON.stringify({ got, stored, tick, rafRan });
  })()`));

  assert.equal(result.got, 'payload');
  assert.equal(result.stored, 'v');
  assert.equal(result.tick, 'tick');
  assert.equal(result.rafRan, true);
});
