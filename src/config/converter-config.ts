/**
 * Single source of truth for converter limits, presets and codec preferences.
 * Change values here only; every module and the UI read from this file.
 * Rationale for each value is documented in arsitektur.md §5.1 and README.md.
 */

export const IMPORT_LIMITS = {
  /** Maximum size of a single uploaded .html/.htm file. */
  maxHtmlBytes: 10 * 1024 * 1024,
  /** Maximum size of an uploaded .zip file (compressed). */
  maxZipBytes: 25 * 1024 * 1024,
  /** Maximum total size of all extracted files. */
  maxExtractedBytes: 100 * 1024 * 1024,
  /** Maximum number of entries (files) inside an archive. */
  maxArchiveEntries: 500,
  /** Maximum size of one extracted file. */
  maxSingleEntryBytes: 50 * 1024 * 1024,
  /** Reject entries whose uncompressed/compressed ratio exceeds this value (ZIP bomb guard). */
  maxCompressionRatio: 200,
  /** Ratio guard only applies to entries bigger than this, small text files can compress very well. */
  compressionRatioMinBytes: 1024 * 1024,
  /** Maximum directory depth of a path inside an archive. */
  maxPathDepth: 32,
  /** Maximum length of a path inside an archive. */
  maxPathLength: 512,
} as const;

export const ACCEPTED_EXTENSIONS = ['.html', '.htm', '.zip'] as const;

export const RESOLUTION_PRESETS = [
  { id: '1280x720', label: '1280 × 720 (HD 16:9)', width: 1280, height: 720 },
  { id: '1920x1080', label: '1920 × 1080 (Full HD 16:9)', width: 1920, height: 1080 },
  { id: '854x480', label: '854 × 480 (SD 16:9)', width: 854, height: 480 },
  { id: '1080x1080', label: '1080 × 1080 (persegi 1:1)', width: 1080, height: 1080 },
  { id: '1080x1920', label: '1080 × 1920 (vertikal 9:16)', width: 1080, height: 1920 },
  { id: '720x1280', label: '720 × 1280 (vertikal 9:16)', width: 720, height: 1280 },
  { id: '300x250', label: '300 × 250 (banner)', width: 300, height: 250 },
  { id: '728x90', label: '728 × 90 (leaderboard)', width: 728, height: 90 },
] as const;

export type ResolutionPresetId = (typeof RESOLUTION_PRESETS)[number]['id'];

export const FRAME_RATES = [24, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const RECORDING_LIMITS = {
  minDurationSeconds: 0.5,
  maxDurationSeconds: 300,
  defaultDurationSeconds: 10,
  /** MediaRecorder timeslice; small chunks keep progress responsive and limit data loss on errors. */
  timesliceMs: 1000,
  /** Video bitrate requested from MediaRecorder for the intermediate recording. */
  recorderVideoBitsPerSecond: 8_000_000,
  recorderAudioBitsPerSecond: 192_000,
} as const;

export const DEFAULT_SETTINGS = {
  method: 'direct',
  autoDuration: true,
  autoStart: true,
  outputFormat: 'mp4',
  resolutionId: '1280x720',
  frameRate: 30,
  durationSeconds: RECORDING_LIMITS.defaultDurationSeconds,
  includeAudio: true,
  restartOnRecord: true,
} as const;

/**
 * MediaRecorder MIME candidates in order of preference. The first one reported by
 * MediaRecorder.isTypeSupported() is used. Never assume MP4 is available.
 */
export const RECORDER_MIME_CANDIDATES = {
  video: [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
  ],
  audio: ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'],
} as const;

/** Video codecs that can be written into the MP4 container, best compatibility first. */
export const MP4_VIDEO_CODECS = [
  { codec: 'avc', label: 'H.264', limitedCompatibility: false },
  { codec: 'vp9', label: 'VP9', limitedCompatibility: true },
  { codec: 'av1', label: 'AV1', limitedCompatibility: true },
] as const;

export type Mp4VideoCodec = (typeof MP4_VIDEO_CODECS)[number]['codec'];

/** Video codecs for the honest WebM alternative. */
export const WEBM_VIDEO_CODECS = ['vp9', 'vp8', 'av1'] as const;

export const VIDEO_EXPORT = {
  /** Target bits per pixel per frame; ~0.1 gives clean results for motion graphics with H.264/VP9. */
  bitsPerPixel: 0.1,
  minBitrateBps: 1_000_000,
  maxBitrateBps: 16_000_000,
  keyFrameIntervalSeconds: 2,
} as const;

/** Video bitrate for the output, scaled by resolution and frame rate within configured bounds. */
export function videoBitrateFor(width: number, height: number, frameRate: number): number {
  const raw = width * height * frameRate * VIDEO_EXPORT.bitsPerPixel;
  return Math.round(Math.min(VIDEO_EXPORT.maxBitrateBps, Math.max(VIDEO_EXPORT.minBitrateBps, raw)));
}

export const AUDIO_EXPORT = {
  mp3BitrateBps: 192_000,
  aacBitrateBps: 160_000,
  opusBitrateBps: 128_000,
  /** Peak amplitude (0..1) below which an audio track is reported as silent. */
  silenceThreshold: 0.0005,
} as const;

export const OUTPUT_MIME = {
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  webm: 'video/webm',
} as const;

export const PREVIEW = {
  /** Static loader page that hosts untrusted content inside a sandboxed iframe. */
  sandboxPath: '/sandbox.html',
  /** Untrusted content gets scripts only: no same-origin, popups, forms, top navigation or downloads. */
  sandboxFlags: 'allow-scripts',
  /** Autoplay is delegated so animation audio can start without an extra click inside the preview. */
  allowFeatures: 'autoplay',
  /** How long to wait for the sandbox loader to report ready. */
  loaderTimeoutMs: 10_000,
} as const;

/** Encoding watchdog: abort if no progress has been reported for this long. */
export const ENCODER_STALL_TIMEOUT_MS = 120_000;
