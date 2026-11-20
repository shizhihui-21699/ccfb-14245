/**
 * mediaDevices, permissions, WebRTC and storage quota.
 *
 * `enumerateDevices()` is a fingerprinting source in its own right: the count
 * of audio inputs and outputs, and the *set of device ids*, are stable per
 * browser profile and survive clearing cookies. The ids are the important part
 * — a page that calls `enumerateDevices()` twice and gets different ids learns
 * more than it learns from the ids themselves.
 *
 * We generate ids from the profile, so they are stable across tabs and
 * sessions and differ between sites. The device *labels* stay empty until the
 * page has microphone permission — which is what a real browser does, and
 * means a page cannot compare a label against our fabricated kind.
 */

import { replaceMethod, mask } from '../native.js';
import type { Profile } from '../../shared/profile/types.js';

export function patchMedia(profile: Profile): void {
  patchEnumerateDevices(profile);
  patchPermissions(profile);
}

function patchEnumerateDevices(profile: Profile): void {
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  if (!md) return;
  const proto = Object.getPrototypeOf(md) as object;
  const native = (proto as { enumerateDevices?: () => Promise<MediaDeviceInfo[]> }).enumerateDevices;
  if (typeof native !== 'function') return;

  const m = profile.media;
  const ids = m.ids;

  replaceMethod(proto, 'enumerateDevices', function enumerateDevices(this: MediaDevices) {
    return native.call(this).then((real) => {
      /**
       * If the page has permission, real labels are available and useful to it;
       * replacing the list wholesale would break a legitimate use (picking a
       * microphone). The fingerprinting signal is the *default* device id, so
       * we keep the real devices and only fall back to the synthetic list when
       * the browser returned generic entries (no permission) — which is the
       * state a fingerprinting script actually runs in.
       */
      const permitted = real.some((d) => d.label !== '');
      if (permitted) return real;

      const out: MediaDeviceInfo[] = [];
      let cursor = 0;
      const push = (kind: MediaDeviceKind, label: string) => {
        const id = ids[cursor++ % ids.length]!;
        out.push({
          deviceId: id,
          kind,
          label,
          groupId: `grp-${id.slice(0, 16)}`,
          toJSON() { return { deviceId: id, kind, label, groupId: `grp-${id.slice(0, 16)}` }; },
        } as unknown as MediaDeviceInfo);
      };
      for (let i = 0; i < m.audioInputs; i++) push('audioinput', '');
      for (let i = 0; i < m.videoInputs; i++) push('videoinput', '');
      for (let i = 0; i < m.audioOutputs; i++) push('audiooutput', '');
      return out;
    });
  });
}

/**
 * Permissions.
 *
 * The *state* of a permission is a fingerprint only when it is stable and
 * unusual. We answer from a fixed table for the queries a fingerprinting script
 * makes, and fall through for everything else. Crucially, `notifications` and
 * `geolocation` answer `prompt` (the default in a fresh profile), not `granted`,
 * so a site cannot use our answer to infer the user's browsing history.
 */
function patchPermissions(profile: Profile): void {
  const perms = navigator.permissions;
  if (!perms) return;
  const proto = Object.getPrototypeOf(perms) as object;
  const nativeQuery = (proto as { query?: (d: unknown) => Promise<PermissionStatus> }).query;
  if (typeof nativeQuery !== 'function') return;

  const FIXED: Record<string, PermissionState> = {
    notifications: 'prompt',
    geolocation: 'prompt',
    camera: 'prompt',
    microphone: 'prompt',
    'clipboard-read': 'prompt',
    'clipboard-write': 'granted',
    'local-fonts': 'prompt',
    'persistent-storage': 'prompt',
    midi: 'prompt',
  };

  replaceMethod(proto, 'query', function query(this: Permissions, desc: PermissionDescriptor) {
    const name = desc && typeof desc === 'object' ? desc.name : '';
    const answer = FIXED[name];
    if (answer === undefined) return nativeQuery.call(this, desc);
    const status = {
      state: answer,
      name,
      onchange: null,
      addEventListener() { /* no-op */ },
      removeEventListener() { /* no-op */ },
      dispatchEvent() { return true; },
    };
    return Promise.resolve(Object.freeze(status) as unknown as PermissionStatus);
  });

  void profile;
  void mask;
}
