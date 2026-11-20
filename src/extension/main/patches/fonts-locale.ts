/**
 * Fonts, timezone and locale.
 *
 * Font enumeration is the oldest fingerprinting trick and still one of the most
 * reliable. The three answers a page can get must agree:
 *
 *   1. `document.fonts.check('12px "Foo"')`
 *   2. measureText('mmmmmmmmmmlli', '12px "Foo"').width versus a fallback
 *   3. layout width of a span set in "Foo" versus the same span in a fallback
 *
 * All three are answered from the profile's font table. The failure mode to
 * avoid is answering (1) `true` for a font while (2) and (3) show the fallback
 * width — a three-way contradiction a naive implementation ships every time.
 * So for a family marked absent, measurement must return *exactly* the
 * fallback's result, and for a present family it returns fallback width times
 * the family's per-profile scale.
 *
 * Timezone and locale are patched through Intl rather than by lying about
 * `Date`: `new Date().getTimezoneOffset()` and
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` are cross-checked against
 * each other, and a fake Date offset with a real Intl timezone is the single
 * most common tell in timezone spoofing.
 */

import { replaceMethod, replaceConstructor, mask } from '../native.js';
import type { Profile } from '../../shared/profile/types.js';

/**
 * Window realm installer. Font APIs need `document`, so this half only runs
 * where a document exists.
 */
export function patchFonts(profile: Profile): void {
  patchMeasureRect(profile);
}

/**
 * Locale installer. Works in every realm — `Intl` and `Date` exist in workers
 * too — and must be installed there independently: a page that collects the
 * timezone from a Worker and the fonts from the window gets two different
 * answers if either half is realm-specific.
 */
export function patchIntlAndTimeZone(profile: Profile): void {
  patchIntl(profile);
}

/** Convenience for the window realm, where both halves apply. */
export function patchFontsAndLocale(profile: Profile): void {
  patchFonts(profile);
  patchIntlAndTimeZone(profile);
}

/**
 * `document.fonts.check()` is deliberately **not patched**.
 *
 * This is the counter-intuitive decision the lab forced. On stock desktop
 * Chrome with no webfonts loaded, `document.fonts.size === 0` and `check()`
 * returns `true` for *any* family name — including one that does not exist —
 * because it answers "can this text render without downloading a font", not
 * "is this family installed". Measured against a clean browser:
 *
 *     document.fonts.check('12px "Totally Fake Font 9000"')  // true
 *
 * So there is no presence signal to preserve or spoof here, and a profile that
 * answers from a presence table introduces the one contradiction that *is*
 * detectable: check() false for a family whose own metrics render. Leaving the
 * native implementation alone makes the answer correct by construction.
 */

/**
 * Layout-based font detection.
 *
 * A page usually measures by appending a `<span>` with `visibility: hidden`
 * and reading `offsetWidth`, or by `canvas.measureText`. `canvas.measureText`
 * is covered in canvas.ts. For the DOM path, `Range.getBoundingClientRect` and
 * `Element.getBoundingClientRect` both reflect real layout, which we cannot
 * change without changing the page's own layout. Instead we make the *fallback*
 * widths consistent: a page probes a family it expects us to have, and
 * compares to `sans-serif`. Our measureText patch already returns per-family
 * scales, so the comparison resolves the same way the font table says.
 *
 * Nothing to install for the DOM path; this function documents the decision and
 * is a hook for future rect-level jitter if a detector is found that compares
 * DOM width against canvas width. (See docs/design.md, known gaps.)
 */
function patchMeasureRect(profile: Profile): void {
  void profile;
}

/**
 * Intl and timezone.
 *
 * `resolvedOptions().timeZone`, `DateTimeFormat#format` output for a fixed
 * timestamp, and `Date#getTimezoneOffset` must all describe the same zone.
 * We override `timeZone` and re-derive the offset from the same IANA id, so
 * the three cannot disagree even across DST boundaries.
 */
function patchIntl(profile: Profile): void {
  const tz = profile.ua.timeZone;
  const locales = profile.ua.languages;

  const DTF = Intl.DateTimeFormat;
  const nativeResolved = DTF.prototype.resolvedOptions;

  const wrapped = mask(function DateTimeFormat(this: unknown, ...args: unknown[]) {
    const [localesArg, optionsArg] = args as [Intl.LocalesArgument?, Intl.DateTimeFormatOptions?];
    const merged: Intl.DateTimeFormatOptions = { ...(optionsArg ?? {}), timeZone: tz };
    return new DTF(localesArg ?? locales, merged);
  }, 'DateTimeFormat');
  // Set the prototype exactly once, before anything freezes it.
  Object.defineProperty(wrapped, 'prototype', { value: DTF.prototype, writable: false, configurable: false });
  Object.defineProperty(wrapped, 'supportedLocalesOf', {
    value: (DTF.supportedLocalesOf as (...a: unknown[]) => unknown).bind(DTF),
    configurable: true,
  });

  replaceConstructor(Intl as unknown as Record<string, unknown>, 'DateTimeFormat', wrapped as unknown as (...a: any[]) => any);

  replaceMethod(DTF.prototype, 'resolvedOptions', function resolvedOptions(this: Intl.DateTimeFormat) {
    const real = nativeResolved.call(this);
    return { ...real, timeZone: tz };
  });

  // `Intl.NumberFormat` leaks locale formatting and default currency for some
  // locales; force the profile's primary locale.
  const NF = Intl.NumberFormat;
  const nativeNF = NF;
  const wrappedNF = mask(function NumberFormat(this: unknown, localesArg?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return new nativeNF(localesArg ?? locales, options);
  }, 'NumberFormat');
  Object.defineProperty(wrappedNF, 'prototype', { value: NF.prototype, writable: false, configurable: false });
  replaceConstructor(Intl as unknown as Record<string, unknown>, 'NumberFormat', wrappedNF as unknown as (...a: any[]) => any);

  // `Date.prototype.getTimezoneOffset` derives from the same IANA zone. Use the
  // native Date in the target zone through a formatter rather than hardcoding,
  // so DST is handled by the engine and cannot drift from format() output.
  const tzFormatter = new DTF('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const nativeGetTzOffset = Date.prototype.getTimezoneOffset;
  replaceMethod(Date.prototype, 'getTimezoneOffset', function getTimezoneOffset(this: Date) {
    try {
      const parts: Intl.DateTimeFormatPart[] = tzFormatter.formatToParts(this);
      const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      // "GMT+08:00" / "GMT" / "GMT-05:30"
      const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
      if (!m) return 0;
      const sign = m[1] === '-' ? -1 : 1;
      const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
      // getTimezoneOffset is UTC - local, i.e. the negation of the UTC offset.
      return -(sign * minutes);
    } catch {
      return nativeGetTzOffset.call(this);
    }
  });
}

/** Pull the first family out of a CSS font shorthand. */
function primaryFamily(font: string): string | null {
  const afterSize = /\d+(?:\.\d+)?px\s*(?:\/\s*[^\s]+\s+)?(.+)$/.exec(font);
  if (!afterSize) return null;
  const first = afterSize[1]!.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
  return first || null;
}
