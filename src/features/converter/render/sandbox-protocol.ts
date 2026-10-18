import type { PreviewBundle } from '../types';

/**
 * How the sandbox loader should run the user's document:
 * - preview: normal real-time playback;
 * - render: virtual clock, silent, for timing analysis and frame rendering;
 * - audio: real-time playback with Web Audio output recorded inside the sandbox.
 */
export type SandboxMode = 'preview' | 'render' | 'audio';

/** Output size suggested from the shape of the page's main element. */
export type SuggestedLayout = 'portrait' | 'square' | 'landscape' | null;

/** Timing information detected inside the sandbox (CSS/WAAPI, GSAP, anime.js, Lottie, media, explicit). */
export interface DetectedTiming {
  /** Detected total duration in seconds, or null when nothing finite was found. */
  durationSeconds: number | null;
  /** True when at least one animation repeats forever. */
  looping: boolean;
  /** Human-readable list of sources that contributed (e.g. "CSS animation", "GSAP"). */
  sources: string[];
  /** Shape of the dominant visual element (preview mode only). */
  layout?: SuggestedLayout;
}

/** Web Audio recorded in real time; `startSeconds` may be negative if sound started before t=0. */
export interface CapturedAudio {
  data: ArrayBuffer;
  startSeconds: number;
}

/** One audible media playback observed on the virtual timeline (render mode). */
export interface AudioSession {
  data: ArrayBuffer;
  startSeconds: number;
  offsetSeconds: number;
  stopSeconds: number | null;
  volume: number;
  loop: boolean;
  playbackRate: number;
}

export type AppToSandbox =
  | { type: 'h2m:load'; bundle: PreviewBundle; mode: SandboxMode }
  | {
      type: 'h2m:analyze';
      durationSeconds: number | null;
      fallbackSeconds: number;
      fps: number;
      collectAudio: boolean;
      autoStart: boolean;
    }
  | {
      type: 'h2m:render';
      durationSeconds: number;
      fps: number;
      width: number;
      height: number;
      autoStart: boolean;
      /** Capture only the detected stage element (e.g. a 9:16 frame) instead of the whole page. */
      cropToStage: boolean;
    }
  | { type: 'h2m:record-audio'; durationSeconds: number; autoStart: boolean }
  | { type: 'h2m:render-ack'; index: number }
  | { type: 'h2m:render-cancel' };

export type SandboxToApp =
  | { type: 'h2m:sandbox-ready' }
  | { type: 'h2m:sandbox-loaded'; warnings: string[] }
  | { type: 'h2m:sandbox-timing'; timing: DetectedTiming }
  | { type: 'h2m:sandbox-error'; message: string }
  | { type: 'h2m:sandbox-runtime-error'; message: string }
  | {
      type: 'h2m:analyze-result';
      durationSeconds: number;
      timing: DetectedTiming;
      audio: AudioSession[];
      webAudioUsed: boolean;
      speechUsed: boolean;
      clickedStart: string | null;
      warnings: string[];
    }
  | { type: 'h2m:audio-result'; captures: CapturedAudio[] }
  | { type: 'h2m:render-frame'; index: number; bitmap: ImageBitmap }
  | { type: 'h2m:render-done'; frames: number }
  | { type: 'h2m:render-error'; message: string };
