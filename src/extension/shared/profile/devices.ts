/**
 * The device corpus.
 *
 * This is where realism actually comes from. Every entry is a coherent
 * description of a machine that really exists: the CPU core count, memory,
 * GPU string, screen, refresh rate and font set appear together in the wild,
 * and never in combinations that a hardware-aware detector can rule out.
 *
 * Rules for editing this file:
 *  1. Every `gpu.renderer` must use the exact ANGLE spelling current Chrome
 *     emits for that backend (Metal on macOS, D3D11 on Windows, OpenGL on Linux).
 *  2. `screen` must be a real panel: CSS dimensions are physical pixels / dpr,
 *     and availWidth/availHeight must reflect the actual taskbar/menubar/dock.
 *  3. Core counts must exist for that chip: an M1 has 8 cores, never 6; an
 *     i7-1165G7 has 4 (8 threads), never 12.
 *  4. Do not add entries for exotic hardware. A fingerprint pool is useful only
 *     if every member is common enough to be plausible.
 */

export interface ScreenSpec {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  dpr: number;
  refreshHz: number;
}

export interface GpuSpec {
  /** WebGL UNMASKED_VENDOR_WEBGL. */
  vendor: string;
  /** WebGL UNMASKED_RENDERER_WEBGL. */
  renderer: string;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDim: number;
  maxVertexAttribs: number;
  maxVaryingVectors: number;
  maxCombinedTextureUnits: number;
  maxTextureUnits: number;
  maxFragmentUniformVectors: number;
  maxVertexUniformVectors: number;
  /**
   * Number of entries `getSupportedExtensions()` returns.
   *
   * This is a property of the *browser*, not of the GPU: Chrome 157 exposes the
   * same 36 extensions on every desktop backend. The field exists so profiles
   * can differ if that ever stops being true, but every entry currently uses
   * the captured value.
   */
  extensionCount: number;
}

export interface DeviceClass {
  id: string;
  os: 'windows' | 'macos' | 'linux';
  /** Human label, used in the options UI only. */
  label: string;
  arch: 'x86' | 'arm';
  /** Plausible core counts (navigator.hardwareConcurrency). */
  cores: number[];
  /** Plausible memory values in GB (navigator.deviceMemory is capped at 8). */
  memoryGB: number[];
  screens: ScreenSpec[];
  gpus: GpuSpec[];
  /** Chrome platform version reported through getHighEntropyValues(). */
  platformVersion: string;
  /** Whether the class is typically a laptop (battery, webcam, fewer cores). */
  laptop: boolean;
  /** Font families that must be present for this OS to look untouched. */
  requiredFonts: string[];
  /** Optional font families installed by common software (Office, Adobe, CJK packs). */
  optionalFonts: string[];
}

const WIN_FONTS_REQUIRED = [
  'Arial', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola',
  'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Leelawadee UI', 'Lucida Console',
  'Malgun Gothic', 'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue',
  'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le', 'Microsoft YaHei',
  'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
  'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script', 'Segoe UI',
  'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun', 'Sitka Banner',
  'Sitka Display', 'Sitka Heading', 'Sitka Small', 'Sitka Subheading', 'Sitka Text',
  'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings',
  'Wingdings', 'Yu Gothic', 'Yu Gothic UI',
];

const WIN_FONTS_OPTIONAL = [
  'Bahnschrift', 'Batang', 'Browallia New', 'Cordia New', 'DengXian', 'DFKai-SB',
  'FangSong', 'KaiTi', 'Lucida Sans Unicode', 'Marlett', 'MingLiU', 'MS Mincho', 'NSimSun',
  'PMingLiU', 'SimHei', 'SimSun-ExtB', 'Yu Mincho', 'Arial Black', 'Arial Narrow',
  'Bookshelf Symbol 7', 'MS Outlook', 'MS Reference Sans Serif', 'Wingdings 2', 'Wingdings 3',
];

const MAC_FONTS_REQUIRED = [
  'American Typewriter', 'Andale Mono', 'Apple Chancery', 'Apple Color Emoji',
  'Apple SD Gothic Neo', 'Arial', 'Arial Black', 'Arial Hebrew', 'Arial Narrow',
  'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Avenir Next Condensed', 'Baskerville',
  'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard', 'Chalkduster',
  'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New', 'Didot',
  'Futura', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Herculanum',
  'Hoefler Text', 'Impact', 'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Monaco',
  'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'Rockwell', 'Savoye LET',
  'SignPainter', 'Skia', 'Snell Roundhand', 'Songti SC', 'STHeiti', 'Superclarendon',
  'Tahoma', 'Times', 'Times New Roman', 'Trattatello', 'Trebuchet MS', 'Verdana',
  'Zapf Dingbats', 'Zapfino', 'PingFang HK', 'PingFang SC', 'PingFang TC',
  'Hiragino Sans', 'Hiragino Mincho ProN', 'Heiti SC', 'Kaiti SC', 'Baoli SC',
  'Hannotate SC', 'HanziPen SC', 'Libian SC', 'Wawati SC', 'Weibei SC', 'Xingkai SC',
  'Yuanti SC', 'Yuppy SC', 'SF Pro Display', 'SF Pro Rounded', 'SF Pro Text',
  'STSong', 'STKaiti', 'STFangsong', 'STXihei', 'STZhongsong',
];

const MAC_FONTS_OPTIONAL = [
  'Advent Pro', 'Al Bayan', 'Al Nile', 'Al Tarikh', 'Apple Braille', 'Apple LiGothic',
  'Apple LiSung', 'Apple Symbols', 'Ayuthaya', 'Baghdad', 'Beirut', 'Damascus', 'Diwan Kufi',
  'Diwan Thuluth', 'Euphemia UCAS', 'Farah', 'Farisi', 'Geeza Pro', 'Gujarati MT',
  'Gurmukhi MN', 'Hannotate TC', 'HanziPen TC', 'Hiragino Maru Gothic ProN', 'Kailasa',
  'Kannada MN', 'Kefa', 'Khmer MN', 'Kohinoor Devanagari', 'Kokonor', 'Krungthep',
  'Lao MN', 'Lucida Grande', 'Malayalam MN', 'Mishafi', 'Muna', 'Myanmar MN', 'Nadeem',
  'Noto Nastaliq Urdu', 'Oriya MN', 'Palatino', 'PingFang HK', 'Sana', 'Sathu', 'Silom',
  'Sinhala MN', 'Tamil MN', 'Telugu MN', 'Thonburi', 'Waseem', 'Webdings', 'Wingdings',
  'Athelas', 'Bank Gothic', 'Bodoni 72 Oldstyle', 'Bodoni 72 Smallcaps', 'Corsiva Hebrew',
  'DIN Alternate', 'DIN Condensed', 'DecoType Naskh', 'Devragu', 'Galvji', 'KufiStandardGK',
  'Microsoft Sans Serif', 'Mshtakan', 'New Peninim MT', 'Raanana', 'STIX Two Math',
];

const LINUX_FONTS_REQUIRED = [
  'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Liberation Sans', 'Liberation Mono',
  'Liberation Serif', 'Noto Sans', 'Noto Serif', 'Noto Mono', 'Ubuntu', 'Ubuntu Mono',
  'Cantarell', 'FreeSans', 'FreeSerif', 'Nimbus Sans', 'Nimbus Roman', 'Bitstream Vera Sans',
  'Carlito', 'Caladea', 'Droid Sans', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei',
  'WenQuanYi Zen Hei', 'Arial', 'Courier New', 'Times New Roman', 'Verdana',
];

const LINUX_FONTS_OPTIONAL = [
  'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Thai', 'Noto Color Emoji',
  'Source Code Pro', 'Fira Sans', 'Fira Code', 'JetBrains Mono', 'Roboto', 'Roboto Mono',
  'Open Sans', 'Lato', 'Montserrat', 'Oxygen', 'Quicksand', 'Droid Sans Fallback',
  'Noto Serif CJK SC', 'Sarai', 'Lohit Devanagari', 'Padauk', 'KacstOne',
];

const SCREEN_1080P_FHD: ScreenSpec = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, dpr: 1, refreshHz: 60 };
const SCREEN_16_9_1440: ScreenSpec = { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, dpr: 1, refreshHz: 144 };
const SCREEN_13_LAPTOP: ScreenSpec = { width: 1366, height: 768, availWidth: 1366, availHeight: 728, dpr: 1, refreshHz: 60 };
const SCREEN_15_LAPTOP_125: ScreenSpec = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, dpr: 1.25, refreshHz: 60 };
const SCREEN_4K_DESKTOP: ScreenSpec = { width: 3840, height: 2160, availWidth: 3840, availHeight: 2120, dpr: 2, refreshHz: 60 };
const SCREEN_MBP14: ScreenSpec = { width: 3024, height: 1964, availWidth: 3024, availHeight: 1899, dpr: 2, refreshHz: 120 };
const SCREEN_MBP16: ScreenSpec = { width: 3456, height: 2234, availWidth: 3456, availHeight: 2169, dpr: 2, refreshHz: 120 };
const SCREEN_MBP15_RETINA: ScreenSpec = { width: 2880, height: 1800, availWidth: 2880, availHeight: 1735, dpr: 2, refreshHz: 60 };
const SCREEN_MBA13: ScreenSpec = { width: 2560, height: 1664, availWidth: 2560, availHeight: 1599, dpr: 2, refreshHz: 60 };
const SCREEN_STUDIO_DISPLAY: ScreenSpec = { width: 5120, height: 2880, availWidth: 5120, availHeight: 2815, dpr: 2, refreshHz: 60 };
const SCREEN_LINUX_1440P: ScreenSpec = { width: 2560, height: 1440, availWidth: 2560, availHeight: 1403, dpr: 1, refreshHz: 60 };
const SCREEN_LINUX_1080P: ScreenSpec = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1053, dpr: 1, refreshHz: 60 };

function winGpu(vendor: string, renderer: string, opts: Partial<GpuSpec> = {}): GpuSpec {
  return {
    vendor,
    renderer,
    maxTextureSize: 16384,
    maxRenderbufferSize: 16384,
    maxViewportDim: 32767,
    maxVertexAttribs: 16,
    maxVaryingVectors: 30,
    maxCombinedTextureUnits: 32,
    maxTextureUnits: 16,
    maxFragmentUniformVectors: 1024,
    maxVertexUniformVectors: 4096,
    extensionCount: 36,
    ...opts,
  };
}

export const DEVICE_CLASSES: DeviceClass[] = [
  // ---------------------------------------------------------------- Windows
  {
    id: 'win-desktop-rtx3060',
    os: 'windows',
    label: 'Windows 11 desktop, RTX 3060',
    arch: 'x86',
    cores: [12, 16],
    memoryGB: [8, 16],
    screens: [SCREEN_1080P_FHD, SCREEN_16_9_1440],
    gpus: [
      winGpu('Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxCombinedTextureUnits: 192, maxTextureUnits: 32, maxFragmentUniformVectors: 4096,
      }),
      winGpu('Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxCombinedTextureUnits: 192, maxTextureUnits: 32, maxFragmentUniformVectors: 4096,
      }),
    ],
    platformVersion: '15.0.0',
    laptop: false,
    requiredFonts: WIN_FONTS_REQUIRED,
    optionalFonts: WIN_FONTS_OPTIONAL,
  },
  {
    id: 'win-desktop-rx6600',
    os: 'windows',
    label: 'Windows 10 desktop, RX 6600',
    arch: 'x86',
    cores: [6, 8, 12],
    memoryGB: [8, 16],
    screens: [SCREEN_1080P_FHD],
    gpus: [
      winGpu('Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxCombinedTextureUnits: 192, maxTextureUnits: 32, maxFragmentUniformVectors: 4096,
      }),
      winGpu('Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 2048SP (0x00006FDF) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxCombinedTextureUnits: 192, maxTextureUnits: 32, maxFragmentUniformVectors: 4096,
      }),
    ],
    platformVersion: '10.0.0',
    laptop: false,
    requiredFonts: WIN_FONTS_REQUIRED,
    optionalFonts: WIN_FONTS_OPTIONAL,
  },
  {
    id: 'win-laptop-iris',
    os: 'windows',
    label: 'Windows 11 laptop, Iris Xe',
    arch: 'x86',
    cores: [8, 12],
    memoryGB: [8, 16],
    screens: [SCREEN_13_LAPTOP, SCREEN_15_LAPTOP_125, SCREEN_1080P_FHD],
    gpus: [
      winGpu('Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxTextureSize: 16384, maxVaryingVectors: 32, maxCombinedTextureUnits: 64,
        maxTextureUnits: 32, maxFragmentUniformVectors: 2048,
      }),
      winGpu('Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxVaryingVectors: 32, maxCombinedTextureUnits: 64, maxTextureUnits: 32,
        maxFragmentUniformVectors: 2048, extensionCount: 36,
      }),
    ],
    platformVersion: '15.0.0',
    laptop: true,
    requiredFonts: WIN_FONTS_REQUIRED,
    optionalFonts: WIN_FONTS_OPTIONAL,
  },
  {
    id: 'win-desktop-gtx1660s',
    os: 'windows',
    label: 'Windows 10 desktop, GTX 1660 SUPER',
    arch: 'x86',
    cores: [4, 6, 8],
    memoryGB: [8, 16],
    screens: [SCREEN_1080P_FHD, SCREEN_16_9_1440],
    gpus: [
      winGpu('Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (0x000021C4) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxCombinedTextureUnits: 192, maxTextureUnits: 32, maxFragmentUniformVectors: 4096,
      }),
    ],
    platformVersion: '10.0.0',
    laptop: false,
    requiredFonts: WIN_FONTS_REQUIRED,
    optionalFonts: WIN_FONTS_OPTIONAL,
  },
  {
    id: 'win-laptop-gtx1650',
    os: 'windows',
    label: 'Windows 11 gaming laptop, GTX 1650',
    arch: 'x86',
    cores: [8, 12, 16],
    memoryGB: [8, 16],
    screens: [SCREEN_1080P_FHD, SCREEN_15_LAPTOP_125],
    gpus: [
      winGpu('Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F91) Direct3D11 vs_5_0 ps_5_0, D3D11)', {
        maxCombinedTextureUnits: 192, maxTextureUnits: 32, maxFragmentUniformVectors: 4096,
      }),
    ],
    platformVersion: '15.0.0',
    laptop: true,
    requiredFonts: WIN_FONTS_REQUIRED,
    optionalFonts: WIN_FONTS_OPTIONAL,
  },
  // ------------------------------------------------------------------ macOS
  {
    id: 'mac-m4-max',
    os: 'macos',
    label: 'MacBook Pro 16" M4 Max',
    arch: 'arm',
    cores: [14, 16],
    memoryGB: [8],
    screens: [SCREEN_MBP16, SCREEN_STUDIO_DISPLAY],
    gpus: [
      {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)',
        maxTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDim: 32767,
        maxVertexAttribs: 16,
        maxVaryingVectors: 31,
        maxCombinedTextureUnits: 32,
        maxTextureUnits: 16,
        maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096,
        extensionCount: 36,
      },
    ],
    platformVersion: '26.5.1',
    laptop: true,
    requiredFonts: MAC_FONTS_REQUIRED,
    optionalFonts: MAC_FONTS_OPTIONAL,
  },
  {
    id: 'mac-m2-pro',
    os: 'macos',
    label: 'MacBook Pro 14" M2 Pro',
    arch: 'arm',
    cores: [10, 12],
    memoryGB: [8],
    screens: [SCREEN_MBP14, SCREEN_MBP15_RETINA],
    gpus: [
      {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
        maxTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDim: 32767,
        maxVertexAttribs: 16,
        maxVaryingVectors: 31,
        maxCombinedTextureUnits: 32,
        maxTextureUnits: 16,
        maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096,
        extensionCount: 36,
      },
    ],
    platformVersion: '15.6.1',
    laptop: true,
    requiredFonts: MAC_FONTS_REQUIRED,
    optionalFonts: MAC_FONTS_OPTIONAL,
  },
  {
    id: 'mac-m1',
    os: 'macos',
    label: 'MacBook Air 13" M1',
    arch: 'arm',
    cores: [8],
    memoryGB: [8],
    screens: [SCREEN_MBA13],
    gpus: [
      {
        vendor: 'Google Inc. (Apple)',
        renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
        maxTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDim: 32767,
        maxVertexAttribs: 16,
        maxVaryingVectors: 31,
        maxCombinedTextureUnits: 32,
        maxTextureUnits: 16,
        maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096,
        extensionCount: 36,
      },
    ],
    platformVersion: '14.7.2',
    laptop: true,
    requiredFonts: MAC_FONTS_REQUIRED,
    optionalFonts: MAC_FONTS_OPTIONAL,
  },
  {
    id: 'mac-intel-iris',
    os: 'macos',
    label: 'MacBook Pro 13" (Intel, Iris Plus)',
    arch: 'x86',
    cores: [4, 8],
    memoryGB: [8],
    screens: [SCREEN_MBP15_RETINA],
    gpus: [
      {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 640, Unspecified Version)',
        maxTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDim: 32767,
        maxVertexAttribs: 16,
        maxVaryingVectors: 31,
        maxCombinedTextureUnits: 32,
        maxTextureUnits: 16,
        maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096,
        extensionCount: 36,
      },
    ],
    platformVersion: '12.7.6',
    laptop: true,
    requiredFonts: MAC_FONTS_REQUIRED,
    optionalFonts: MAC_FONTS_OPTIONAL,
  },
  // ------------------------------------------------------------------ Linux
  {
    id: 'linux-desktop-nvidia',
    os: 'linux',
    label: 'Linux desktop, GTX 1660 SUPER',
    arch: 'x86',
    cores: [8, 12, 16],
    memoryGB: [8, 16],
    screens: [SCREEN_LINUX_1080P, SCREEN_LINUX_1440P],
    gpus: [
      {
        vendor: 'Google Inc. (NVIDIA Corporation)',
        renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.171.04)',
        maxTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDim: 32767,
        maxVertexAttribs: 16,
        maxVaryingVectors: 32,
        maxCombinedTextureUnits: 192,
        maxTextureUnits: 32,
        maxFragmentUniformVectors: 4096,
        maxVertexUniformVectors: 4096,
        extensionCount: 36,
      },
    ],
    platformVersion: '6.8.0',
    laptop: false,
    requiredFonts: LINUX_FONTS_REQUIRED,
    optionalFonts: LINUX_FONTS_OPTIONAL,
  },
  {
    id: 'linux-laptop-mesa',
    os: 'linux',
    label: 'Linux laptop, Intel Mesa',
    arch: 'x86',
    cores: [4, 8],
    memoryGB: [8],
    screens: [SCREEN_LINUX_1080P],
    gpus: [
      {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)',
        maxTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDim: 32767,
        maxVertexAttribs: 16,
        maxVaryingVectors: 32,
        maxCombinedTextureUnits: 64,
        maxTextureUnits: 32,
        maxFragmentUniformVectors: 2048,
        maxVertexUniformVectors: 4096,
        extensionCount: 36,
      },
    ],
    platformVersion: '6.5.0',
    laptop: true,
    requiredFonts: LINUX_FONTS_REQUIRED,
    optionalFonts: LINUX_FONTS_OPTIONAL,
  },
];

export const DEVICE_CLASS_BY_ID = new Map(DEVICE_CLASSES.map((d) => [d.id, d]));

/**
 * The exact list Chrome 157 exposes, in its own ordering.
 *
 * Captured from a real `getSupportedExtensions()` call rather than typed from
 * memory, because both the set and the order are observable and a page can
 * compare them against a reference. Two invariants follow from the capture:
 *
 *  - `WEBGL_debug_renderer_info` is present in every profile. It is how the
 *    unmasked vendor/renderer are read, and a profile that hides it while
 *    claiming to be a desktop GPU is both inconsistent and self-defeating. This
 *    was a real bug: the canonical list had 44 entries with debug_renderer_info
 *    at index 35, but GPU families were sliced to 34-36, silently dropping it
 *    for some profiles.
 *  - Families with fewer extensions use a *prefix* of this order.
 */
export const WEBGL_EXTENSIONS_CANONICAL = [
  'ANGLE_instanced_arrays',
  'EXT_blend_minmax',
  'EXT_clip_control',
  'EXT_color_buffer_half_float',
  'EXT_depth_clamp',
  'EXT_disjoint_timer_query',
  'EXT_float_blend',
  'EXT_frag_depth',
  'EXT_polygon_offset_clamp',
  'EXT_shader_texture_lod',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'EXT_texture_mirror_clamp_to_edge',
  'EXT_sRGB',
  'OES_element_index_uint',
  'OES_fbo_render_mipmap',
  'OES_standard_derivatives',
  'OES_texture_float',
  'OES_texture_float_linear',
  'OES_texture_half_float',
  'OES_texture_half_float_linear',
  'OES_vertex_array_object',
  'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_depth_texture',
  'WEBGL_draw_buffers',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
  'WEBGL_polygon_mode',
] as const;

/** Extensions a profile must never omit, whatever family it claims. */
const REQUIRED_WEBGL_EXTENSIONS = ['WEBGL_debug_renderer_info'] as const;

/**
 * Build a profile's extension list: the family's count, taken as a prefix of
 * the real order, with the required entries guaranteed to be present.
 *
 * Slicing a prefix is only correct while the required entries sit *before* the
 * cut; `REQUIRED_WEBGL_EXTENSIONS` is the guard that keeps this true if the
 * list is ever reordered.
 */
export function extensionsForCount(count: number): string[] {
  const n = Math.max(
    Math.min(count, WEBGL_EXTENSIONS_CANONICAL.length),
    WEBGL_EXTENSIONS_CANONICAL.indexOf(REQUIRED_WEBGL_EXTENSIONS[0] as never) + 1,
  );
  return WEBGL_EXTENSIONS_CANONICAL.slice(0, n) as unknown as string[];
}

/**
 * Language/timezone pairs that co-occur. A profile never mixes a language with
 * a timezone from a different region, because that combination is itself a
 * fingerprint and is rare enough to be suspicious.
 */
export const LOCALE_CORPUS: ReadonlyArray<{ languages: string[]; timeZone: string; tzOffsetMinutes: number }> = [
  { languages: ['zh-CN', 'zh'], timeZone: 'Asia/Shanghai', tzOffsetMinutes: 480 },
  { languages: ['zh-TW', 'zh'], timeZone: 'Asia/Taipei', tzOffsetMinutes: 480 },
  { languages: ['zh-HK', 'zh', 'en'], timeZone: 'Asia/Hong_Kong', tzOffsetMinutes: 480 },
  { languages: ['ja-JP', 'ja'], timeZone: 'Asia/Tokyo', tzOffsetMinutes: 540 },
  { languages: ['ko-KR', 'ko'], timeZone: 'Asia/Seoul', tzOffsetMinutes: 540 },
  { languages: ['en-US', 'en'], timeZone: 'America/New_York', tzOffsetMinutes: -300 },
  { languages: ['en-US', 'en'], timeZone: 'America/Chicago', tzOffsetMinutes: -360 },
  { languages: ['en-US', 'en'], timeZone: 'America/Denver', tzOffsetMinutes: -420 },
  { languages: ['en-US', 'en'], timeZone: 'America/Los_Angeles', tzOffsetMinutes: -480 },
  { languages: ['en-GB', 'en'], timeZone: 'Europe/London', tzOffsetMinutes: 0 },
  { languages: ['de-DE', 'de', 'en'], timeZone: 'Europe/Berlin', tzOffsetMinutes: 60 },
  { languages: ['fr-FR', 'fr'], timeZone: 'Europe/Paris', tzOffsetMinutes: 60 },
  { languages: ['es-ES', 'es'], timeZone: 'Europe/Madrid', tzOffsetMinutes: 60 },
  { languages: ['it-IT', 'it'], timeZone: 'Europe/Rome', tzOffsetMinutes: 60 },
  { languages: ['ru-RU', 'ru'], timeZone: 'Europe/Moscow', tzOffsetMinutes: 180 },
  { languages: ['pt-BR', 'pt'], timeZone: 'America/Sao_Paulo', tzOffsetMinutes: -180 },
  { languages: ['en-CA', 'en', 'fr'], timeZone: 'America/Toronto', tzOffsetMinutes: -300 },
  { languages: ['en-AU', 'en'], timeZone: 'Australia/Sydney', tzOffsetMinutes: 600 },
  { languages: ['en-IN', 'en'], timeZone: 'Asia/Kolkata', tzOffsetMinutes: 330 },
  { languages: ['nl-NL', 'nl'], timeZone: 'Europe/Amsterdam', tzOffsetMinutes: 60 },
];
