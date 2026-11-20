# Fingerprint Sandbox

Per-site, internally consistent browser fingerprint virtualisation for OSINT and
competitive research, plus the adversarial test site used to verify it.

The problem it solves: research staff need to look at competitor sites and
suspicious sites without those sites correlating the visits back to one person
by browser fingerprint. Clearing cookies and changing networks does not help,
because the fingerprint survives both.

Two halves:

- **`dist/extension/`** — a Manifest V3 extension that gives every site its own
  coherent machine identity, stable for the life of that identity, and makes the
  patched APIs indistinguishable from the originals.
- **`dist/lab/`** — a test site that tries to *catch* the extension. It does not
  check "was something patched"; it checks "do two independent sources of truth
  contradict each other", which is what a real detector does.

## Requirements

- Node 20+
- Chrome 120+ (developed and tested against Chrome 157 on macOS)

```sh
npm install
npm run build        # dist/extension + dist/lab
npm test             # 47 unit + end-to-end tests; needs Chrome installed
```

## Using it

```sh
npm run build
npm run serve        # http://127.0.0.1:5391 — the test lab
```

Load the extension: `chrome://extensions` → enable Developer mode →
**Load unpacked** → select `dist/extension`.

Then open <http://127.0.0.1:5391/>. The lab runs a full scan on load and shows
either "no critical or high-severity inconsistencies" or a ranked list of the
contradictions it found, each with the two conflicting observations.

Click **Run full scan** twice to check stability: the second run compares against
the first and reports anything that changed on the same site, which is the
failure mode that matters most.

### The comparison that answers "how much should change?"

```sh
npm run compare
```

Runs the same Chrome twice against the same lab — once without the extension,
once with it — and prints both identities side by side. The baseline run is the
control: a check that fails on stock Chrome is a flaw in the lab, not in the
defence.

## How it works

### One profile, derived, not stored

A profile is a pure function of `(install seed, site key)`:

```
seed            = PRF(buildSeed, installSalt)     // per install, random
siteKey         = eTLD+1 of the page              // example.com, not a.example.com
profile         = derive(seed, siteKey)           // device class, GPU, screen,
                                                  // UA, locale, fonts, noise params
```

No cache and no stored profile, so a tab opened at any moment — before or after
a service worker restart, in any frame, in any realm — derives the same profile.
The seed is random per install, so two people using this build never share an
identity on the same site.

The seed itself has to be readable *synchronously* at `document_start`, before
the page's first script, and must not be readable by page script. Neither
`chrome.storage` (async-only) nor a web-accessible file (page-readable) works.
The solution is a dynamic `declarativeNetRequest` redirect on a per-build
tokenised URL that returns the salt as a `data:` URL — synchronously fetchable
from the isolated world, unguessable from the page, and persistent across
browser restarts. `docs/spike-results.md` has the measurements that led here,
including the approaches that failed.

### Coherence is enforced, not assumed

Every derived profile is checked against a list of invariants before use, and a
failing candidate is redrawn rather than patched:

- the screen must be able to contain the real viewport (`innerWidth` can never
  exceed `screen.width`);
- `availWidth`/`availHeight` must reserve OS chrome but never exceed the screen;
- DPR is an integer ≥ 2 on macOS, from the Windows scale set elsewhere;
- an Apple GPU string implies arm64, an ANGLE D3D11 renderer implies x86;
- the UA OS token agrees with `navigator.platform`, with `sec-ch-ua-platform`,
  and with the GPU family;
- the font set matches the OS and excludes the other OSes' required families;
- language and timezone come from the same region;
- canvas and WebGL perturbation share one seed.

The same invariant list is exported to the lab's `crossSource` detector, so the
lab checks the exact property the generator guarantees — not a hand-written
approximation of it.

### Modification that survives its own detection

Every patched function is disguised as native code (`toString`, `name`,
`length`, descriptor flags). Pixel perturbation is designed against the specific
ways a farbling defence gets caught:

- **flat fills stay bit-exact** — only pixels that differ from a neighbour are
  touched, so a solid rectangle reads back as one colour, as on real hardware;
- **±1 LSB maximum**, with the direction chosen so the mean channel value does
  not shift;
- **idempotent** — eligibility is decided against the untouched buffer, so a
  second read cannot drift;
- **sub-rectangle reads agree with full-canvas reads** — a padded read makes the
  neighbourhood visible, so a detector comparing a strip against the same strip
  in a full read finds nothing;
- **the GL and 2D paths agree** — `readPixels` and "copy the GL canvas into a 2D
  canvas and read it" produce identical bytes, row order normalised.

### What is and is not virtualised

| Source | Handled |
|---|---|
| UA string, Client Hints (page and wire) | yes, one profile |
| `hardwareConcurrency`, `deviceMemory` | yes, real-hardware corpus |
| screen, DPR, orientation, `matchMedia` | yes, viewport-constrained |
| Canvas 2D, OffscreenCanvas | yes, edge-masked projection |
| WebGL vendor/renderer/limits/extensions | yes, OS-matched |
| WebGL `readPixels` | yes, same projection as canvas |
| AudioContext, OfflineAudioContext, Analyser | yes, sub-audible offset |
| Font enumeration | yes, measurement-based |
| `Intl`, timezone, languages | yes, region-consistent |
| `mediaDevices` | yes, stable synthetic ids |
| Worker / OffscreenCanvas realms | yes, same profile |
| Server-side UA/Client Hints headers | yes, via DNR rules |
| TLS / JA3 / HTTP/2 / DNS | **no** — not reachable from an extension |
| Real GPU rendering differences | **no** — strings and limits only |

The last two are real gaps. `docs/design.md` says so plainly rather than
implying full coverage.

## Repository layout

```
src/extension/
  shared/            derivation core: siphash, rng, eTLD+1, profile builder,
                     invariants, device corpus, seed derivation
  isolated/          synchronous bootstrap: seed -> profile -> DOM handoff
  main/              MAIN-world patches, one module per source, native disguise
  worker/            worker-realm installer (same profile, no extension APIs)
  background/        install lifecycle, seed delivery, header rewriting
  options/           diagnostics UI
src/lab/
  collectors.ts      what a tracker measures, including redundant paths
  detectors.ts       contradictions, not "was it patched"
  probe-drawing.ts   the one canvas drawing, shared by all three realms
scripts/             build, dev server, baseline-vs-extended comparison
tests/               unit (derivation, invariants, perturbation) + e2e
docs/                design, spike measurements, limitations
```

## Testing

`npm test` runs two suites against a real Chrome:

- **unit** — derivation determinism, every invariant, the perturbation
  properties (flatness, idempotence, no brightness bias, sub-rectangle
  agreement), and regression tests for each defect the lab found.
- **end-to-end** — loads the built extension into Chrome, confirms the profile
  is in place before the page's first inline script, runs the hostile lab and
  requires zero critical/high findings, checks cross-site separation and
  same-site stability across reloads, tabs and a browser restart, checks
  realm agreement and wire-header agreement, and confirms ordinary page
  features (canvas export, WebGL, audio, text layout, workers, storage) still
  work.

Chrome 129+ removed `--load-extension`; the harness loads the unpacked extension
through CDP `Extensions.loadUnpacked`, which requires
`--enable-unsafe-extension-debugging`. Set `CHROME_PATH` if Chrome is not in a
standard location.

## Known limitations

- Server-side TLS/JA3 fingerprinting is untouched and out of reach.
- The first request to a host the browser has never visited carries the real
  `User-Agent`; header rules are installed on the first response and apply from
  the second navigation onward.
- A profile claims a screen size; if you then resize the window larger than
  that screen, `innerWidth` can exceed it. Reload to redraw the profile sized
  for the new window.
- Worker support covers dedicated Workers. SharedWorker and worklets are not
  patched.
- Two installs of the same build have independent seeds. The build seed is
  shared, so if it leaked, an attacker still cannot derive per-install salts.
