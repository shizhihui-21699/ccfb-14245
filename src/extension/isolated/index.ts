/**
 * Isolated-world bootstrap.
 *
 * Runs at document_start, before MAIN-world scripts and before the page's first
 * inline script. Its only job is to hand the MAIN world a profile, synchronously.
 * An async path (messaging the service worker, awaiting storage) loses the race
 * against the page's first script, and the page would then see the real
 * fingerprint on its first read.
 *
 * What the spike proved (docs/spike-results.md):
 *  - the isolated world can perform a synchronous XHR that the page's CSP does
 *    not block;
 *  - a dynamic declarativeNetRequest rule can redirect a tokenised https URL to
 *    a `data:` URL carrying the per-install salt, and that rule survives a
 *    browser restart;
 *  - the isolated world runs before the MAIN world.
 *
 * So:
 *   sync XHR  ->  { salt }                 (per-install, page cannot construct)
 *   seed = HMAC(buildSeed, salt)           (per-install, stable)
 *   profile = derive(seed, siteKey)        (pure, ~0.1 ms)
 *   write JSON to a DOM attribute; MAIN world reads and removes it
 */

import { deriveProfile } from '../shared/profile/builder.js';
import { deriveInstallSeed } from '../shared/seed.js';
import { siteKeyOf } from '../shared/etld.js';
import type { Profile } from '../shared/profile/types.js';

interface BootstrapFile {
  buildSeed: string;
  buildToken: string;
  runtimeMajor: number;
  workerShim: string;
}

const BOOTSTRAP_ATTR = 'data-fp-bootstrap';

function readBootstrap(): BootstrapFile | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', chrome.runtime.getURL('bootstrap/config.json'), false);
    xhr.send(null);
    if (xhr.status !== 200) return null;
    return JSON.parse(xhr.responseText) as BootstrapFile;
  } catch {
    return null;
  }
}

/**
 * Fetch the per-install salt synchronously through the dynamic DNR rule.
 *
 * Falls back to the build seed alone if the rule is not installed yet (first
 * run before the service worker has executed). The fallback is documented as a
 * degraded mode: fingerprints are then shared between installs of the same
 * build until the first service-worker run completes, which happens on install
 * and within a minute thereafter.
 */
interface InstallState {
  salt: string;
  rotations: Record<string, string>;
}

function readInstallState(cfg: BootstrapFile): InstallState | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `https://fp.invalid/seed?t=${encodeURIComponent(cfg.buildToken)}`, false);
    xhr.send(null);
    if (xhr.status !== 200) return null;
    const parsed = JSON.parse(xhr.responseText) as { salt?: unknown; rot?: unknown };
    if (typeof parsed.salt !== 'string' || !/^[0-9a-f]{32}$/.test(parsed.salt)) return null;
    const rotations: Record<string, string> = {};
    if (parsed.rot && typeof parsed.rot === 'object') {
      for (const [host, token] of Object.entries(parsed.rot as Record<string, unknown>)) {
        if (typeof token === 'string' && token.length < 64) rotations[host] = token;
      }
    }
    return { salt: parsed.salt, rotations };
  } catch {
    return null;
  }
}

/**
 * The *top-level* window's CSS viewport, read before the page can change it.
 *
 * Only the top frame constrains the profile. A subframe's `innerWidth` is its
 * own box, not the screen: a 1x1 tracking iframe would otherwise demand a panel
 * one pixel wide, and an iframe sized larger than the window (which pages do)
 * would reject every real panel. The screen is a property of the machine, so
 * every frame in the tab must derive from the top frame's viewport — otherwise
 * the parent and child see different profiles.
 */
function readViewport(): { width: number; height: number } | undefined {
  try {
    if (window.top !== window) return undefined;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
    return { width, height };
  } catch {
    // Cross-origin top: this frame cannot read the real viewport, so it applies
    // no constraint rather than a wrong one.
    return undefined;
  }
}

function frameSiteKey(): string {
  try {
    if (location.protocol === 'about:' || location.href === 'about:blank') {
      const parentHost = (window.parent as Window & { location?: Location }).location?.hostname;
      if (parentHost) return siteKeyOf({ protocol: 'https:', hostname: parentHost });
    }
  } catch {
    // Cross-origin parent: fall through to our own host.
  }
  return siteKeyOf({ protocol: location.protocol, hostname: location.hostname });
}

export function bootstrap(): void {
  const cfg = readBootstrap();
  if (!cfg) return;

  const state = readInstallState(cfg);
  // A per-site rotation from the options page is part of the seed input, so it
  // changes that site only and stays stable afterwards. Rotations live in
  // extension storage, which page script cannot read.
  const key = frameSiteKey();
  const rotation = state?.rotations?.[location.hostname] ?? null;
  const seed = deriveInstallSeed(
    cfg.buildSeed,
    state === null ? null : `${state.salt}${rotation ? `:${rotation}` : ''}`,
  );

  let profile: Profile;
  try {
    profile = deriveProfile(seed, key, {
      runtimeMajor: cfg.runtimeMajor,
      /**
       * The real viewport, so the profile never claims a panel smaller than the
       * window. This is the constraint that prevents `innerWidth > screen.width`
       * — the easiest contradiction a detector can read.
       */
      minViewport: readViewport(),
    });
  } catch {
    return;
  }

  const worker = {
    shimUrl: chrome.runtime.getURL(cfg.workerShim),
    siteKey: profile.siteKey,
  };

  document.documentElement.setAttribute(BOOTSTRAP_ATTR, JSON.stringify({ profile, worker }));

  // Tell the background which host we derived for, so it can install the
  // header rule before the next navigation (the wire-level UA has to agree with
  // what this page reports). Fire-and-forget: no page-visible effect.
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    try {
      chrome.runtime.sendMessage({ type: 'fp:seen-host', host: location.hostname });
    } catch { /* extension context invalidated: nothing to do */ }
  }
}

bootstrap();
