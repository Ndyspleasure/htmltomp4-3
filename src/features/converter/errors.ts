/**
 * Typed errors with user-facing Indonesian messages. Modules throw ConverterError so the UI can
 * show a specific message instead of a generic failure, and never swallow the original cause.
 */

export type ConverterErrorCode =
  | 'unsupported-file-type'
  | 'file-empty'
  | 'file-too-large'
  | 'html-invalid'
  | 'zip-invalid'
  | 'zip-too-many-entries'
  | 'zip-too-large'
  | 'zip-unsafe-path'
  | 'zip-bomb'
  | 'zip-no-html'
  | 'preview-failed'
  | 'insecure-context'
  | 'capture-unsupported'
  | 'recorder-unsupported'
  | 'permission-denied'
  | 'capture-aborted'
  | 'cancelled'
  | 'wrong-surface'
  | 'no-video-track'
  | 'no-audio-track'
  | 'recording-failed'
  | 'recording-empty'
  | 'popup-blocked'
  | 'codec-unavailable'
  | 'encoding-failed'
  | 'encoding-cancelled'
  | 'encoding-stalled'
  | 'out-of-memory'
  | 'output-invalid'
  | 'worker-failed';

export class ConverterError extends Error {
  readonly code: ConverterErrorCode;

  constructor(code: ConverterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConverterError';
    this.code = code;
  }
}

export function isConverterError(value: unknown): value is ConverterError {
  return value instanceof ConverterError;
}

/** Converts any thrown value into a message that is safe and useful to show to the user. */
export function toUserMessage(error: unknown): string {
  if (isConverterError(error)) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Izin ditolak oleh browser atau pengguna.';
    if (error.name === 'QuotaExceededError') return 'Memori/penyimpanan browser tidak mencukupi.';
    return `Browser melaporkan error ${error.name}: ${error.message}`;
  }
  if (
    error instanceof RangeError ||
    (error instanceof Error && /out of memory|allocation failed/i.test(error.message))
  ) {
    return 'Memori perangkat tidak mencukupi. Coba durasi lebih pendek atau resolusi lebih kecil.';
  }
  if (error instanceof Error && error.message) return `Terjadi kesalahan: ${error.message}`;
  return 'Terjadi kesalahan yang tidak diketahui.';
}
