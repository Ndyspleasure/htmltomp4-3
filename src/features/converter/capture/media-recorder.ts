import { RECORDING_LIMITS } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { RecordingResult } from '../types';

export interface RecorderOptions {
  mimeType: string;
  /** Record only the audio tracks of the stream (MP3 export). */
  audioOnly: boolean;
  includeAudio: boolean;
  maxDurationMs: number;
  onTick?: (elapsedMs: number) => void;
  /** Called when recording stopped on its own (time limit reached or sharing stopped). */
  onAutoStop?: (reason: 'limit' | 'ended') => void;
}

export interface RecordingSession {
  readonly done: Promise<RecordingResult>;
  stop(): void;
  cancel(): void;
  elapsedMs(): number;
}

type MediaRecorderCtor = new (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder;

/** Records a capture stream in chunks. Track/stream lifetime stays with the caller. */
export function startRecording(
  stream: MediaStream,
  options: RecorderOptions,
  Recorder: MediaRecorderCtor = MediaRecorder,
): RecordingSession {
  const videoTracks = stream.getVideoTracks();
  const audioTracks = options.includeAudio || options.audioOnly ? stream.getAudioTracks() : [];
  if (options.audioOnly && audioTracks.length === 0) {
    throw new ConverterError('no-audio-track', 'Tidak ada track audio untuk direkam. MP3 membutuhkan audio tab.');
  }
  if (!options.audioOnly && videoTracks.length === 0) {
    throw new ConverterError('no-video-track', 'Tidak ada track video untuk direkam.');
  }
  const recordStream = new MediaStream(options.audioOnly ? audioTracks : [...videoTracks, ...audioTracks]);

  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(recordStream, {
      mimeType: options.mimeType,
      videoBitsPerSecond: RECORDING_LIMITS.recorderVideoBitsPerSecond,
      audioBitsPerSecond: RECORDING_LIMITS.recorderAudioBitsPerSecond,
    });
  } catch (error) {
    throw new ConverterError('recorder-unsupported', `Perekam tidak mendukung format ${options.mimeType}.`, {
      cause: error,
    });
  }

  const chunks: Blob[] = [];
  let startedAt = 0;
  let stoppedAt = 0;
  let cancelled = false;
  let tickTimer = 0;
  let limitTimer = 0;
  const elapsedMs = () => (startedAt === 0 ? 0 : (stoppedAt || performance.now()) - startedAt);

  const stop = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const onTrackEnded = () => {
    if (recorder.state !== 'inactive') {
      options.onAutoStop?.('ended');
      stop();
    }
  };
  const watched = options.audioOnly ? [...audioTracks, ...videoTracks] : videoTracks;
  watched.forEach((track) => track.addEventListener('ended', onTrackEnded));

  const cleanup = () => {
    window.clearInterval(tickTimer);
    window.clearTimeout(limitTimer);
    watched.forEach((track) => track.removeEventListener('ended', onTrackEnded));
  };

  const done = new Promise<RecordingResult>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', (event) => {
      cleanup();
      const cause = (event as Event & { error?: unknown }).error;
      reject(new ConverterError('recording-failed', 'Perekaman gagal di tengah jalan.', { cause }));
    });
    recorder.addEventListener('stop', () => {
      stoppedAt = performance.now();
      cleanup();
      if (cancelled) {
        chunks.length = 0;
        reject(new ConverterError('cancelled', 'Perekaman dibatalkan.'));
        return;
      }
      const mimeType = recorder.mimeType || options.mimeType;
      const blob = new Blob(chunks, { type: mimeType });
      chunks.length = 0;
      if (blob.size === 0) {
        reject(new ConverterError('recording-empty', 'Rekaman kosong. Pastikan tab preview terlihat saat merekam.'));
        return;
      }
      const settings = videoTracks[0]?.getSettings();
      resolve({
        blob,
        mimeType,
        durationSeconds: elapsedMs() / 1000,
        hasAudio: audioTracks.length > 0,
        hasVideo: !options.audioOnly && videoTracks.length > 0,
        ...(settings?.width !== undefined ? { captureWidth: settings.width } : {}),
        ...(settings?.height !== undefined ? { captureHeight: settings.height } : {}),
      });
    });
  });

  try {
    recorder.start(RECORDING_LIMITS.timesliceMs);
  } catch (error) {
    cleanup();
    throw new ConverterError('recording-failed', 'MediaRecorder gagal dimulai.', { cause: error });
  }
  startedAt = performance.now();
  tickTimer = window.setInterval(() => options.onTick?.(elapsedMs()), 250);
  limitTimer = window.setTimeout(() => {
    if (recorder.state !== 'inactive') {
      options.onAutoStop?.('limit');
      stop();
    }
  }, options.maxDurationMs);

  return {
    done,
    stop,
    cancel() {
      cancelled = true;
      stop();
    },
    elapsedMs,
  };
}
