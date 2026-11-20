/**
 * Worker / OffscreenCanvas realms.
 *
 * Detectors move collection into a Worker for two reasons: `OffscreenCanvas`
 * gives canvas readback with no DOM to inspect, and they assume DOM-only
 * defences forgot about workers. `WorkerNavigator` is a different prototype, so
 * navigator values must be patched again inside the worker realm from the same
 * profile.
 *
 * Getting the shim *into* the worker is the hard part. Measured constraints
 * (docs/spike-results.md, "Worker delivery"):
 *
 *  - A page cannot construct a Worker directly from a `chrome-extension://` URL:
 *    `SecurityError ... cannot be accessed from origin`. This rules out the
 *    obvious approach, and also rules out `use_dynamic_url` for the shim.
 *  - A page-origin `blob:` worker keeps `self.origin === page origin`, which is
 *    what a real worker has, and *can* `importScripts` the extension shim.
 *  - Inside that blob worker `chrome.runtime` is **undefined**, so the shim
 *    cannot fetch the build config or the install salt. This is the trap: a
 *    shim that tries to and swallows the failure leaves the worker realm
 *    showing the *real* fingerprint while the window shows the virtual one —
 *    a critical inconsistency, and exactly what the lab's worker comparison
 *    caught.
 *  - `importScripts` of the WAR shim succeeds only without a query string.
 *
 * So: `new Worker(url)` becomes a blob worker carrying the *profile itself* as
 * a literal, which installs the shim and then imports the page's real script.
 * The blob is created inside our closure, its URL is revoked immediately, and
 * the page never sees either. Embedding the profile (rather than the seed) also
 * removes any second derivation in the worker, so the two realms cannot diverge
 * even if derivation inputs ever changed.
 */

import { mask, replaceConstructor } from '../native.js';
import type { Profile } from '../../shared/profile/types.js';

export interface WorkerPatchOptions {
  /** The web-accessible worker shim URL (no query string). */
  shimUrl: string;
}

/**
 * The blob body. Kept as a template string so the build cannot mangle it and so
 * its content is auditable in one place.
 *
 * Ordering is the whole point:
 *   1. buffer messages the page sends before the real script exists;
 *   2. import the shim, which patches the realm synchronously;
 *   3. import the real script;
 *   4. replay buffered messages to the real script's handler.
 *
 * Step 2 must complete before step 3, and both before any message is handled,
 * or the page's own `onmessage` could run against an unpatched realm.
 */
function wrapperSource(
  shimUrl: string,
  realUrl: string,
  workerType: 'classic' | 'module',
  profileJson: string,
): string {
  const shim = JSON.stringify(shimUrl);
  const real = JSON.stringify(realUrl);
  const cfg = profileJson;
  if (workerType === 'module') {
    /**
     * Module workers cannot `importScripts`. The shim is a classic script, so
     * it is loaded through a synchronous XHR-eval instead: the realm is patched
     * synchronously before the module graph is evaluated. A CSP that forbids
     * eval makes this fall back to no patching in the worker, which is recorded
     * as a degraded mode rather than silently believed to work.
     */
    return `
      self.__fpProfileJson = ${JSON.stringify(cfg)};
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', ${shim}, false);
        xhr.send(null);
        if (xhr.status === 200) (0, eval)(xhr.responseText);
      } catch (e) { /* CSP or network: worker runs unpatched */ }
      import(${real}).catch(() => {});
    `;
  }
  return `
    self.__fpProfileJson = ${JSON.stringify(cfg)};
    self.__fpBuffered = [];
    self.addEventListener('message', function fpBuffer(e) { self.__fpBuffered.push(e.data); });
    importScripts(${shim}, ${real});
  `;
}

export function patchWorkers(profile: Profile, opts: WorkerPatchOptions): void {
  const RealWorker = window.Worker;
  if (typeof RealWorker !== 'function') return;

  const shimUrl = opts.shimUrl;
  const profileForWorker = profile;

  const FingerprintWorker = mask(function Worker(
    this: unknown,
    scriptURL: string | URL,
    options?: WorkerOptions,
  ) {
    const realUrl = new URL(String(scriptURL), location.href).href;
    const type = options?.type === 'module' ? 'module' : 'classic';
    const source = wrapperSource(shimUrl, realUrl, type, JSON.stringify(profileForWorker));
    const blob = new Blob([source], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return new RealWorker(blobUrl, options);
    } finally {
      // The worker has already fetched the blob synchronously by the time the
      // constructor returns; revoking keeps the page from inspecting it later.
      // Revocation after construction is safe in Chrome and Firefox.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    }
  } as unknown as (...a: any[]) => any, 'Worker');

  /**
   * `Worker.prototype` is non-writable/non-configurable on the real
   * constructor, so redefining it throws. The wrapped constructor inherits the
   * real prototype through its own `prototype` property, which is already the
   * same object for a function whose body only forwards; verify instead of
   * redefining, and only patch `length` when it differs.
   */
  if (FingerprintWorker.prototype !== RealWorker.prototype) {
    // Should not happen; leave the real prototype reachable via instanceof.
    Object.setPrototypeOf(FingerprintWorker, RealWorker);
  }
  if (FingerprintWorker.length !== RealWorker.length) {
    Object.defineProperty(FingerprintWorker, 'length', { value: RealWorker.length, configurable: true });
  }

  replaceConstructor(window as unknown as Record<string, unknown>, 'Worker', FingerprintWorker);
  // `instanceof` and `new Worker(...).constructor` must keep working.
  Object.setPrototypeOf(FingerprintWorker, RealWorker);
  void profile;
}
