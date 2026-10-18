/**
 * "Konversi langsung": converts an uploaded animation to MP4/WebM/MP3 without screen capture. The
 * document runs in a hidden sandbox on a virtual clock; pass 1 analyses timing and collects audio
 * playback, pass 2 rasterizes one frame per tick and streams the frames to the encoder worker.
 */
import { RECORDING_LIMITS, type Mp4VideoCodec } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { ConvertResult, EncodeStage, EncoderClient } from '../export/encoder-client';
import type { OutputFormat, PreviewBundle } from '../types';
import { mixAudioSessions } from './audio-mix';
import { openRenderFrame, type RenderFrameHandle } from './render-frame';
import type { AudioSession, DetectedTiming } from './sandbox-protocol';

export interface DirectRenderOptions {
  bundle: PreviewBundle;
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  /** null = follow the animation's detected duration. */
  durationSeconds: number | null;
  /** Used when the duration is automatic but nothing finite could be detected. */
  fallbackSeconds: number;
  includeAudio: boolean;
  /** Click a "Play/Putar" button at t=0 when the page waits for one. */
  autoStart: boolean;
  mp4VideoCodec: Mp4VideoCodec;
  encoder: EncoderClient;
  onProgress: (stage: EncodeStage, fraction: number | null, detail?: string) => void;
  signal: AbortSignal;
}

export interface DirectRenderResult {
  result: ConvertResult;
  durationSeconds: number;
  timing: DetectedTiming;
  warnings: string[];
}

export async function renderDirect(options: DirectRenderOptions): Promise<DirectRenderResult> {
  const { bundle, format, width, height, fps, signal } = options;
  const warnings: string[] = [];
  const frames: RenderFrameHandle[] = [];
  const abort = () => frames.forEach((frame) => frame.cancel());
  signal.addEventListener('abort', abort, { once: true });
  const checkAborted = () => {
    if (signal.aborted) throw new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.');
  };

  try {
    options.onProgress('analyzing', null);
    const analysisFrame = await openRenderFrame(bundle, width, height);
    frames.push(analysisFrame);
    const wantAudio = format === 'mp3' || options.includeAudio;
    const analysis = await analysisFrame.analyze({
      durationSeconds: options.durationSeconds,
      fallbackSeconds: options.fallbackSeconds,
      fps,
      collectAudio: wantAudio,
      autoStart: options.autoStart,
    });
    analysisFrame.destroy();
    checkAborted();
    warnings.push(...analysis.warnings);
    const durationSeconds = clampDuration(analysis.durationSeconds);
    if (options.durationSeconds === null && analysis.timing.durationSeconds === null) {
      warnings.push(
        analysis.timing.looping
          ? `Animasi berulang tanpa akhir; dipakai durasi ${durationSeconds} detik.`
          : `Durasi animasi tidak terdeteksi; dipakai durasi ${durationSeconds} detik.`,
      );
    }

    if (analysis.clickedStart) warnings.push(`Tombol "${analysis.clickedStart}" diklik otomatis di awal.`);

    const sessions: AudioSession[] = [...analysis.audio];
    if (wantAudio && analysis.webAudioUsed) {
      // Web Audio can only be captured in real time: play the document once more and record its output.
      options.onProgress('recording-audio', null, `${durationSeconds} detik`);
      const audioFrame = await openRenderFrame(bundle, width, height, 'audio');
      frames.push(audioFrame);
      const captures = await audioFrame.recordAudio({ durationSeconds, autoStart: options.autoStart });
      audioFrame.destroy();
      checkAborted();
      for (const capture of captures) {
        sessions.push({
          data: capture.data,
          startSeconds: Math.max(0, capture.startSeconds),
          offsetSeconds: Math.max(0, -capture.startSeconds),
          stopSeconds: null,
          volume: 1,
          loop: false,
          playbackRate: 1,
        });
      }
    }
    const audio = wantAudio ? await mixAudioSessions(sessions, durationSeconds, warnings) : null;
    if (format === 'mp3' && !audio) {
      throw new ConverterError(
        'no-audio-track',
        'Animasi tidak memutar audio yang dapat direkam (elemen <audio>/<video> atau Web Audio), sehingga MP3 tidak dapat dibuat.',
      );
    }
    if (wantAudio && format !== 'mp3' && !audio)
      warnings.push('Animasi tidak memutar audio; hasil hanya berisi video.');
    checkAborted();

    const session = options.encoder.beginFrames(
      { format, width, height, fps, mp4VideoCodec: options.mp4VideoCodec, audio, durationSeconds },
      (stage, fraction) => options.onProgress(stage, fraction),
      signal,
    );
    await session.ready;

    if (format !== 'mp3') {
      const total = Math.max(1, Math.round(durationSeconds * fps));
      const renderFrame = await openRenderFrame(bundle, width, height);
      frames.push(renderFrame);
      options.onProgress('rendering', 0, `0/${total}`);
      await renderFrame.render(
        { durationSeconds, fps, width, height, autoStart: options.autoStart },
        async (bitmap, index) => {
          checkAborted();
          await session.addFrame(bitmap, index);
          options.onProgress('rendering', (index + 1) / total, `${index + 1}/${total}`);
        },
      );
      renderFrame.destroy();
    }
    checkAborted();
    const result = await session.finish();
    return { result, durationSeconds, timing: analysis.timing, warnings };
  } catch (error) {
    if (signal.aborted) throw new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.', { cause: error });
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    frames.forEach((frame) => frame.destroy());
  }
}

function clampDuration(seconds: number): number {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : RECORDING_LIMITS.defaultDurationSeconds;
  return Math.min(
    RECORDING_LIMITS.maxDurationSeconds,
    Math.max(RECORDING_LIMITS.minDurationSeconds, Math.round(value * 10) / 10),
  );
}
