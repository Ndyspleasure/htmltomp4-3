import { ConverterError } from '../errors';
import type { CaptureMode } from '../types';
import type { MediaDevicesWithCaptureHandle } from './capability-check';

export interface CaptureRequest {
  mode: CaptureMode;
  frameRate: number;
  wantAudio: boolean;
  /** Capture handle expected on the surface the user should pick. */
  expectedHandle?: string;
}

export interface CaptureOutcome {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
  /** True when the captured surface was verified via Capture Handle. */
  verifiedSurface: boolean;
  warnings: string[];
}

interface CaptureHandleTrack extends MediaStreamTrack {
  getCaptureHandle?: () => { handle?: string; origin?: string } | null;
  cropTo?: (target: unknown) => Promise<void>;
}

/** Marks the current document so a capture of it can be recognised via Capture Handle (Chromium only). */
export function setCaptureHandle(handle: string): void {
  const devices = navigator.mediaDevices as MediaDevicesWithCaptureHandle | undefined;
  try {
    devices?.setCaptureHandleConfig?.({ handle, exposeOrigin: true, permittedOrigins: [location.origin] });
  } catch {
    // Unsupported or already configured; verification simply becomes unavailable.
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Asks the user to share a tab/window. Must be called directly from a user gesture (button click).
 * Verifies the stream has the tracks the requested output needs before returning it.
 */
export async function requestDisplayCapture(request: CaptureRequest): Promise<CaptureOutcome> {
  if (!window.isSecureContext) {
    throw new ConverterError('insecure-context', 'Perekaman membutuhkan HTTPS (atau localhost).');
  }
  const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
  if (!getDisplayMedia) {
    throw new ConverterError(
      'capture-unsupported',
      'Browser ini tidak mendukung perekaman tab/jendela (Screen Capture API). Gunakan Chrome, Edge, atau Firefox versi desktop terbaru.',
    );
  }

  const thisTab = request.mode === 'this-tab';
  const options = {
    video: { frameRate: { ideal: request.frameRate, max: request.frameRate } },
    audio: request.wantAudio ? { suppressLocalAudioPlayback: false } : false,
    preferCurrentTab: thisTab,
    selfBrowserSurface: thisTab ? 'include' : 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
    monitorTypeSurfaces: 'exclude',
  } as DisplayMediaStreamOptions;

  let stream: MediaStream;
  try {
    stream = await getDisplayMedia(options);
  } catch (error) {
    throw mapCaptureError(error);
  }

  const warnings: string[] = [];
  try {
    const videoTrack = stream.getVideoTracks()[0] as CaptureHandleTrack | undefined;
    if (!videoTrack) throw new ConverterError('no-video-track', 'Hasil tangkapan tidak memiliki track video.');
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    let verifiedSurface = false;
    const surface = (videoTrack.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
    if (thisTab && surface && surface !== 'browser') {
      throw new ConverterError(
        'wrong-surface',
        'Untuk mode "Tab ini", pilih tab converter ini, bukan jendela atau layar.',
      );
    }
    // Capture Handle is only exposed for tab captures; windows/screens cannot be verified. A handle that
    // differs from the expected one proves the wrong tab was picked (e.g. the converter instead of the
    // preview window). A missing handle is inconclusive (other sites, or browsers that do not expose it),
    // so it only produces a warning instead of blocking the user.
    const handle =
      surface === 'browser' && typeof videoTrack.getCaptureHandle === 'function'
        ? videoTrack.getCaptureHandle()?.handle
        : undefined;
    if (request.expectedHandle && handle && handle !== request.expectedHandle) {
      throw new ConverterError(
        'wrong-surface',
        thisTab
          ? 'Tab yang dipilih bukan tab converter ini. Ulangi dan pilih "Tab ini".'
          : 'Tab yang dipilih adalah tab converter, bukan jendela preview. Ulangi dan pilih tab "Preview Rekaman".',
      );
    }
    if (request.expectedHandle && handle === request.expectedHandle) {
      verifiedSurface = true;
    } else {
      warnings.push('Tab yang dipilih tidak dapat diverifikasi; pastikan yang terekam adalah preview animasi.');
    }

    if (request.wantAudio && !audioTrack) {
      warnings.push(
        'Tidak ada track audio. Pastikan opsi "Bagikan audio tab" dicentang; audio tab hanya didukung di sebagian browser.',
      );
    }
    return { stream, videoTrack, audioTrack, verifiedSurface, warnings };
  } catch (error) {
    stopStream(stream);
    throw error;
  }
}

/** Restricts the captured frames of the current tab to the given element (Region Capture). */
export async function cropToElement(track: MediaStreamTrack, element: Element): Promise<boolean> {
  const cropTarget = (window as unknown as { CropTarget?: { fromElement(el: Element): Promise<unknown> } }).CropTarget;
  if (!cropTarget) return false;
  return cropToTarget(track, await cropTarget.fromElement(element));
}

/** Applies a CropTarget (possibly created in the captured tab and posted to us). */
export async function cropToTarget(track: MediaStreamTrack, target: unknown): Promise<boolean> {
  const croppable = track as CaptureHandleTrack;
  if (!target || typeof croppable.cropTo !== 'function') return false;
  await croppable.cropTo(target);
  return true;
}

export function mapCaptureError(error: unknown): ConverterError {
  if (error instanceof ConverterError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      return new ConverterError(
        'permission-denied',
        'Izin merekam ditolak atau dialog dibatalkan. Klik "Mulai Rekam" lagi dan pilih tab yang benar.',
        { cause: error },
      );
    case 'AbortError':
      return new ConverterError('capture-aborted', 'Perekaman dibatalkan oleh browser.', { cause: error });
    case 'NotFoundError':
      return new ConverterError('capture-unsupported', 'Tidak ada sumber tab/jendela yang bisa direkam.', {
        cause: error,
      });
    case 'NotReadableError':
      return new ConverterError('capture-aborted', 'Sistem operasi menolak akses perekaman layar.', { cause: error });
    case 'InvalidStateError':
      return new ConverterError('capture-aborted', 'Perekaman harus dimulai langsung dari klik tombol.', {
        cause: error,
      });
    case 'TypeError':
      return new ConverterError('capture-unsupported', 'Opsi perekaman tidak didukung browser ini.', { cause: error });
    default:
      return new ConverterError('capture-aborted', 'Gagal memulai perekaman tab/jendela.', { cause: error });
  }
}
