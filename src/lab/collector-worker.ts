/**
 * The lab's worker. Collects the same facts a detector would collect from a
 * worker: navigator values, and a canvas fingerprint via OffscreenCanvas, which
 * has no DOM entry point to inspect.
 */

import { hashBytes } from './collectors.js';
import { drawProbe } from './probe-drawing.js';

interface CollectRequest {
  type: 'collect';
}

self.onmessage = (ev: MessageEvent<CollectRequest>) => {
  if (ev.data?.type !== 'collect') return;

  const nav = self.navigator as unknown as {
    userAgent: string;
    hardwareConcurrency: number;
    platform: string;
    deviceMemory?: number;
  };
  const facts = {
    ua: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    platform: nav.platform,
    canvasHash: null as string | null,
    canvasMatchesWindow: null as boolean | null,
    timeZone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
      } catch {
        return null;
      }
    })(),
    error: null as string | null,
  };

  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(240, 60);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (ctx) {
        /**
         * The drawing must be *byte-identical* to the one the window and iframe
         * use (lab/probe-drawing.ts), or the cross-context matrix reports a
         * difference that comes from the test's own inconsistency rather than
         * from the defence. Keep the three call sites in lockstep.
         */
        drawProbe(ctx as unknown as CanvasRenderingContext2D);
        const data = ctx.getImageData(0, 0, 240, 60).data;
        facts.canvasHash = hashBytes(data);
      }
    }
  } catch (e) {
    facts.error = String((e as Error)?.message ?? e);
  }

  (self as unknown as Worker).postMessage(facts);
};

export {};
