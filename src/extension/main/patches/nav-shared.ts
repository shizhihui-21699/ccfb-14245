/**
 * Navigator surface shared by the window realm and worker realms.
 *
 * `Navigator` and `WorkerNavigator` are different prototypes but expose the
 * same fingerprintable accessors. Detectors run collection in Workers
 * specifically to escape window-only defences, so every navigator value here
 * is patched in both realms from the same profile.
 */

import { replaceGetter } from '../native.js';
import type { Profile } from '../../shared/profile/types.js';

export interface NavRealm {
  /** Navigator.prototype in a window; WorkerNavigator.prototype in a worker. */
  proto: object;
  /** True when `navigator.userAgentData` exists on this realm's prototype. */
  hasUaData: boolean;
  /** True when `navigator.deviceMemory` exists. */
  hasDeviceMemory: boolean;
  /** True when `navigator.connection` exists. */
  hasConnection: boolean;
}

export function patchNavigatorValues(
  realm: NavRealm,
  profile: Profile,
  opts: { architecture: 'x86' | 'arm' },
): void {
  const ua = profile.ua;
  const proto = realm.proto;

  setString(proto, 'userAgent', ua.ua);
  setString(proto, 'appVersion', ua.ua.replace(/^Mozilla\//, ''));
  setString(proto, 'platform', ua.platform);
  setString(proto, 'vendor', ua.vendor);
  setString(proto, 'productSub', '20030107');
  setNumber(proto, 'hardwareConcurrency', profile.hardware.cores);
  setNumber(proto, 'maxTouchPoints', ua.maxTouchPoints);
  if (realm.hasDeviceMemory) setNumber(proto, 'deviceMemory', profile.hardware.memoryGB);

  setBoolean(proto, 'pdfViewerEnabled', ua.pdfViewerEnabled);
  setBoolean(proto, 'webdriver', false);

  // `languages` is a frozen array on the real navigator; hand out a fresh
  // frozen copy so a page cannot mutate the one instance into an inconsistency.
  if (Object.getOwnPropertyDescriptor(proto, 'languages')?.get) {
    replaceGetter(proto, 'languages', () => Object.freeze(ua.languages.slice()));
  }
  if (Object.getOwnPropertyDescriptor(proto, 'language')?.get) {
    replaceGetter(proto, 'language', () => ua.languages[0] ?? 'en-US');
  }

  if (realm.hasUaData) patchUaData(proto, profile, opts);
  if (realm.hasConnection) patchConnection(proto, profile);
}

function setString(proto: object, prop: string, value: string): void {
  if (Object.getOwnPropertyDescriptor(proto, prop)?.get) {
    replaceGetter(proto, prop, () => value);
  }
}

function setNumber(proto: object, prop: string, value: number): void {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (desc?.get) replaceGetter(proto, prop, () => value);
}

function setBoolean(proto: object, prop: string, value: boolean): void {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (desc?.get) replaceGetter(proto, prop, () => value);
}

function patchUaData(proto: object, profile: Profile, opts: { architecture: 'x86' | 'arm' }): void {
  const desc = Object.getOwnPropertyDescriptor(proto, 'userAgentData');
  if (!desc?.get) return;
  replaceGetter(proto, 'userAgentData', () => buildUaData(profile, opts));
}

/** Construct the `.userAgentData` object for a profile. Exported for tests. */
export function buildUaData(
  profile: Profile,
  opts: { architecture: 'x86' | 'arm' },
  mask: <T extends Function>(fn: T, name: string) => T = (fn) => fn,
): Record<string | symbol, unknown> {
  const ua = profile.ua;
  const brands = () => [
    { brand: ua.notABrand.brand, version: ua.notABrand.version },
    { brand: 'Chromium', version: String(ua.chromeMajor) },
    { brand: 'Google Chrome', version: String(ua.chromeMajor) },
  ];
  const fullVersionList = () => [
    { brand: ua.notABrand.brand, version: `${ua.notABrand.version}.0.0.0` },
    { brand: 'Chromium', version: ua.chromeFullVersion },
    { brand: 'Google Chrome', version: ua.chromeFullVersion },
  ];

  const getHighEntropyValues = mask(function getHighEntropyValues(hints: string[]) {
    const want = new Set(Array.isArray(hints) ? hints : []);
    const out: Record<string, unknown> = {};
    if (want.has('platform')) out.platform = ua.uaDataPlatform;
    if (want.has('platformVersion')) out.platformVersion = ua.platformVersion;
    if (want.has('architecture')) out.architecture = opts.architecture;
    if (want.has('bitness')) out.bitness = profile.hardware.bitness;
    if (want.has('model')) out.model = '';
    if (want.has('uaFullVersion')) out.uaFullVersion = ua.chromeFullVersion;
    if (want.has('fullVersionList')) out.fullVersionList = fullVersionList();
    if (want.has('wow64')) out.wow64 = false;
    if (want.has('formFactors')) out.formFactors = ['Desktop'];
    return Promise.resolve(out);
  }, 'getHighEntropyValues');

  return {
    brands: brands(),
    mobile: false,
    platform: ua.uaDataPlatform,
    getHighEntropyValues,
    toJSON: mask(function toJSON() {
      return { brands: brands(), mobile: false, platform: ua.uaDataPlatform };
    }, 'toJSON'),
  };
}

function patchConnection(proto: object, profile: Profile): void {
  const desc = Object.getOwnPropertyDescriptor(proto, 'connection');
  if (!desc?.get) return;
  const ua = profile.ua;
  const conn = Object.freeze({
    effectiveType: ua.connectionType,
    rtt: ua.connectionRtt,
    downlink: ua.connectionDownlink,
    saveData: false,
    onchange: null,
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
    dispatchEvent() { return true; },
  });
  replaceGetter(proto, 'connection', () => conn);
}
