/**
 * Worker-side installer, loaded as a web-accessible classic script by the
 * wrapper blob described in main/patches/workers.ts.
 *
 * It is the first extension code to run in the worker realm. Sequence:
 *   1. read the profile the wrapper embedded on the realm;
 *   2. patch the realm;
 *   3. replay the messages the wrapper buffered before the real script existed.
 *
 * The profile arrives as a literal in a blob the page never sees (created in a
 * closed-over function, URL revoked immediately) rather than through
 * `postMessage` (observable by the page) or a URL (reaches history). It also
 * cannot be re-derived here: `chrome.runtime` is undefined in a page-origin
 * worker, so there is no way to reach the extension's files or storage.
 */

import { installNativeToString } from '../main/native.js';
import { patchNavigatorValues } from '../main/patches/nav-shared.js';
import { patchCanvas } from '../main/patches/canvas.js';
import { patchWebGL } from '../main/patches/webgl.js';
import { patchAudio } from '../main/patches/audio.js';
import { patchIntlAndTimeZone } from '../main/patches/fonts-locale.js';
import type { Profile } from '../shared/profile/types.js';

interface WorkerRealm {
  /** JSON of the profile, embedded by the wrapper blob (see patches/workers.ts). */
  __fpProfileJson?: string;
  __fpBuffered?: unknown[];
  navigator?: { userAgent: string };
  dispatchEvent: (e: Event) => boolean;
}

const realm = self as unknown as WorkerRealm;

function readProfile(): Profile | null {
  try {
    if (!realm.__fpProfileJson) return null;
    return JSON.parse(realm.__fpProfileJson) as Profile;
  } catch {
    return null;
  }
}

function install(profile: Profile): void {
  try {
    installNativeToString();
  } catch { /* still worth attempting the rest */ }

  const nav = realm.navigator;
  if (nav) {
    const proto = Object.getPrototypeOf(nav) as object;
    try {
      patchNavigatorValues(
        {
          proto,
          hasUaData: !!Object.getOwnPropertyDescriptor(proto, 'userAgentData')?.get,
          hasDeviceMemory: !!Object.getOwnPropertyDescriptor(proto, 'deviceMemory')?.get,
          hasConnection: !!Object.getOwnPropertyDescriptor(proto, 'connection')?.get,
        },
        profile,
        { architecture: profile.hardware.arch },
      );
    } catch { /* continue */ }
  }

  for (const step of [
    () => patchCanvas(profile),
    () => patchWebGL(profile),
    () => patchAudio(profile),
    () => patchIntlAndTimeZone(profile),
  ]) {
    try { step(); } catch { /* one failed domain must not unmask the others */ }
  }
}

function main(): void {
  const profile = readProfile();
  if (profile) {
    try {
      install(profile);
    } catch { /* run the real script unpatched rather than break it */ }
  }

  /**
   * Replay anything the page posted before the real script's handlers existed.
   * Ordering matters: the buffer listener is installed by the wrapper *before*
   * the shim and the real script, and this dispatch happens after our patch, so
   * handlers only ever observe a patched realm.
   */
  const buffered = realm.__fpBuffered;
  if (buffered && buffered.length > 0) {
    for (const data of buffered.splice(0)) {
      realm.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
}

main();
