/**
 * The one drawing the lab uses everywhere.
 *
 * The cross-context matrix compares a canvas hash from the top window, a
 * Worker and an iframe. If the three call sites draw even slightly different
 * things, the matrix reports a mismatch that has nothing to do with the
 * defence — a false positive that would send someone hunting a bug that is not
 * there. So the drawing lives here, once, and every collector calls it.
 *
 * Dimensions are fixed at 240x60 and every coordinate is explicit; no layout,
 * no DPR scaling, no font loading beyond what the platform already has.
 */
export const PROBE_WIDTH = 240;
export const PROBE_HEIGHT = 60;

export function drawProbe(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#f60';
  ctx.fillRect(0, 0, 144, 24);

  ctx.fillStyle = '#069';
  ctx.font = '14px "Arial"';
  ctx.fillText('Fingerprint Sandbox 指纹 #1', 2, 16);

  ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
  ctx.font = '18px "Times New Roman"';
  ctx.fillText('Fingerprint Sandbox 指纹 #2', 4, 32);

  const grad = ctx.createLinearGradient(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  grad.addColorStop(0, '#123456');
  grad.addColorStop(1, '#fedcba');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 36, PROBE_WIDTH, 24);
}
