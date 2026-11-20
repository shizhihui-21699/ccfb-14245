/**
 * End-to-end runner: loads the built extension into a real Chrome, visits the
 * lab on two different origins, and returns the lab's own report.
 *
 * Two things here are load-bearing and were established by spikes, not guessed
 * (docs/spike-results.md):
 *
 *  - Chrome 157 no longer honours `--load-extension`. An unpacked extension is
 *    loaded through CDP `Extensions.loadUnpacked`, which requires
 *    `--enable-unsafe-extension-debugging`.
 *  - After a browser restart the extension must be re-loaded the same way.
 *
 * The runner deliberately does not use puppeteer's browser launcher: it needs a
 * pinned, throwaway profile and the exact flags above, and it wants to keep the
 * CDP surface small enough to read.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function chromePath() {
  for (const p of CHROME_CANDIDATES) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  throw new Error('no Chrome binary found; set CHROME_PATH');
}

/** Minimal CDP client over one browser-level websocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

async function waitFor(fn, { timeout = 8000, interval = 60 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out${lastErr ? `: ${lastErr.message}` : ''}`);
}

export class Browser {
  constructor({ chrome, cdp, userDataDir, port, extId }) {
    Object.assign(this, { chrome, cdp, userDataDir, port, extId });
  }

  /**
   * `persistent = true` keeps the profile directory between launches so a test
   * can simulate a browser restart. Without it the directory is a temp dir that
   * `close()` deletes, which means storage never survives — and a test that
   * "restarts the browser" without setting this is not restarting anything.
   */
  static async launch({ extensionPath, profileDir = null, port = null, headless = true, extraArgs = [] } = {}) {
    const ownsProfileDir = profileDir === null;
    const userDataDir = profileDir ?? mkdtempSync(join(tmpdir(), 'fp-lab-'));
    const debugPort = port ?? 9400 + Math.floor(Math.random() * 400);
    const args = [
      headless ? '--headless=new' : '--no-startup-window',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      /**
       * Headless Chrome has no real GPU, so WebGL is unavailable unless a
       * software rasteriser is allowed. Real fingerprinting scripts check WebGL
       * before anything else, so the lab must be able to run it: --use-gl swaps
       * in SwiftShader, which still exercises every WebGL code path we patch.
       */
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-background-networking',
      '--disable-sync',
      '--window-size=1440,900',
      '--enable-unsafe-extension-debugging',
      ...extraArgs,
    ];
    const chrome = spawn(chromePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (d) => { stderr += d.toString(); });

    const version = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return res.ok ? res.json() : null;
    }, { timeout: 15000 });
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    let extId = null;
    if (extensionPath) {
      const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
      extId = loaded.id;
      // Give the service worker a moment to run its install path (it creates
      // the per-install salt and the dynamic redirect rule content scripts need).
      await new Promise((r) => setTimeout(r, 900));
    }

    const b = new Browser({ chrome, cdp, userDataDir, port: debugPort, extId });
    b.stderr = () => stderr;
    b.ownsProfileDir = ownsProfileDir;
    return b;
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return new Page(this, targetId, sessionId);
  }

  /** Evaluate in the extension's service worker (diagnostics, storage). */
  async serviceWorkerEval(expression, { awaitPromise = true } = {}) {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(this.extId));
    if (!sw) throw new Error('service worker target not found');
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const out = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text ?? 'evaluate failed');
    return out.result?.value;
  }

  async close() {
    try { await this.cdp.send('Browser.close'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 250));
    try { this.chrome.kill('SIGKILL'); } catch { /* ignore */ }
    this.cdp.close();
    // Only delete a directory this launch created. A caller-supplied profile
    // is theirs: deleting it would silently break any "restart the browser"
    // test, which is exactly the bug this comment exists to prevent.
    if (this.ownsProfileDir && process.env.FP_KEEP_PROFILE !== '1') {
      try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  async evaluate(expression) {
    const out = await this.browser.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, this.sessionId);
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'evaluate failed');
    }
    return out.result?.value;
  }

  async waitForFunction(expression, opts) {
    return waitFor(async () => {
      try {
        const v = await this.evaluate(expression);
        return v ? v : null;
      } catch {
        return null;
      }
    }, opts);
  }

  async goto(url, { waitForLoad = true } = {}) {
    await this.browser.cdp.send('Page.navigate', { url }, this.sessionId);
    if (waitForLoad) {
      await this.waitForFunction('document.readyState === "complete"', { timeout: 15000 });
    }
  }

  async reload() {
    await this.browser.cdp.send('Page.reload', {}, this.sessionId);
    await this.waitForFunction('document.readyState === "complete"', { timeout: 15000 });
  }

  async close() {
    try { await this.browser.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* ignore */ }
  }
}

export { waitFor };
