import type { FrameRate, Mp4VideoCodec, ResolutionPresetId } from '../../config/converter-config';

export type OutputFormat = 'mp4' | 'mp3' | 'webm';

export type ConversionStatus =
  | 'idle'
  | 'validating'
  | 'preparing-preview'
  | 'ready-to-record'
  | 'requesting-permission'
  | 'recording'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'error';

export type CaptureMode = 'this-tab' | 'preview-window';

/** direct = render frames in a hidden sandbox (no permission); capture = record a tab/window. */
export type ConversionMethod = 'direct' | 'capture';

export interface ConverterSettings {
  method: ConversionMethod;
  /** Follow the animation's own duration (detected) instead of `durationSeconds`. */
  autoDuration: boolean;
  /** Click a "Play/Putar" button at the start. */
  autoStart: boolean;
  /** Direct method: capture only the detected stage element (no page background or player controls). */
  cropToStage: boolean;
  outputFormat: OutputFormat;
  resolutionId: ResolutionPresetId;
  width: number;
  height: number;
  frameRate: FrameRate;
  durationSeconds: number;
  includeAudio: boolean;
  restartOnRecord: boolean;
  mp4VideoCodec: Mp4VideoCodec;
  captureMode: CaptureMode;
}

/** A file that was read from the user's upload, keyed by its normalized archive path. */
export interface SourceFile {
  path: string;
  data: Uint8Array;
}

export interface ImportedSource {
  kind: 'html' | 'zip';
  name: string;
  sizeBytes: number;
  files: SourceFile[];
  /** Candidate entry points (HTML files). The first one is the default. */
  htmlEntries: string[];
  totalExtractedBytes: number;
}

/** One asset delivered to the sandbox loader. Text assets may contain asset tokens to resolve. */
export interface PreviewAsset {
  id: number;
  path: string;
  mime: string;
  /** Raw bytes for binary assets, or UTF-8 text with tokens for rewritten text assets. */
  data: ArrayBuffer | string;
  /** Asset ids this text asset references; they must be resolved before this one. */
  deps: number[];
  /** HTML documents are rewritten inside the sandbox (never parsed in the application origin). */
  rewriteInSandbox?: 'html';
}

export interface PreviewBundle {
  entryPath: string;
  /** Raw entry HTML. It is parsed and rewritten only inside the sandbox origin. */
  html: string;
  assets: PreviewAsset[];
  warnings: string[];
  /** Map of normalized path -> asset id, used by the runtime shim for fetch/XHR/src lookups. */
  pathIndex: Record<string, number>;
  /** Directory of the entry document inside the archive ('' for root). */
  baseDir: string;
}

export interface ConversionResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioSilent?: boolean;
  limitedCompatibility: boolean;
  notes: string[];
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  captureWidth?: number;
  captureHeight?: number;
}
