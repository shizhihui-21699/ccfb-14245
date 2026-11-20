/**
 * Native disguise.
 *
 * Every patched function must be indistinguishable from the built-in it
 * replaces. That is not a nicety: `Function.prototype.toString` output is
 * *the* cheapest anti-tamper check there is, and any modern detector runs it.
 * A patched `toDataURL` whose source reads `function () { return ...; }` is a
 * louder signal than the original fingerprint ever was.
 *
 * The approach mirrors what Brave does for farbling, with one addition: the
 * fake-native table lives in a WeakMap rather than in a closure that the page
 * could reach through `toString.caller` or a stack trace, and every replacement
 * copies the original's `name`, `length` and property descriptor.
 */

type AnyFn = (...args: any[]) => any;

const fakeNatives = new WeakMap<Function, string>();
const originalToString = Function.prototype.toString;

function nativeSource(name: string): string {
  return `function ${name}() { [native code] }`;
}

/** Register `fn` as a native function named `name` for toString purposes. */
export function mask<T extends Function>(fn: T, name: string): T {
  fakeNatives.set(fn, name);
  return fn;
}

/**
 * Install the toString patch. Must be called before any other patch, and only
 * once per realm. Returns a disposer (used by tests).
 */
export function installNativeToString(): () => void {
  const patched = function toString(this: unknown): string {
    const name = fakeNatives.get(this as Function);
    if (name !== undefined) return nativeSource(name);
    return originalToString.call(this);
  };
  mask(patched, 'toString');

  // The descriptor must look exactly like the built-in's.
  Object.defineProperty(Function.prototype, 'toString', {
    value: patched,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return () => {
    Object.defineProperty(Function.prototype, 'toString', {
      value: originalToString,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };
}

/**
 * Replace a method in place, preserving all observable shape.
 * `name` and `length` are copied from the original so that
 * `fn.length === 0` or `fn.name === 'toDataURL'` checks keep passing.
 */
export function replaceMethod(
  target: object,
  prop: string,
  impl: AnyFn,
  opts: { name?: string; length?: number } = {},
): void {
  const original = (target as Record<string, unknown>)[prop];
  if (typeof original !== 'function') {
    throw new Error(`replaceMethod: ${prop} is not a method`);
  }
  const name = opts.name ?? original.name;
  const length = opts.length ?? original.length;
  Object.defineProperty(impl, 'name', { value: name, configurable: true });
  Object.defineProperty(impl, 'length', { value: length, configurable: true });
  mask(impl, name);

  const desc = Object.getOwnPropertyDescriptor(target, prop) ?? {
    writable: true, enumerable: false, configurable: true,
  };
  Object.defineProperty(target, prop, {
    value: impl,
    writable: desc.writable ?? true,
    enumerable: desc.enumerable ?? false,
    configurable: desc.configurable ?? true,
  });
}

/**
 * Replace an accessor (getter/setter pair) preserving descriptor flags.
 * If the original is a data property, this throws: a data property must not
 * suddenly become an accessor, which is itself a detectable change.
 */
export function replaceGetter(
  target: object,
  prop: string,
  get: () => unknown,
  set?: (value: unknown) => void,
): void {
  const desc = Object.getOwnPropertyDescriptor(target, prop);
  if (!desc) throw new Error(`replaceGetter: no ${prop} on target`);
  if (!desc.get) throw new Error(`replaceGetter: ${prop} is a data property`);
  const maskedGet = mask(function getter() { return get(); }, `get ${prop}`);
  const next: PropertyDescriptor = {
    get: maskedGet,
    enumerable: desc.enumerable,
    configurable: desc.configurable,
  };
  if (desc.set || set) {
    next.set = set
      ? mask(function setter(v: unknown) { set(v); }, `set ${prop}`)
      : desc.set;
  }
  Object.defineProperty(target, prop, next);
}

/** Define a new accessor on `target` (used for properties that don't exist
 *  until they are supported, e.g. `navigator.userAgentData` in older shells). */
export function defineGetter(target: object, prop: string, get: () => unknown): void {
  const maskedGet = mask(function getter() { return get(); }, `get ${prop}`);
  Object.defineProperty(target, prop, {
    get: maskedGet,
    enumerable: true,
    configurable: true,
  });
}

/** Replace a global constructor (Intl.DateTimeFormat, Worker, ...) keeping the
 *  prototype chain intact so `instanceof` and subclassing still behave. */
export function replaceConstructor(
  holder: Record<string, unknown>,
  prop: string,
  impl: AnyFn,
): void {
  const original = holder[prop] as { prototype?: unknown } | undefined;
  Object.defineProperty(impl, 'name', { value: prop, configurable: true });
  mask(impl, prop);
  /**
   * A function's own `prototype` is non-configurable and may have been frozen
   * by the caller; assigning to it throws. If it already points at the right
   * object there is nothing to do, and if it does not, the caller built the
   * wrapper wrong (see the DateTimeFormat case). Never let this be the reason
   * an entire domain's patches fail.
   */
  try {
    if (original && original.prototype && impl.prototype !== original.prototype) {
      impl.prototype = original.prototype;
    }
  } catch {
    /* keep the wrapper's own prototype; the caller is responsible for identity */
  }
  Object.defineProperty(holder, prop, {
    value: impl,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

