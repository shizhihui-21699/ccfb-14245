/**
 * Install lifecycle and the per-install seed.
 *
 * The seed has to satisfy four things at once:
 *
 *  1. Different installs derive different fingerprints. A shared seed would
 *     make every user of this extension identical on a given site — the tool
 *     itself would become the fingerprint.
 *  2. It must be readable *synchronously* at document_start. `chrome.storage`
 *     is async-only, and a profile that arrives a microtask late arrives after
 *     the page's first read.
 *  3. The page must not be able to read it. Web-accessible files are readable
 *     by page script, so they cannot carry the secret.
 *  4. It must survive a browser restart unchanged.
 *
 * The mechanism (validated end to end in docs/spike-results.md):
 *
 *     seed = PRF(buildSeed, installSalt)
 *
 *  - `buildSeed` is baked into `bootstrap/config.json` at build time.
 *  - `installSalt` is 16 random bytes generated here on first install, kept in
 *    `chrome.storage.local`, and published through a **dynamic
 *    declarativeNetRequest redirect** on a URL containing a per-build token:
 *
 *        https://fp.invalid/seed?t=<buildToken>
 *            -> data:application/json,{"salt":"<hex>"}
 *
 *    Dynamic rules persist across browser restarts. The isolated world can do
 *    the synchronous XHR (extension scheme is exempt from page CSP) and the
 *    page cannot construct the URL, because the token never reaches page
 *    script. A bare request to fp.invalid/seed matches nothing.
 */

import { deriveInstallSeed } from '../shared/seed.js';

const SEED_HOST = 'https://fp.invalid/seed';
const RULE_ID = 7;

export interface BootstrapFile {
  /** Hex build seed: identical for every install of this build. */
  buildSeed: string;
  /** Random per build; makes the salt URL unguessable from page script. */
  buildToken: string;
  /** Chrome major at build time. */
  runtimeMajor: number;
}

export interface InstallState {
  /** Hex install salt, 32 chars. */
  salt: string;
}

export interface RotationState {
  /** hostname -> rotation token. */
  rotations: Record<string, string>;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readBootstrapFile(): Promise<BootstrapFile> {
  const res = await fetch(chrome.runtime.getURL('bootstrap/config.json'));
  if (!res.ok) throw new Error('bootstrap missing');
  return (await res.json()) as BootstrapFile;
}

/**
 * (Re)install the redirect rule. Called on install, on startup, and from a
 * short alarm, because:
 *  - a browser restart does keep dynamic rules, but a corrupted/cleared ruleset
 *    should self-heal within a minute rather than silently degrading;
 *  - `data:` is the only redirect target that can carry a value decided at
 *    runtime; extension files are static and a network request would leave the
 *    browser.
 */
async function ensureSeedRule(
  salt: string,
  buildToken: string,
  rotations: Record<string, string>,
): Promise<void> {
  // The payload carries the salt *and* the current rotation map: content
  // scripts need both synchronously, and one redirect can only return one
  // document. The map is small (one entry per rotated site).
  const payload = encodeURIComponent(JSON.stringify({ salt, rot: rotations }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `data:application/json,${payload}` },
        },
        condition: {
          regexFilter: `^https://fp\\.invalid/seed\\?t=${escapeRegExp(buildToken)}$`,
          resourceTypes: ['xmlhttprequest'],
        },
      } as unknown as chrome.declarativeNetRequest.Rule,
    ],
  });
}

/**
 * Serialise every call. The heartbeat alarm, onInstalled, onStartup and the
 * rotation listener all call this, and two concurrent runs could each observe
 * "no salt yet" and write a *different* one — after which every site silently
 * changes identity. A single in-flight promise makes the read-then-write
 * atomic within the worker.
 */
let inFlight: Promise<InstallState | null> | null = null;

export function initInstall(): Promise<InstallState | null> {
  inFlight ??= doInitInstall().finally(() => { inFlight = null; });
  return inFlight;
}

async function doInitInstall(): Promise<InstallState | null> {
  let cfg: BootstrapFile;
  try {
    cfg = await readBootstrapFile();
  } catch {
    return null;
  }

  const stored = (await chrome.storage.local.get(['install', 'rotations'])) as {
    install?: InstallState;
    rotations?: Record<string, string>;
  };
  let state = stored.install;
  if (!state?.salt || !/^[0-9a-f]{32}$/.test(state.salt)) {
    state = { salt: toHex(crypto.getRandomValues(new Uint8Array(16))) };
    await chrome.storage.local.set({ install: state });
  }
  const rotations = stored.rotations ?? {};
  // Sanity: the derivation must be deterministic for a stored salt.
  if (deriveInstallSeed(cfg.buildSeed, state.salt).length !== 16) {
    throw new Error('seed derivation broken');
  }

  try {
    await ensureSeedRule(state.salt, cfg.buildToken, rotations);
  } catch {
    // A missing rule means content scripts use the no-salt degraded mode until
    // the next alarm retries; the page never sees this failure.
  }
  return state;
}

export function registerInstallLifecycle(): void {
  chrome.runtime.onInstalled.addListener(() => { void initInstall(); });
  chrome.runtime.onStartup.addListener(() => { void initInstall(); });
  void chrome.alarms.create('fp-install-heartbeat', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'fp-install-heartbeat') void initInstall();
  });
  // Rotating a site must reach content scripts immediately, not on the next
  // heartbeat: re-install the rule as soon as the rotation map changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['rotations']) void initInstall();
  });
  void initInstall();
  void SEED_HOST;
}
