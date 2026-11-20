/**
 * Options page.
 *
 * Read-only diagnostics for the researcher: which site you are looking at, what
 * this install's seed is, and a short matrix of what is virtualised and what
 * deliberately is not. "Rotate this site's profile" is a research affordance —
 * it is the honest way to get a new identity without pretending the tool can
 * hide that a rotation happened.
 */

import { deriveProfile } from '../shared/profile/builder.js';
import { deriveInstallSeed } from '../shared/seed.js';
import { siteKeyOf } from '../shared/etld.js';

interface BootstrapFile {
  buildSeed: string;
  buildToken: string;
  runtimeMajor: number;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const MATRIX: Array<[string, string]> = [
  ['User-Agent / Client Hints', 'Page API and request headers, one profile'],
  ['hardwareConcurrency / deviceMemory', 'Device class from a real-hardware corpus'],
  ['Screen / DPR / orientation', 'Real panel dimensions, taskbar/menubar accounted for'],
  ['Canvas 2D + OffscreenCanvas', 'Edge-masked 1-LSB projection, idempotent'],
  ['WebGL vendor / renderer / limits', 'Matched to OS and GPU family'],
  ['WebGL readPixels', 'Same projection as canvas'],
  ['AudioContext / Analyser', 'Sub-audible deterministic offset'],
  ['Font enumeration', 'check() and measureText answered from one table'],
  ['Intl / timezone / languages', 'Region-coherent locale pair'],
  ['mediaDevices', 'Stable synthesized ids when unpermitted'],
  ['Worker / OffscreenCanvas realm', 'Same profile re-derived inside the worker'],
  ['TLS / JA3 / HTTP2', 'Not virtualised — not reachable from an extension'],
];

async function loadBootstrap(): Promise<BootstrapFile> {
  const res = await fetch(chrome.runtime.getURL('bootstrap/config.json'));
  return (await res.json()) as BootstrapFile;
}

async function refresh(): Promise<void> {
  const cfg = await loadBootstrap();
  $('build-seed').textContent = cfg.buildSeed.slice(0, 12) + '…';

  // build.json sits next to the extension folder, not inside it: an unpacked
  // extension cannot reach outside its root. The build id is therefore baked
  // into the manifest version comment instead (see scripts/build.mjs).
  $('build-id').textContent = chrome.runtime.getManifest().version;

  const stored = (await chrome.storage.local.get('install')) as { install?: { salt: string } };
  $('salt').textContent = stored.install?.salt ? stored.install.salt.slice(0, 12) + '…' : 'not initialised yet';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? safeUrl(tab.url) : null;
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    $('site-note').textContent = 'This tab has no web origin; open the site you are researching.';
    return;
  }
  $('site-note').textContent = `Showing the profile for ${url.hostname} (site key: ${siteKeyOf(url)}).`;

  const salt = stored.install?.salt ?? null;
  const seed = deriveInstallSeed(cfg.buildSeed, salt);
  const profile = deriveProfile(seed, siteKeyOf(url), { runtimeMajor: cfg.runtimeMajor, unsafe: true });

  const dl = $('profile');
  dl.innerHTML = '';
  const rows: Array<[string, string]> = [
    ['OS / device', `${profile.hardware.os} · ${profile.hardware.deviceClass}`],
    ['CPU cores / memory', `${profile.hardware.cores} · ${profile.hardware.memoryGB} GB`],
    ['GPU', profile.gpu.renderer.replace(/^ANGLE \(/, '').replace(/\)$/, '')],
    ['Screen', `${profile.screen.width}×${profile.screen.height} @ ${profile.screen.dpr}x`],
    ['User-Agent', profile.ua.ua],
    ['Languages / timezone', `${profile.ua.languages.join(', ')} · ${profile.ua.timeZone}`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }

  $('rotate').onclick = async () => {
    const perSite = `rotation:${siteKeyOf(url)}`;
    const got = (await chrome.storage.local.get('rotations')) as { rotations?: Record<string, string> };
    const rotations = got.rotations ?? {};
    rotations[perSite] = crypto.randomUUID();
    await chrome.storage.local.set({ rotations });
    $('rotate-note').textContent = 'Rotated. Reload the site to pick up the new identity.';
  };
  $('rotate-note').textContent = '';
}

function safeUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

async function init(): Promise<void> {
  const tbody = $('matrix');
  for (const [a, b] of MATRIX) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = a;
    const td2 = document.createElement('td');
    td2.textContent = b;
    tr.append(td1, td2);
    tbody.append(tr);
  }

  $('open-lab').onclick = () => {
    // The lab is built as a separate site (dist/lab) and served over http so it
    // behaves like a real third-party origin. The options page links to the
    // local server started by `npm run serve`.
    void chrome.tabs.create({ url: 'http://127.0.0.1:5391/' });
  };
  $('reset').onclick = async () => {
    await chrome.storage.local.remove(['install', 'rotations']);
    $('reset-note').textContent =
      'Salt cleared. A new one is generated on the next service-worker tick; every site will see a new identity.';
    await refresh();
  };

  await refresh();
}

void init();
