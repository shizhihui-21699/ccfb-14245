/**
 * Wire-level header coherence.
 *
 * Everything patched in the page realm is invisible to the server. A detector
 * running server-side compares the `User-Agent` request header against what the
 * page reports and has its answer immediately — no clever probing needed. Client
 * Hints make this worse: `sec-ch-ua` is sent on the first navigation request,
 * before any page script runs.
 *
 * So headers are rewritten by declarativeNetRequest session rules, one per host,
 * derived from the *same* profile the page sees. Two constraints from the spike
 * shape this design:
 *
 *  - Installing a rule from `webNavigation.onBeforeNavigate` races the main
 *    frame request and loses on first visit, so a rule for a host must exist
 *    *before* the user navigates. We learn hosts from onCommitted (below), which
 *    covers every host the user has visited before; the very first visit to a
 *    brand-new host is the one unavoidable gap and is documented.
 *  - The extension cannot derive a profile without knowing the build seed and
 *    install salt, both of which live in the service worker. The isolated world
 *    sends the host it derived a profile for (the profile itself never travels),
 *    and the worker derives the identical profile from the same inputs.
 */

import { deriveProfile } from '../shared/profile/builder.js';
import { siteKeyOf } from '../shared/etld.js';
import { deriveInstallSeed } from '../shared/seed.js';
import type { Profile } from '../shared/profile/types.js';

interface BootstrapFile {
  buildSeed: string;
  buildToken: string;
  runtimeMajor: number;
}

const RULE_ID_BASE = 10_000;
const MAX_RULES = 800;
const ALIAS_RULE_ID = 9; // reserved for the seed redirect in install.ts

const knownHosts = new Map<string, { ruleId: number; profile: Profile }>();
let nextRuleId = RULE_ID_BASE;
let bootstrapPromise: Promise<BootstrapFile | null> | null = null;
let seedPromise: Promise<Uint8Array | null> | null = null;
let runtimeMajor = 140;

async function getBootstrap(): Promise<BootstrapFile | null> {
  bootstrapPromise ??= fetch(chrome.runtime.getURL('bootstrap/config.json'))
    .then((r) => (r.ok ? (r.json() as Promise<BootstrapFile>) : null))
    .catch(() => null);
  return bootstrapPromise;
}

async function getSeed(): Promise<Uint8Array | null> {
  seedPromise ??= (async () => {
    const cfg = await getBootstrap();
    if (!cfg) return null;
    const stored = (await chrome.storage.local.get('install')) as { install?: { salt?: string } };
    const salt = stored.install?.salt;
    if (!salt) return null;
    return deriveInstallSeed(cfg.buildSeed, salt);
  })();
  return seedPromise;
}

function headerValues(profile: Profile): Array<{ header: string; operation: 'set'; value: string }> {
  const ua = profile.ua;
  const brandList = [
    `"${ua.notABrand.brand}";v="${ua.notABrand.version}"`,
    `"Chromium";v="${ua.chromeMajor}"`,
    `"Google Chrome";v="${ua.chromeMajor}"`,
  ].join(', ');

  return [
    { header: 'user-agent', operation: 'set', value: ua.ua },
    { header: 'sec-ch-ua', operation: 'set', value: brandList },
    { header: 'sec-ch-ua-mobile', operation: 'set', value: '?0' },
    { header: 'sec-ch-ua-platform', operation: 'set', value: `"${ua.uaDataPlatform}"` },
    { header: 'accept-language', operation: 'set', value: acceptLanguage(ua.languages) },
  ];
}

/** BCP-47 Accept-Language with descending q-values, like Chrome produces. */
export function acceptLanguage(languages: string[]): string {
  const primary = languages[0] ?? 'en-US';
  const base = primary.split('-')[0]!;
  const ordered: string[] = [primary];
  for (const l of languages.slice(1)) {
    if (!ordered.some((o) => o.split(';')[0] === l)) ordered.push(l);
  }
  if (!ordered.some((o) => o.split(';')[0] === base)) ordered.push(base);
  const qs = [1, 0.9, 0.8, 0.7, 0.6];
  return ordered
    .slice(0, qs.length)
    .map((l, i) => (i === 0 ? l : `${l};q=${qs[i]!.toFixed(1)}`))
    .join(',');
}

async function syncRules(): Promise<void> {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  for (const [host, rec] of knownHosts) {
    rules.push({
      id: rec.ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: headerValues(rec.profile),
      },
      condition: {
        requestDomains: [host],
        resourceTypes: [
          'main_frame', 'sub_frame', 'xmlhttprequest', 'script',
          'stylesheet', 'image', 'font', 'media', 'websocket', 'other',
        ] as chrome.declarativeNetRequest.ResourceType[],
      },
    });
  }
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map((r) => r.id).filter((id) => id >= RULE_ID_BASE);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: rules });
}

async function ensureHost(host: string): Promise<void> {
  if (knownHosts.has(host) || knownHosts.size >= MAX_RULES) return;
  const [cfg, seed] = await Promise.all([getBootstrap(), getSeed()]);
  if (!cfg || !seed) return;
  const profile = deriveProfile(seed, siteKeyOf({ protocol: 'https:', hostname: host }), {
    runtimeMajor: cfg.runtimeMajor || runtimeMajor,
  });
  knownHosts.set(host, { ruleId: nextRuleId++, profile });
  await syncRules();
}

export function registerHeaderRules(): void {
  runtimeMajor = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? runtimeMajor);

  const onNav = (details: chrome.webNavigation.WebNavigationBaseCallbackDetails): void => {
    if (details.frameId !== 0 && details.frameId !== 1) return;
    try {
      const url = new URL(details.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      void ensureHost(url.hostname);
    } catch { /* malformed URL: nothing to do */ }
  };
  chrome.webNavigation.onCommitted.addListener(onNav);

  // The isolated world reports each host it derived a profile for. This makes
  // rule creation happen on first visit rather than second.
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const m = msg as { type?: string; host?: string } | null;
    if (m?.type === 'fp:seen-host' && typeof m.host === 'string' && m.host.length < 300) {
      void ensureHost(m.host).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  // Re-assert rules after the service worker restarts; session rules survive
  // within a browser session but are cheap to re-sync from our own cache.
  void syncRules();
  void RULE_ID_BASE;
  void ALIAS_RULE_ID;
}
