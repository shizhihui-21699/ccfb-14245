/**
 * Lab types.
 *
 * The lab is deliberately adversarial: its job is to find a contradiction that
 * proves the profile is synthetic, not to confirm that patching happened. Every
 * detector therefore compares two independent sources of truth and reports only
 * when they disagree.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Category =
  | 'cross-source' // two APIs disagree about the same fact
  | 'unnatural'    // impossible hardware, or an artefact no real browser emits
  | 'instability'  // the same thing read twice differs
  | 'wire'         // server-side headers disagree with page-side values
  | 'informational';

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  category: Category;
  evidence: Record<string, unknown>;
  explains: string;
  key: string;
}

export interface Collected<T> {
  ok: boolean;
  value: T | null;
  error?: string;
  ms?: number;
}

export interface UaFacts {
  ua: string;
  appVersion: string;
  platform: string;
  vendor: string;
  brands: Array<{ brand: string; version: string }> | null;
  uaDataPlatform: string | null;
  uaFullVersion: string | null;
  ah: string | null;
  bitness: string | null;
  wow64: boolean | null;
  mobile: boolean | null;
  webdriver: boolean;
  pdfViewerEnabled: boolean;
  plugins: number;
  mimeTypes: number;
  maxTouchPoints: number;
  doNotTrack: string | null;
  language: string;
  languages: string[];
  cookiesEnabled: boolean;
}

export interface ScreenFacts {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
  dpr: number;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  orientationType: string | null;
  orientationAngle: number | null;
  visualViewportScale: number | null;
  refreshHz: number | null;
}

export interface HardwareFacts {
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  battery: { charging: boolean; level: number; chargingTime: number; dischargingTime: number } | null;
  batteryError: string | null;
  connection: { effectiveType: string; rtt: number; downlink: number; saveData: boolean } | null;
}

export interface CanvasFacts {
  /** Stable digest of a text+gradient render. */
  textHash: string;
  /** Same drawing, read back via getImageData and hashed from raw bytes. */
  imageDataHash: string;
  /** Same drawing, read via toDataURL and hashed. */
  dataUrlHash: string;
  /** Hash after decoding the toDataURL output and re-reading the pixels. */
  roundTripHash: string;
  /** Max per-channel difference between imageData and the decoded data URL. */
  roundTripMaxDelta: number;
  /** Distinct colours in a solid fill, after farbling. Must be 1 on any browser. */
  solidFillColours: number;
  /** Distinct colours in a two-colour checkerboard. */
  checkerColours: number;
  /** Max per-channel delta observed between two independently drawn copies. */
  maxSelfDelta: number;
  /** Whether two consecutive renders of the same drawing agree byte for byte. */
  stable: boolean;
  width: number;
  height: number;
}

export interface WebglFacts {
  supported: boolean;
  vendor: string | null;
  renderer: string | null;
  unmaskedVendor: string | null;
  unmaskedRenderer: string | null;
  version: string | null;
  shadingLanguageVersion: string | null;
  maxTextureSize: number | null;
  maxRenderbufferSize: number | null;
  maxViewport: [number, number] | null;
  maxVertexAttribs: number | null;
  maxVaryingVectors: number | null;
  maxCombinedTextureUnits: number | null;
  maxTextureUnits: number | null;
  maxFragmentUniformVectors: number | null;
  maxVertexUniformVectors: number | null;
  extensions: string[] | null;
  precision: { vertexHigh: number | null; fragmentHigh: number | null };
  /** Hash of the pixels from a shader render, read back with readPixels. */
  pixelHash: string | null;
  /** Same render, copied into a 2D canvas and hashed there. */
  viaCanvasHash: string | null;
  webgl2: boolean;
}

export interface AudioFacts {
  hash: string;
  /** Sum of a fixed slice, the classic audio fingerprint scalar. */
  sum: number;
  sampleCount: number;
  /** Re-render result, to detect instability. */
  stable: boolean;
}

export interface FontFacts {
  /** Families the page believes are present, by the multiple-probe method. */
  detected: string[];
  /** Subset that `document.fonts.check()` also says are present. */
  checkAgree: string[];
  /** Families where check() and measurement disagreed. */
  disagreements: string[];
  /** Width of a fixed probe string in each detected family. */
  widths: Record<string, number>;
}

export interface LocaleFacts {
  timeZone: string;
  offsetMinutes: number;
  languages: string[];
  resolvedLocale: string;
  numberFormat: string;
  dateFormat: string;
  currency: string | null;
  firstDayOfWeek: string | null;
}

export interface MediaFacts {
  audioInputs: number;
  audioOutputs: number;
  videoInputs: number;
  ids: string[];
  /** Stable across two calls? */
  stable: boolean;
  labelsVisible: boolean;
}

export interface NativeFacts {
  /** Functions whose toString does not match /native code/. */
  nonNative: string[];
  /** Own-property checks that should be false on the prototypes. */
  ownProps: string[];
  /** Descriptor anomalies: accessor where a data property is expected, etc. */
  descriptorAnomalies: string[];
  /** Stack traces that mention extension URLs or injected file names. */
  stackLeaks: string[];
  /** Keys that appear on prototypes but not on a fresh shell's. */
  extraKeys: string[];
}

export interface WorkerFacts {
  ua: string | null;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  platform: string | null;
  canvasHash: string | null;
  /** Whether the worker's canvas fingerprint equals the window's. */
  canvasMatchesWindow: boolean | null;
  timeZone: string | null;
  error: string | null;
}

export interface Snapshot {
  takenAt: number;
  url: string;
  ua: Collected<UaFacts>;
  screen: Collected<ScreenFacts>;
  hardware: Collected<HardwareFacts>;
  canvas: Collected<CanvasFacts>;
  webgl: Collected<WebglFacts>;
  audio: Collected<AudioFacts> | null;
  fonts: Collected<FontFacts>;
  locale: Collected<LocaleFacts>;
  media: Collected<MediaFacts>;
  native: Collected<NativeFacts>;
  worker: Collected<WorkerFacts> | null;
  iframe: Collected<{ canvasHash: string | null; ua: string | null; cores: number | null }> | null;
}

export interface Report {
  buildId: string | null;
  snapshot: Snapshot;
  findings: Finding[];
  score: { critical: number; high: number; medium: number; low: number; informational: number };
}
