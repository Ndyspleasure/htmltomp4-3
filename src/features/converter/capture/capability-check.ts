import { RECORDER_MIME_CANDIDATES } from '../../../config/converter-config';

export interface BrowserCapabilities {
  secureContext: boolean;
  displayCapture: boolean;
  mediaRecorder: boolean;
  recorderVideoMime: string | null;
  recorderAudioMime: string | null;
  /** Region Capture (CropTarget) lets us record only the preview area of this tab. */
  regionCapture: boolean;
  /** Capture Handle lets us verify that the user picked the expected tab. */
  captureHandle: boolean;
  worker: boolean;
  webAssembly: boolean;
  likelyMobile: boolean;
}

/** Returns the first MIME type the recorder supports, never assuming MP4 is available. */
export function pickRecorderMime(
  candidates: readonly string[],
  isTypeSupported: (mime: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // Some browsers throw for malformed/unknown strings; treat as unsupported.
    }
  }
  return null;
}

export function detectCapabilities(win: Window & typeof globalThis = window): BrowserCapabilities {
  const nav = win.navigator;
  const recorder = typeof win.MediaRecorder === 'function' ? win.MediaRecorder : null;
  const isTypeSupported = (mime: string) => (recorder ? recorder.isTypeSupported(mime) : false);
  return {
    secureContext: win.isSecureContext === true,
    displayCapture: typeof nav.mediaDevices?.getDisplayMedia === 'function',
    mediaRecorder: recorder !== null,
    recorderVideoMime: recorder ? pickRecorderMime(RECORDER_MIME_CANDIDATES.video, isTypeSupported) : null,
    recorderAudioMime: recorder ? pickRecorderMime(RECORDER_MIME_CANDIDATES.audio, isTypeSupported) : null,
    regionCapture:
      'CropTarget' in win &&
      typeof (win as unknown as { CropTarget?: { fromElement?: unknown } }).CropTarget?.fromElement === 'function',
    captureHandle:
      typeof (nav.mediaDevices as MediaDevicesWithCaptureHandle | undefined)?.setCaptureHandleConfig === 'function',
    worker: typeof win.Worker === 'function',
    webAssembly: typeof win.WebAssembly === 'object',
    likelyMobile: /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent),
  };
}

export interface MediaDevicesWithCaptureHandle extends MediaDevices {
  setCaptureHandleConfig?: (config: { handle?: string; exposeOrigin?: boolean; permittedOrigins?: string[] }) => void;
}
