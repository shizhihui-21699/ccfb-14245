/**
 * Navigator / screen / UA surface for the window realm.
 *
 * These values are the spine of coherence: every other module's realism
 * depends on the page believing this one. The UA string, the Client Hints
 * brands, `navigator.platform`, the core count and the GPU vendor all describe
 * the *same* machine, because they are all read from one profile.
 *
 * The `sec-ch-ua*` request headers are rewritten separately by the background
 * DNR rules from the same profile (background/network.ts), so
 * `navigator.userAgentData.brands` and the wire header cannot disagree.
 */

import { replaceGetter, defineGetter, replaceMethod, mask } from '../native.js';
import { patchNavigatorValues } from './nav-shared.js';
import type { Profile } from '../../shared/profile/types.js';

export function patchNavigatorAndScreen(profile: Profile): void {
  const nav = Navigator.prototype;

  patchNavigatorValues(
    {
      proto: nav,
      hasUaData: !!Object.getOwnPropertyDescriptor(nav, 'userAgentData')?.get,
      hasDeviceMemory: !!Object.getOwnPropertyDescriptor(nav, 'deviceMemory')?.get,
      hasConnection: !!Object.getOwnPropertyDescriptor(nav, 'connection')?.get,
    },
    profile,
    { architecture: profile.hardware.arch },
  );

  patchPlugins(nav);
  patchBattery(nav, profile);
  patchScreen(profile);
  patchMediaQueries(profile);
}

/**
 * Plugins and mimeTypes.
 *
 * Chrome ships five PDF-viewer plugins with a specific shape. Pages compare
 * `navigator.plugins.length` against `pdfViewerEnabled`; zero plugins next to
 * `pdfViewerEnabled: true` is a contradiction a detector can read off directly.
 */
function patchPlugins(nav: object): void {
  const names = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ];
  const pluginArray: Record<string | number, unknown> = {
    length: names.length,
    item(this: Record<number, unknown>, i: number) { return this[i] ?? null; },
    namedItem(this: Record<number, unknown>, name: string) {
      const idx = names.findIndex((n) => n.name === name);
      return idx >= 0 ? this[idx] ?? null : null;
    },
    refresh() { /* no-op, as in Chrome */ },
  };
  names.forEach((n, i) => {
    pluginArray[i] = Object.freeze({ ...n, length: 1 });
  });
  Object.freeze(pluginArray);

  if (Object.getOwnPropertyDescriptor(nav, 'plugins')?.get) {
    replaceGetter(nav, 'plugins', () => pluginArray);
  }
}

/**
 * Battery.
 *
 * Desktops commonly have no battery. Removing `getBattery` outright is itself
 * a tell, so a desktop profile rejects with the same error Chrome raises when
 * the platform reports no battery. A laptop profile reports a plausible,
 * session-stable state; it never claims `charging: true` at a constant 100%,
 * which is what a lazy fake does.
 */
function patchBattery(nav: object, profile: Profile): void {
  const desc = Object.getOwnPropertyDescriptor(nav, 'getBattery');
  if (!desc || typeof desc.value !== 'function') return;

  if (!profile.ua.hasBattery) {
    replaceMethod(nav, 'getBattery', function getBattery() {
      return Promise.reject(new DOMException('The battery is not available.', 'NotSupportedError'));
    });
    return;
  }

  const level = 0.55 + (profile.noise.canvas.seed % 30) / 100;
  const battery = Object.freeze({
    charging: false,
    chargingTime: Infinity,
    dischargingTime: Math.round(3.5 * 3600),
    level: Number(level.toFixed(2)),
    onchargingchange: null,
    onchargingtimechange: null,
    ondischargingtimechange: null,
    onlevelchange: null,
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
    dispatchEvent() { return true; },
  });
  replaceMethod(nav, 'getBattery', function getBattery() {
    return Promise.resolve(battery as unknown);
  });
}

function patchScreen(profile: Profile): void {
  const s = profile.screen;
  const screenProto = Screen.prototype;

  const set = (prop: string, value: number) => {
    if (Object.getOwnPropertyDescriptor(screenProto, prop)?.get) {
      replaceGetter(screenProto, prop, () => value);
    } else {
      defineGetter(screenProto, prop, () => value);
    }
  };

  set('width', s.width);
  set('height', s.height);
  set('availWidth', s.availWidth);
  set('availHeight', s.availHeight);
  set('colorDepth', s.colorDepth);
  set('pixelDepth', s.pixelDepth);

  /**
   * `devicePixelRatio` is an own accessor on the `window` object (not on
   * Window.prototype). Patching the prototype leaves the own property winning
   * the lookup, which is a silent no-op — exactly the bug the lab's
   * viewport-vs-screen check caught.
   */
  const dprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  if (dprDesc?.get) {
    replaceGetter(window, 'devicePixelRatio', () => s.dpr);
  } else if (Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio')?.get) {
    replaceGetter(Window.prototype, 'devicePixelRatio', () => s.dpr);
  } else {
    defineGetter(Window.prototype, 'devicePixelRatio', () => s.dpr);
  }

  // window.orientation is deprecated but still read. It is a data property, so
  // it must stay a data property with the same descriptor flags.
  if ('orientation' in window) {
    Object.defineProperty(window, 'orientation', {
      value: s.orientation === 'landscape-primary' ? (s.refreshHz === 120 ? 90 : 0) : 90,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  }

  const so = (window.screen as Screen & { orientation?: ScreenOrientation }).orientation;
  if (so) {
    const proto = Object.getPrototypeOf(so) as object;
    const type = s.orientation;
    const angle = type.startsWith('landscape') ? 0 : 90;
    for (const [prop, value] of [['type', type], ['angle', angle]] as const) {
      if (Object.getOwnPropertyDescriptor(proto, prop)?.get) {
        replaceGetter(proto, prop, () => value);
      }
    }
  }
}

/**
 * Media queries constrained by the profile.
 *
 * Only features the profile actually fixes are answered; anything else goes to
 * the native implementation. Overriding a query the profile says nothing about
 * would create a discrepancy between `matchMedia` and real layout behaviour,
 * which is a contradiction in the opposite direction.
 */
function patchMediaQueries(profile: Profile): void {
  const nativeMatchMedia = window.matchMedia;
  if (typeof nativeMatchMedia !== 'function') return;

  const s = profile.screen;
  const touch = profile.ua.maxTouchPoints > 0;

  const rules: Array<[RegExp, (m: RegExpExecArray) => boolean]> = [
    [/^\(\s*min-resolution:\s*([\d.]+)dppx\s*\)$/, (m) => s.dpr >= Number(m[1])],
    [/^\(\s*max-resolution:\s*([\d.]+)dppx\s*\)$/, (m) => s.dpr <= Number(m[1])],
    [/^\(\s*resolution:\s*([\d.]+)dppx\s*\)$/, (m) => s.dpr === Number(m[1])],
    [/^\(\s*pointer:\s*coarse\s*\)$/, () => touch],
    [/^\(\s*pointer:\s*fine\s*\)$/, () => !touch],
    [/^\(\s*pointer:\s*none\s*\)$/, () => false],
    [/^\(\s*hover:\s*none\s*\)$/, () => touch],
    [/^\(\s*hover:\s*hover\s*\)$/, () => !touch],
    [/^\(\s*any-pointer:\s*coarse\s*\)$/, () => touch],
    [/^\(\s*any-hover:\s*hover\s*\)$/, () => !touch],
  ];

  const patched = mask(function matchMedia(this: unknown, query: string) {
    const q = String(query).trim().toLowerCase().replace(/\s+/g, ' ');
    for (const [re, decide] of rules) {
      const m = re.exec(q);
      if (!m) continue;
      const mql = nativeMatchMedia.call(window, query);
      const answer = decide(m);
      if (answer !== mql.matches) {
        // Override `matches` on the instance only. MediaQueryList identity and
        // change listeners keep working, which is what pages rely on.
        const desc = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'matches');
        if (desc?.get) {
          Object.defineProperty(mql, 'matches', {
            get: mask(function getter() { return answer; }, 'get matches'),
            enumerable: desc.enumerable,
            configurable: true,
          });
        }
      }
      return mql;
    }
    return nativeMatchMedia.call(window, query);
  }, 'matchMedia');

  replaceMethod(window, 'matchMedia', patched);
}

