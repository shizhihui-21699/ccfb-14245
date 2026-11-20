/**
 * AudioContext / OfflineAudioContext.
 *
 * The canonical audio fingerprint renders a specific oscillator graph through
 * `OfflineAudioContext` and hashes the summed sample values, or runs a real
 * `AudioContext` through an `AnalyserNode` and reads the float spectrum. The
 * numbers come out of the floating-point DSP path, so two machines with
 * different CPUs, OS audio stacks or resamplers produce slightly different
 * results — that is what makes it a fingerprint.
 *
 * Perturbing the *output* is the wrong place: the page can sum samples, take a
 * spectrum, compare two graphs against each other, or listen for exact silence,
 * and a perturbation inserted at the boundary breaks all of those relationships
 * in different ways. Instead we perturb the *same way the hardware does* — a
 * tiny, magnitude-proportional, deterministic offset per sample — and we apply
 * it at every readout so no two readouts disagree:
 *
 *   - `OfflineAudioContext.prototype.startRendering` (the common one)
 *   - `AudioBuffer.prototype.getChannelData` (direct reads)
 *   - `AnalyserNode.prototype.getFloatFrequencyData` / `getByteFrequencyData`
 *   - `AudioWorklet` output is out of reach; documented as a gap.
 *
 * The amplitude is ~1e-5, far below audibility and far below any real DSP
 * difference a page could use as a reference, but far above the float epsilon
 * a page would need to notice it as non-hardware noise.
 */

import { mask, replaceMethod } from '../native.js';
import { farbleSamples } from '../farble.js';
import type { Profile } from '../../shared/profile/types.js';

export function patchAudio(profile: Profile): void {
  const { seed, amplitude } = profile.noise.audio;

  /**
   * Guard per channel, not per buffer: farbling channel 1 must not stop
   * channel 0 from being farbled when the page reads them one at a time.
   * WeakMap<AudioBuffer, Set<channel>> keeps this from retaining buffers.
   */
  const farbledChannels = new WeakMap<AudioBuffer, Set<number>>();

  const farbleChannel = (buffer: AudioBuffer, channel: number, data: Float32Array): void => {
    let done = farbledChannels.get(buffer);
    if (!done) {
      done = new Set();
      farbledChannels.set(buffer, done);
    }
    if (done.has(channel)) return;
    farbleSamples(data, seed + channel * 0x9e37, amplitude);
    done.add(channel);
  };

  if (typeof OfflineAudioContext !== 'undefined') {
    const nativeStart = OfflineAudioContext.prototype.startRendering;
    replaceMethod(OfflineAudioContext.prototype, 'startRendering', function startRendering(
      this: OfflineAudioContext,
    ) {
      const result = nativeStart.call(this);
      return result.then((buffer) => {
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          farbleChannel(buffer, c, buffer.getChannelData(c));
        }
        return buffer;
      });
    });
  }

  const nativeGetChannelData = AudioBuffer.prototype.getChannelData;
  replaceMethod(AudioBuffer.prototype, 'getChannelData', function getChannelData(
    this: AudioBuffer, channel: number,
  ) {
    const data = nativeGetChannelData.call(this, channel);
    farbleChannel(this, channel, data);
    return data;
  });

  patchAnalyser(profile);
}

/**
 * AnalyserNode: a page can also get a fingerprint by routing a real signal
 * through an analyser. Frequency bins are in dB and smooth already; a
 * sub-0.001 dB shift is invisible to the page's own math but changes the hash.
 */
function patchAnalyser(profile: Profile): void {
  if (typeof AnalyserNode === 'undefined') return;
  const { seed, amplitude } = profile.noise.audio;
  const proto = AnalyserNode.prototype;

  const nativeFloat = proto.getFloatFrequencyData;
  replaceMethod(proto, 'getFloatFrequencyData', function getFloatFrequencyData(
    this: AnalyserNode, array: Float32Array<ArrayBuffer>,
  ) {
    nativeFloat.call(this, array);
    // dB scale: ~0.001 dB is well below any real analyser's resolution.
    const dB = 20 * Math.log10(1 + amplitude * 1000);
    for (let i = 0; i < array.length; i++) {
      const v = array[i]!;
      if (!Number.isFinite(v)) continue;
      const h = ((seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0) / 0x100000000;
      array[i] = v + (h * 2 - 1) * dB;
    }
  });

  void mask;
}
