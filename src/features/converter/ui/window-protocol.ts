import type { PreviewBundle } from '../types';

/** Messages between the converter tab (opener) and the /preview window. Both are same-origin, trusted pages. */
export type OpenerToPreview =
  | { type: 'h2m:preview-init'; bundle: PreviewBundle; width: number; height: number; handle: string; title: string }
  | { type: 'h2m:preview-restart' }
  | { type: 'h2m:preview-resize'; width: number; height: number };

export type PreviewToOpener =
  | { type: 'h2m:preview-hello' }
  | { type: 'h2m:preview-ready'; cropTarget?: unknown }
  | { type: 'h2m:preview-restarted' }
  | { type: 'h2m:preview-error'; message: string };

export const PREVIEW_WINDOW_NAME = 'h2m-preview-window';
