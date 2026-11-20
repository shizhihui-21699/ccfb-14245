/**
 * Lab UI.
 *
 * The page is a test instrument. It runs the full collection + detection pass,
 * renders findings ranked by severity, and keeps the previous snapshot in
 * memory so a second run can surface instability (values that changed between
 * reads on the same site — the worst failure mode for a virtualised profile).
 */

import { collectAll } from './collectors.js';
import { runDetectors } from './detectors.js';
import type { Finding, Report, Snapshot } from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

let previousSnapshot: Snapshot | null = null;
let previousReport: Report | null = null;
let busy = false;

function severityClass(s: Finding['severity'] | 'informational'): string {
  return s;
}

function renderReport(report: Report): void {
  const v = $('verdict');
  v.hidden = false;
  $('score-critical').textContent = `${report.score.critical} critical`;
  $('score-high').textContent = `${report.score.high} high`;
  $('score-medium').textContent = `${report.score.medium} medium`;
  $('score-low').textContent = `${report.score.low} low`;

  const blockers = report.score.critical + report.score.high;
  $('verdict-text').textContent = blockers === 0
    ? 'No critical or high-severity inconsistencies found. The profile is internally coherent on every check this lab runs.'
    : `${blockers} finding${blockers === 1 ? '' : 's'} a real detector would use to identify this browser as tampered. Read them worst-first.`;

  const list = $('findings');
  list.innerHTML = '';
  for (const finding of report.findings) {
    const el = document.createElement('article');
    el.className = `finding ${severityClass(finding.severity)}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${finding.severity} · ${finding.category}`;
    const h = document.createElement('h3');
    h.textContent = finding.title;
    const p = document.createElement('p');
    p.textContent = finding.explains;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(finding.evidence, null, 2);
    el.append(meta, h, p, pre);
    list.append(el);
  }
  $('findings-section').hidden = report.findings.length === 0;
}

type Row = [string, string, 'good' | 'bad' | null] | [string, string];

function card(title: string, rows: Row[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  const h = document.createElement('h3');
  h.textContent = title;
  const dl = document.createElement('dl');
  for (const [k, val, tone] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    if (tone) dd.className = tone;
    dl.append(dt, dd);
  }
  el.append(h, dl);
  return el;
}

function renderPanel(s: Snapshot): void {
  const panel = $('panel');
  panel.innerHTML = '';

  const ua = s.ua.value;
  if (ua) {
    panel.append(card('User agent', [
      ['UA', ua.ua],
      ['platform', ua.platform],
      ['brands', ua.brands ? ua.brands.map((b) => `${b.brand}/${b.version}`).join(', ') : '—'],
      ['full version', ua.uaFullVersion ?? '—'],
      ['arch/bitness', `${ua.ah ?? '—'} / ${ua.bitness ?? '—'}`],
      ['webdriver', String(ua.webdriver)],
      ['plugins', `${ua.plugins} plugins, ${ua.mimeTypes} mime types`],
      ['languages', ua.languages.join(', ')],
    ]));
  }

  const sc = s.screen.value;
  if (sc) {
    panel.append(card('Screen', [
      ['resolution', `${sc.width}×${sc.height}`],
      ['available', `${sc.availWidth}×${sc.availHeight}`],
      ['dpr', String(sc.dpr)],
      ['inner', `${sc.innerWidth}×${sc.innerHeight}`],
      ['outer', `${sc.outerWidth}×${sc.outerHeight}`],
      ['colour depth', String(sc.colorDepth)],
      ['orientation', `${sc.orientationType ?? '—'} (${sc.orientationAngle ?? '—'}°)`],
      ['refresh', sc.refreshHz !== null ? `${sc.refreshHz} Hz` : '—'],
    ]));
  }

  const hw = s.hardware.value;
  if (hw) {
    panel.append(card('Hardware', [
      ['cores', String(hw.hardwareConcurrency)],
      ['memory', hw.deviceMemory !== null ? `${hw.deviceMemory} GB` : '—'],
      ['touch points', String(hw.maxTouchPoints)],
      ['battery', hw.battery ? `${Math.round(hw.battery.level * 100)}% ${hw.battery.charging ? 'charging' : 'discharging'}` : (hw.batteryError ?? 'unavailable')],
      ['connection', hw.connection ? `${hw.connection.effectiveType} · ${hw.connection.rtt} ms · ${hw.connection.downlink} Mb/s` : '—'],
    ]));
  }

  const gl = s.webgl.value;
  if (gl) {
    panel.append(card('WebGL', [
      ['vendor', gl.vendor ?? '—'],
      ['renderer', gl.renderer ?? '—'],
      ['unmasked vendor', gl.unmaskedVendor ?? '—'],
      ['unmasked renderer', gl.unmaskedRenderer ?? '—'],
      ['max texture', String(gl.maxTextureSize)],
      ['max viewport', gl.maxViewport ? gl.maxViewport.join('×') : '—'],
      ['extensions', String(gl.extensions?.length ?? 0)],
      ['pixel hash', gl.pixelHash ?? '—'],
      ['canvas hash', gl.viaCanvasHash ?? '—'],
    ]));
  }

  const c = s.canvas.value;
  if (c) {
    panel.append(card('Canvas', [
      ['dataURL hash', c.textHash],
      ['imageData hash', c.imageDataHash],
      ['round-trip hash', c.roundTripHash || '—'],
      ['round-trip max delta', String(c.roundTripMaxDelta), c.roundTripMaxDelta <= 3 ? 'good' : 'bad'],
      ['solid fill colours', String(c.solidFillColours), c.solidFillColours === 1 ? 'good' : 'bad'],
      ['checkerboard colours', String(c.checkerColours), c.checkerColours <= 2 ? 'good' : 'bad'],
      ['stable across renders', String(c.stable), c.stable ? 'good' : 'bad'],
      ['max render delta', String(c.maxSelfDelta)],
    ]));
  }

  const au = s.audio?.value;
  if (au) {
    panel.append(card('Audio', [
      ['hash', au.hash],
      ['sum', au.sum.toFixed(10)],
      ['samples', String(au.sampleCount)],
      ['stable', String(au.stable), au.stable ? 'good' : 'bad'],
    ]));
  }

  const ft = s.fonts.value;
  if (ft) {
    panel.append(card('Fonts', [
      ['detected', String(ft.detected.length)],
      ['check agrees', String(ft.checkAgree.length)],
      ['disagreements', ft.disagreements.length ? ft.disagreements.join(', ') : 'none',
        ft.disagreements.length ? 'bad' : 'good'],
      ['sample', ft.detected.slice(0, 8).join(', ') || '—'],
    ]));
  }

  const lc = s.locale.value;
  if (lc) {
    panel.append(card('Locale', [
      ['timezone', lc.timeZone],
      ['offset', `${-lc.offsetMinutes} min`],
      ['locale', lc.resolvedLocale],
      ['number', lc.numberFormat],
      ['date', lc.dateFormat],
    ]));
  }

  const md = s.media.value;
  if (md) {
    panel.append(card('Media devices', [
      ['inputs / outputs', `${md.audioInputs} / ${md.audioOutputs}`],
      ['video inputs', String(md.videoInputs)],
      ['ids stable', String(md.stable), md.stable ? 'good' : 'bad'],
      ['labels visible', String(md.labelsVisible)],
    ]));
  }

  const nv = s.native.value;
  if (nv) {
    panel.append(card('Native-code checks', [
      ['non-native functions', String(nv.nonNative.length), nv.nonNative.length ? 'bad' : 'good'],
      ['descriptor anomalies', String(nv.descriptorAnomalies.length), nv.descriptorAnomalies.length ? 'bad' : 'good'],
      ['stack leaks', String(nv.stackLeaks.length), nv.stackLeaks.length ? 'bad' : 'good'],
      ['prototype key diffs', String(nv.extraKeys.length)],
    ]));
  }

  const wk = s.worker?.value;
  if (wk) {
    panel.append(card('Worker realm', [
      ['UA matches window', String(wk.ua === ua?.ua), wk.ua === ua?.ua ? 'good' : 'bad'],
      ['cores', String(wk.hardwareConcurrency)],
      ['timezone', wk.timeZone ?? '—'],
      ['canvas hash', wk.canvasHash ?? '—'],
      ['error', wk.error ?? 'none'],
    ]));
  }
}

/**
 * Context consistency: the same facts from Worker, iframe and top window.
 *
 * Rendered as a matrix rather than three cards, because the question is not
 * "what did each see" but "do they agree" — a tracker only cares about the
 * latter.
 */
function renderContexts(s: Snapshot): void {
  const host = $('contexts');
  host.innerHTML = '';

  const windowUa = s.ua.value?.ua ?? null;
  const windowCores = s.hardware.value?.hardwareConcurrency ?? null;
  const windowCanvas = s.canvas.value?.imageDataHash ?? null;

  const rows: Array<[string, string | null, string | null, string | null]> = [
    ['user agent', windowUa, s.worker?.value?.ua ?? null, s.iframe?.value?.ua ?? null],
    ['core count', windowCores === null ? null : String(windowCores),
      s.worker?.value?.hardwareConcurrency === null || s.worker?.value?.hardwareConcurrency === undefined
        ? null : String(s.worker.value.hardwareConcurrency),
      s.iframe?.value?.cores === null || s.iframe?.value?.cores === undefined ? null : String(s.iframe.value.cores)],
    ['canvas hash', windowCanvas, s.worker?.value?.canvasHash ?? null, s.iframe?.value?.canvasHash ?? null],
  ];

  const el = document.createElement('div');
  el.className = 'card';
  const h = document.createElement('h3');
  h.textContent = 'Cross-context agreement';
  const dl = document.createElement('dl');
  dl.style.gridTemplateColumns = 'max-content 1fr 1fr 1fr';
  for (const label of ['', 'top window', 'worker', 'iframe']) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    dt.style.fontWeight = label ? '600' : '400';
    dl.append(dt);
  }
  // Realign the header row: the loop above produced four <dt> in a two-column
  // grid; rebuild explicitly instead.
  dl.replaceChildren();
  const header = ['field', 'top window', 'worker', 'iframe'];
  for (const name of header) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    dl.append(dt);
  }
  const cell = (text: string | null, matches: boolean | null): HTMLElement => {
    const dd = document.createElement('dd');
    dd.textContent = text === null ? '—' : text.length > 46 ? text.slice(0, 46) + '…' : text;
    if (matches === true) dd.className = 'good';
    if (matches === false) dd.className = 'bad';
    return dd;
  };
  for (const [field, win, worker, iframe] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = field;
    dl.append(dt, cell(win, null),
      cell(worker, worker === null ? null : worker === win),
      cell(iframe, iframe === null ? null : iframe === win));
  }
  el.append(h, dl);

  const note = document.createElement('div');
  note.className = 'card';
  const nh = document.createElement('h3');
  nh.textContent = 'Why this matters';
  const np = document.createElement('p');
  np.style.margin = '0';
  np.textContent =
    'A tracker compares contexts because defences often miss one. Green means the realm ' +
    'agrees with the top window; red means the page can tell which realm was patched.';
  note.append(nh, np);

  host.append(el, note);
}

function renderDiff(cur: Report, prev: Report | null): void {
  const section = $('diff-section');
  const out = $('diff-out');
  if (!prev) {
    section.hidden = true;
    $<HTMLButtonElement>('diff').disabled = true;
    return;
  }
  const prevKeys = new Set(prev.findings.map((f) => f.key));
  const curKeys = new Set(cur.findings.map((f) => f.key));
  const added = cur.findings.filter((f) => !prevKeys.has(f.key));
  const removed = prev.findings.filter((f) => !curKeys.has(f.key));

  out.innerHTML = '';
  if (added.length === 0 && removed.length === 0) {
    out.textContent = 'Identical findings. The profile produced the same fingerprint as the previous run.';
  } else {
    const ul = document.createElement('ul');
    for (const a of added) {
      const li = document.createElement('li');
      li.textContent = `New: ${a.title} (${a.severity})`;
      ul.append(li);
    }
    for (const r of removed) {
      const li = document.createElement('li');
      li.textContent = `Resolved: ${r.title}`;
      ul.append(li);
    }
    out.append(ul);
  }
  section.hidden = false;
  $<HTMLButtonElement>('diff').disabled = false;
}

async function runScan(): Promise<void> {
  if (busy) return;
  busy = true;
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    const snapshot = await collectAll();
    const report = runDetectors(snapshot, previousSnapshot);
    // Expose for the automated test harness. Read-only, memory-only, and the
    // property is only present on this lab origin.
    (window as unknown as { __labReport?: Report }).__labReport = report;
    renderReport(report);
    renderPanel(snapshot);
    renderContexts(snapshot);
    renderDiff(report, previousReport);
    previousSnapshot = snapshot;
    previousReport = report;
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = 'Run full scan';
  }
}

function init(): void {
  $('run').onclick = () => { void runScan(); };

  $('baseline').onclick = async () => {
    /**
     * A true baseline requires the extension to be absent, which cannot happen
     * in a tab that already has it loaded. Rather than pretend, this button
     * collects a second snapshot and shows what a *repeat* looks like — the
     * comparison that actually matters for stability. The real baseline is
     * produced by tests/e2e/run-lab.mjs in a separate browser profile.
     */
    const before = previousReport;
    await runScan();
    if (before) renderDiff(previousReport!, before);
  };

  void runScan();
}

init();
