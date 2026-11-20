/**
 * End-to-end: the extension against the lab.
 *
 * What these tests assert is deliberately *not* "patching happened". They
 * assert the properties that make a virtualised profile survivable:
 *
 *  - the profile is in place before the page's first inline script;
 *  - hostile detectors find no critical/high inconsistency;
 *  - two different sites see different profiles, and one site keeps its own
 *    across reloads, tabs and a browser restart;
 *  - the worker realm agrees with the window;
 *  - request headers agree with what the page reports.
 *
 * A baseline run without the extension is included and used as a control: any
 * check that fails on stock Chrome is a flaw in the lab, not in the defence,
 * and must not be counted against the extension.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../support/browser.mjs';
import { startLabServer } from '../support/lab-server.mjs';

const EXTENSION = new URL('../../dist/extension', import.meta.url).pathname;

let lab;
let browserA; // extension loaded

before(async () => {
  lab = await startLabServer();
});

after(async () => {
  await browserA?.close();
  await lab?.close();
});

async function extensionBrowser(profileDir = null) {
  return Browser.launch({ extensionPath: EXTENSION, profileDir });
}

async function labReport(page, port) {
  await page.goto(`http://127.0.0.1:${port}/`, { waitForLoad: true });
  await page.waitForFunction('window.__labReport !== undefined', { timeout: 25000 });
  return page.evaluate('JSON.stringify(window.__labReport)').then(JSON.parse);
}

test('profile is installed before the page\'s first inline script', async () => {
  browserA = await extensionBrowser();
  const page = await browserA.newPage();
  await page.goto(`http://127.0.0.1:${lab.port}/__probe`);
  await page.waitForFunction('window.__readyProbe === true');
  const first = JSON.parse(await page.evaluate('JSON.stringify(window.__firstRead)'));

  assert.ok(first, 'first-read probe did not run');
  // The probe runs before every other script; anything it reads is what the
  // page saw at its first opportunity.
  assert.equal(first.toDataURLSource, 'function toDataURL() { [native code] }',
    'canvas survived unpatched on the very first read');
  assert.ok(!/HeadlessChrome/.test(first.ua), `first read saw the real UA: ${first.ua}`);
  assert.ok(first.cores > 0);
  assert.ok(first.screenW > 0);
});

test('lab finds no critical or high inconsistencies under the extension', async () => {
  const page = await browserA.newPage();
  const report = await labReport(page, lab.port);
  const blockers = report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  assert.deepEqual(
    blockers.map((f) => `${f.severity}: ${f.title} ${JSON.stringify(f.evidence)}`),
    [],
    `hostile detectors found ${blockers.length} blocker(s)`,
  );
});

test('baseline (no extension) is caught, proving the lab is not toothless', async () => {
  const baseline = await Browser.launch({});
  try {
    const page = await baseline.newPage();
    const report = await labReport(page, lab.port);
    const blockers = report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    // Headless Chrome reports an 800x600 screen while the window is 1440x900,
    // which is itself a genuine inconsistency; more importantly, the lab must
    // be capable of failing at all.
    assert.ok(blockers.length > 0, 'lab passed a stock browser, so its checks are vacuous');
  } finally {
    await baseline.close();
  }
});

const IDENTITY_FIELDS = `JSON.stringify([
  navigator.userAgent,
  navigator.platform,
  String(navigator.hardwareConcurrency),
  navigator.languages.join(','),
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  String(screen.width) + 'x' + String(screen.height),
  String(devicePixelRatio),
])`;

test('same site is stable across reloads and tabs; different sites differ', async () => {
  // Own browser: sharing one with other tests makes the "different sites differ"
  // assertion sensitive to whichever identities those tests happened to draw.
  const browser = await extensionBrowser();
  try {
    const page1 = await browser.newPage();
    await page1.goto(`http://127.0.0.1:${lab.port}/__probe`);
    const a1 = await page1.evaluate(IDENTITY_FIELDS);

    await page1.reload();
    await page1.waitForFunction('document.readyState === "complete"');
    const a2 = await page1.evaluate(IDENTITY_FIELDS);
    assert.equal(a2, a1, 'profile changed across a reload on the same site');

    const tab2 = await browser.newPage();
    await tab2.goto(`http://127.0.0.1:${lab.port}/__probe`);
    const a3 = await tab2.evaluate(IDENTITY_FIELDS);
    assert.equal(a3, a1, 'profile differed between two tabs on the same site');

    // localhost and 127.0.0.1 are different site keys, so they must differ.
    const other = await browser.newPage();
    await other.goto(`http://localhost:${lab.port}/__probe`);
    const b1 = await other.evaluate(IDENTITY_FIELDS);
    assert.notEqual(b1, a1, 'two different sites received the same profile');
  } finally {
    await browser.close();
  }
});

test('profile survives a browser restart on the same profile directory', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fp-restart-'));

  try {
    const first = await extensionBrowser(dir);
    const p1 = await first.newPage();
    await p1.goto(`http://127.0.0.1:${lab.port}/__probe`);
    const before = await p1.evaluate('navigator.userAgent + "|" + navigator.hardwareConcurrency + "|" + screen.width');
    await first.close();

    const second = await extensionBrowser(dir);
    const p2 = await second.newPage();
    await p2.goto(`http://127.0.0.1:${lab.port}/__probe`);
    const afterRestart = await p2.evaluate('navigator.userAgent + "|" + navigator.hardwareConcurrency + "|" + screen.width');
    await second.close();

    assert.equal(afterRestart, before, 'profile changed across a browser restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worker realm agrees with the window realm', async () => {
  const page = await browserA.newPage();
  await page.goto(`http://127.0.0.1:${lab.port}/__probe`);
  const windowFacts = JSON.parse(await page.evaluate(`JSON.stringify({
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })`));
  const workerFacts = JSON.parse(await page.evaluate(`(() => {
    const w = new Worker('/collector-worker.js');
    return new Promise((resolve) => {
      w.onmessage = (e) => { resolve(JSON.stringify(e.data)); w.terminate(); };
      w.onerror = (e) => { resolve(JSON.stringify({ error: e.message })); w.terminate(); };
      w.postMessage({ type: 'collect' });
      setTimeout(() => resolve(JSON.stringify({ error: 'timeout' })), 4000);
    });
  })()`));

  assert.ok(!workerFacts.error, `worker failed: ${workerFacts.error}`);
  assert.equal(workerFacts.ua, windowFacts.ua, 'worker UA differs from window');
  assert.equal(workerFacts.hardwareConcurrency, windowFacts.cores, 'worker cores differ from window');
  assert.equal(workerFacts.timeZone, windowFacts.tz, 'worker timezone differs from window');
});

test('canvas output agrees across window, worker and iframe realms', async () => {
  /**
   * A tracker compares realms because defences routinely patch one prototype
   * and forget another. `OffscreenCanvasRenderingContext2D` is a *different*
   * prototype from `CanvasRenderingContext2D`, so patching only the window
   * leaves worker canvas reads raw — a split the lab's context matrix caught.
   */
  const page = await browserA.newPage();
  await page.goto(`http://127.0.0.1:${lab.port}/`);
  await page.waitForFunction('window.__labReport !== undefined', { timeout: 25000 });
  const hashes = JSON.parse(await page.evaluate(`JSON.stringify({
    win: window.__labReport.snapshot.canvas.value.imageDataHash,
    worker: window.__labReport.snapshot.worker.value.canvasHash,
    iframe: window.__labReport.snapshot.iframe.value.canvasHash,
  })`));

  assert.ok(hashes.win, 'window canvas hash missing');
  assert.equal(hashes.worker, hashes.win, 'worker canvas differs from the window');
  assert.equal(hashes.iframe, hashes.win, 'iframe canvas differs from the window');
});

test('request headers agree with the page-reported identity', async () => {
  const page = await browserA.newPage();
  await page.goto(`http://127.0.0.1:${lab.port}/__wire`);
  await page.waitForFunction('window.__wire !== undefined', { timeout: 10000 });
  const wire = JSON.parse(await page.evaluate('JSON.stringify(window.__wire)'));
  const ua = await page.evaluate('navigator.userAgent');

  assert.equal(wire['user-agent'], ua,
    'the wire User-Agent differs from navigator.userAgent, which a server-side detector sees instantly');
  assert.ok(wire['sec-ch-ua'], 'sec-ch-ua header missing');
  assert.ok(!/HeadlessChrome/.test(wire['user-agent'] ?? ''), 'wire UA leaked HeadlessChrome');
});
