/**
 * Build the extension and the fingerprint lab.
 *
 * Outputs:
 *   dist/extension/   load-unpacked MV3 extension (and a zip-able directory)
 *   dist/lab/         static test site (collectors + detectors + explorer)
 *
 * The build writes `bootstrap/config.json` with a fresh random build seed and
 * build token on every build. They are *not* secrets from someone who has the
 * .crx, but they are not visible to page script, which is all the salt delivery
 * channel needs (see background/install.ts).
 */

import { build, context } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const extOut = join(dist, 'extension');
const labOut = join(dist, 'lab');
const watch = process.argv.includes('--watch');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function hex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** Chrome major detected from the locally installed browser, so profiles
 *  never claim a version newer than the shell they run in. */
function detectChromeMajor() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const m = /(\d+)\.\d+\.\d+/.exec(out);
      if (m) return Number(m[1]);
    } catch { /* try next */ }
  }
  return 140;
}

function writeManifest(major) {
  const manifest = {
    manifest_version: 3,
    name: 'Fingerprint Sandbox',
    version: pkg.version,
    description: 'Per-site, internally consistent browser fingerprint virtualisation for OSINT research.',
    minimum_chrome_version: String(major - 2),
    background: { service_worker: 'background.js', type: 'module' },
    permissions: [
      'storage',
      'declarativeNetRequest',
      'webNavigation',
      'alarms',
      'scripting',
      'tabs',
    ],
    host_permissions: ['<all_urls>'],
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['isolated.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
      },
      {
        matches: ['<all_urls>'],
        js: ['main.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
        world: 'MAIN',
      },
    ],
    web_accessible_resources: [
      {
        /**
         * Config must be web-accessible for the isolated world to read it with
         * a synchronous XHR (a non-WAR file returns NetworkError; validated in
         * docs/spike-results.md).
         *
         * `use_dynamic_url` keeps it out of page reach: the real URL carries a
         * per-session GUID the page cannot compute, so page script cannot fetch
         * it and learn the build token.
         */
        resources: ['bootstrap/config.json'],
        matches: ['<all_urls>'],
        use_dynamic_url: true,
      },
      {
        /**
         * The worker shim must NOT use a dynamic URL. Chrome refuses
         * `importScripts` of a dynamic-URL resource from a page-origin blob
         * worker (NetworkError), which is the only path that gets our code into
         * a worker at all — a page cannot construct a Worker from a
         * chrome-extension:// URL. A static URL leaks nothing: the shim contains
         * no secret, and the profile is re-derived from the per-install salt.
         */
        resources: ['worker-shim.js'],
        matches: ['<all_urls>'],
      },
    ],
    options_ui: { page: 'options.html', open_in_tab: true },
    action: { default_title: 'Fingerprint Sandbox' },
  };
  writeFileSync(join(extOut, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function buildAll() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(extOut, 'bootstrap'), { recursive: true });
  mkdirSync(labOut, { recursive: true });

  const major = detectChromeMajor();
  const buildSeed = hex(16) + hex(16); // 32 bytes hex
  const buildToken = hex(8);
  writeManifest(major);
  writeFileSync(
    join(extOut, 'bootstrap', 'config.json'),
    JSON.stringify({ buildSeed, buildToken, runtimeMajor: major, workerShim: 'worker-shim.js' }, null, 2),
  );

  const common = {
    bundle: true,
    format: 'iife',
    target: ['chrome120'],
    logLevel: 'info',
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    legalComments: 'none',
  };

  const extEntries = [
    { in: join(root, 'src/extension/main/index.ts'), out: join(extOut, 'main.js') },
    { in: join(root, 'src/extension/isolated/index.ts'), out: join(extOut, 'isolated.js') },
    { in: join(root, 'src/extension/worker/index.ts'), out: join(extOut, 'worker-shim.js') },
    { in: join(root, 'src/extension/background/index.ts'), out: join(extOut, 'background.js') },
    { in: join(root, 'src/extension/options/index.ts'), out: join(extOut, 'options.js') },
  ];

  for (const e of extEntries) {
    const opts = { ...common, entryPoints: [e.in], outfile: e.out };
    if (watch) {
      const ctx = await context(opts);
      await ctx.watch();
    } else {
      await build(opts);
    }
  }

  cpSync(join(root, 'src/extension/options/options.html'), join(extOut, 'options.html'));

  // Lab: a single-page site with workers, iframes and an adversarial detector.
  const labEntries = [
    { in: join(root, 'src/lab/index.ts'), out: join(labOut, 'lab.js') },
    { in: join(root, 'src/lab/collector-worker.ts'), out: join(labOut, 'collector-worker.js') },
  ];
  for (const e of labEntries) {
    const opts = { ...common, entryPoints: [e.in], outfile: e.out, format: 'iife' };
    if (watch) {
      const ctx = await context(opts);
      await ctx.watch();
    } else {
      await build(opts);
    }
  }
  cpSync(join(root, 'src/lab/index.html'), join(labOut, 'index.html'));
  cpSync(join(root, 'src/lab/lab.css'), join(labOut, 'lab.css'));

  // A build fingerprint lets the lab assert it is talking to the build it thinks
  // it is (useful when iterating with --watch).
  const digest = createHash('sha256');
  for (const f of ['main.js', 'isolated.js', 'worker-shim.js', 'background.js']) {
    digest.update(readFileSync(join(extOut, f)));
  }
  writeFileSync(join(dist, 'build.json'), JSON.stringify({ buildId: digest.digest('hex').slice(0, 16), chromeMajor: major }, null, 2));
  console.log(`built extension (Chrome ${major}) -> ${extOut}`);
}

await buildAll();
