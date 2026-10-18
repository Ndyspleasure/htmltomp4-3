import { MP4_VIDEO_CODECS, type Mp4VideoCodec } from '../../../config/converter-config';
import type { OutputFormat } from '../types';
import type { EncoderSupport } from './convert-media';

export interface FormatAvailability {
  available: boolean;
  reason?: string;
}

/** Picks the most compatible MP4 video codec the browser can encode, or null if none. */
export function bestMp4Codec(support: EncoderSupport): Mp4VideoCodec | null {
  return MP4_VIDEO_CODECS.find(({ codec }) => support.mp4Video[codec])?.codec ?? null;
}

/** Explains honestly which outputs this browser can produce before the user records anything. */
export function formatAvailability(
  format: OutputFormat,
  support: EncoderSupport,
  recorder: { video: string | null; audio: string | null },
  displayCapture: boolean,
): FormatAvailability {
  if (!displayCapture) return { available: false, reason: 'Browser tidak mendukung perekaman tab/jendela.' };
  if (format === 'mp3') {
    if (!recorder.audio) return { available: false, reason: 'MediaRecorder tidak dapat merekam audio di browser ini.' };
    if (!support.mp3)
      return { available: false, reason: 'Encoder MP3 tidak dapat dimuat (WebAssembly tidak tersedia).' };
    return { available: true };
  }
  if (!recorder.video) return { available: false, reason: 'MediaRecorder tidak dapat merekam video di browser ini.' };
  if (format === 'webm') {
    return support.webmVideo ? { available: true } : { available: false, reason: 'Tidak ada encoder VP8/VP9/AV1.' };
  }
  const codec = bestMp4Codec(support);
  if (codec) return { available: true };
  if (recorder.video.startsWith('video/mp4') && recorder.video.includes('avc1')) {
    return { available: true, reason: 'Encoder H.264 tidak tersedia; MP4 dibuat dengan remux tanpa ubah resolusi.' };
  }
  return { available: false, reason: 'Browser tidak memiliki encoder video untuk MP4 (H.264/VP9/AV1).' };
}

/** Availability for "Konversi langsung": only encoders matter (no capture APIs involved). */
export function directFormatAvailability(
  format: OutputFormat,
  support: EncoderSupport,
  canRender: boolean,
): FormatAvailability {
  if (!canRender)
    return {
      available: false,
      reason: 'Browser tidak mendukung render langsung (createImageBitmap/OfflineAudioContext).',
    };
  if (format === 'mp3') {
    return support.mp3
      ? { available: true }
      : { available: false, reason: 'Encoder MP3 tidak dapat dimuat (WebAssembly tidak tersedia).' };
  }
  if (format === 'webm') {
    return support.webmVideo ? { available: true } : { available: false, reason: 'Tidak ada encoder VP8/VP9/AV1.' };
  }
  return bestMp4Codec(support)
    ? { available: true }
    : {
        available: false,
        reason: 'Browser tidak memiliki encoder video untuk MP4 (H.264/VP9/AV1). Coba metode rekam layar.',
      };
}
