/**
 * MAIN-world entry point.
 *
 * Runs at document_start, before the page's first inline script. It receives
 * the profile from the isolated world through a one-shot DOM attribute (the
 * isolated world is the only realm that can see `chrome.runtime`, and it runs
 * first — see docs/spike-results.md), then installs every patch.
 *
 * Ordering inside this file matters:
 *   1. native toString disguise, so every later patch is already masked when
 *      the page first reads it;
 *   2. values a page reads synchronously during parsing (UA, screen, canvas,
 *      text metrics, fonts, locale);
 *   3. everything else.
 *
 * If any single patch throws, the rest still install: a half-patched realm is
 * less coherent, but an exception that aborts the whole script leaves the page
 * with the real fingerprint, which is the one outcome we must never allow.
 */

import { installNativeToString } from './native.js';
import { patchNavigatorAndScreen } from './patches/navigator.js';
import { patchCanvas } from './patches/canvas.js';
import { patchWebGL } from './patches/webgl.js';
import { patchAudio } from './patches/audio.js';
import { patchFontsAndLocale } from './patches/fonts-locale.js';
import { patchMedia } from './patches/media.js';
import { patchWorkers } from './patches/workers.js';
import type { WorkerPatchOptions } from './patches/workers.js';
import type { Profile } from '../shared/profile/types.js';

/** Runs each installer, isolating failures so one bug cannot unmask the rest. */
function safely(label: string, fn: () => void, failures: string[]): void {
  try {
    fn();
  } catch (e) {
    // Keep the message: a patch that fails silently is a patch that silently
    // stops protecting the page, and the reason is the only way to fix it.
    failures.push(`${label}: ${(e as Error)?.message ?? String(e)}`);
  }
}

export function applyProfile(profile: Profile, workerPatch: WorkerPatchOptions): string[] {
  const failures: string[] = [];
  // toString first: it is the mask every other patch relies on.
  safely('native-toString', () => installNativeToString(), failures);
  safely('navigator-screen', () => patchNavigatorAndScreen(profile), failures);
  safely('canvas', () => patchCanvas(profile), failures);
  safely('webgl', () => patchWebGL(profile), failures);
  safely('audio', () => patchAudio(profile), failures);
  safely('fonts-locale', () => patchFontsAndLocale(profile), failures);
  safely('media', () => patchMedia(profile), failures);
  safely('workers', () => patchWorkers(profile, workerPatch), failures);
  return failures;
}

/**
 * Bootstrap. The isolated world writes the profile JSON to an attribute on
 * `<html>`; we read and remove it. A MutationObserver registered by the page
 * cannot catch this, because the page's first script has not run yet.
 */
export function boot(): void {
  const ATTR = 'data-fp-bootstrap';
  const el = document.documentElement;
  const raw = el.getAttribute(ATTR);
  if (!raw) {
    // The isolated world failed to deliver a profile. Do nothing rather than
    // patch with a guess: a wrong profile is worse than the real fingerprint.
    installNativeToString();
    return;
  }
  el.removeAttribute(ATTR);

  let payload: { profile: Profile; worker: WorkerPatchOptions };
  try {
    payload = JSON.parse(raw) as { profile: Profile; worker: WorkerPatchOptions };
  } catch {
    installNativeToString();
    return;
  }

  const failures = applyProfile(payload.profile, payload.worker);
  /**
   * Diagnostics never go on the page's `window`: a property holding the words
   * "failures"/"fonts-locale" is itself a tampering tell. They go into the DOM
   * under the bootstrap attribute name, where only the isolated world (which
   * shares the DOM but not the JS realm) can read them, and are removed on the
   * next frame load.
   */
  if (failures.length > 0) {
    el.setAttribute('data-fp-diag', JSON.stringify(failures));
  }
}

boot();
