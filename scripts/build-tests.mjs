/**
 * Build the shared derivation core to plain ESM for unit tests.
 *
 * The extension bundles with esbuild into IIFEs, which are not importable. The
 * tests need the real modules, not a reimplementation, so this produces a small
 * parallel build of just the pure modules under dist-test/.
 */

import { build } from 'esbuild';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-test');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    siphash: join(root, 'src/extension/shared/siphash.ts'),
    rng: join(root, 'src/extension/shared/rng.ts'),
    etld: join(root, 'src/extension/shared/etld.ts'),
    builder: join(root, 'src/extension/shared/profile/builder.ts'),
    invariants: join(root, 'src/extension/shared/profile/invariants.ts'),
    devices: join(root, 'src/extension/shared/profile/devices.ts'),
    seed: join(root, 'src/extension/shared/seed.ts'),
    farble: join(root, 'src/extension/main/farble.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['node20'],
  logLevel: 'error',
});

// The builder imports `./devices.js` etc.; esbuild's bundle-splitting keeps one
// output per entry, so re-export the pieces the tests reach into.
writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
console.log(`dist-test built at ${out}`);
