/**
 * Baseline vs. extended: the trade-off, measured.
 *
 * The design question "how much should be changed" has no answer without a
 * control. This script runs the same lab twice against the same Chrome binary:
 *
 *   A. no extension  — the real fingerprint, and the lab's own false positives;
 *   B. with extension — the virtualised fingerprint.
 *
 * It prints, for each run: every finding by severity, the values a tracker would
 * key on, and the cross-site identity comparison. That makes the two failure
 * modes visible side by side:
 *
 *   - under-changing: "different sites still look like the same machine";
 *   - over-changing:  "the page throws" / "the lab finds a contradiction".
 *
 * Usage:
 *   node scripts/compare.mjs
 */

import { Browser } from '../tests/support/browser.mjs';
import { startLabServer } from '../tests/support/lab-server.mjs';

const EXTENSION = new URL('../dist/extension', import.meta.url).pathname;

const IDENTITY_PROBE = `JSON.stringify({
  ua: navigator.userAgent,
  platform: navigator.platform,
  cores: navigator.hardwareConcurrency,
  memory: navigator.deviceMemory,
  languages: navigator.languages.join(','),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  screen: screen.width + 'x' + screen.height,
  dpr: devicePixelRatio,
  webgl: (() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null;
    } catch { return null; }
  })(),
  canvas: (() => {
    try {
      const c = document.createElement('canvas');
      c.width = 240; c.height = 60;
      const x = c.getContext('2d');
      x.textBaseline = 'top';
      x.font = '14px Arial';
      x.fillStyle = '#f60'; x.fillRect(0, 0, 120, 24);
      x.fillStyle = '#069'; x.fillText('Fingerprint Sandbox fingerprint', 2, 4);
      const url = c.toDataURL();
      let h = 0;
      for (let i = 0; i < url.length; i++) h = (Math.imul(h, 31) + url.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    } catch { return null; }
  })(),
})`;

async function run(label, { extension, lab }) {
  const browser = await Browser.launch(extension ? { extensionPath: EXTENSION } : {});
  try {
    // Two different sites in the same browser.
    const siteA = await browser.newPage();
    await siteA.goto(`http://127.0.0.1:${lab.port}/__probe`);
    const a = JSON.parse(await siteA.evaluate(IDENTITY_PROBE));

    const siteB = await browser.newPage();
    await siteB.goto(`http://localhost:${lab.port}/__probe`);
    const b = JSON.parse(await siteB.evaluate(IDENTITY_PROBE));

    const labPage = await browser.newPage();
    await labPage.goto(`http://127.0.0.1:${lab.port}/`, { waitForLoad: true });
    await labPage.waitForFunction('window.__labReport !== undefined', { timeout: 25000 });
    const report = JSON.parse(await labPage.evaluate('JSON.stringify(window.__labReport)'));

    return { label, a, b, report };
  } finally {
    await browser.close();
  }
}

function fmtIdentity(id) {
  return [
    `    UA        ${id.ua}`,
    `    platform  ${id.platform}   cores ${id.cores}   memory ${id.memory ?? '—'} GB`,
    `    locale    ${id.languages}  ${id.tz}`,
    `    screen    ${id.screen} @ ${id.dpr}x`,
    `    webgl     ${id.webgl ?? '—'}`,
    `    canvas    ${id.canvas}`,
  ].join('\n');
}

function summarise(run) {
  const counts = run.report.score;
  const blockers = run.report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const sameMachine = JSON.stringify(run.a) === JSON.stringify(run.b);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(run.label);
  console.log('═'.repeat(72));
  console.log(`\n  site A (127.0.0.1):\n${fmtIdentity(run.a)}`);
  console.log(`\n  site B (localhost):\n${fmtIdentity(run.b)}`);
  console.log(`\n  cross-site identity: ${sameMachine ? 'IDENTICAL — sites can correlate' : 'different — sites cannot correlate'}`);
  console.log(`\n  lab findings: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`);
  if (blockers.length > 0) {
    console.log('\n  blockers:');
    for (const f of blockers) console.log(`    [${f.severity}] ${f.title}\n             ${JSON.stringify(f.evidence).slice(0, 160)}`);
  } else {
    console.log('\n  no critical or high findings: the profile is internally coherent.');
  }
}

const lab = await startLabServer();
try {
  const baseline = await run('A. Same Chrome, NO extension (the real fingerprint)', { extension: false, lab });
  const extended = await run('B. Same Chrome, WITH extension (virtualised)', { extension: true, lab });

  summarise(baseline);
  summarise(extended);

  console.log(`\n${'═'.repeat(72)}`);
  console.log('Reading this');
  console.log('═'.repeat(72));
  console.log(`
  A failure in A is the lab being wrong (its checks must pass on a real
  browser). A failure in B is the defence being wrong. Both are bugs; keeping
  the control run makes it obvious which is which.

  The lab itself is hosted on 127.0.0.1 with a deliberately small headless
  window, so the baseline shows real screen/viewport mismatches — those are
  properties of this test setup, not of the browser under test.
`);
} finally {
  await lab.close();
}
