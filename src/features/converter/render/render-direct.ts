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
  /** Capture only the animation's stage element instead of the whole page. */
  cropToStage: boolean;
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

    const mediaSessions: AudioSession[] = [...analysis.audio];
    const needsLiveAudio = wantAudio && analysis.webAudioUsed;
    // Web Audio can only be captured in real time: play the document once more and record its output.
    const recordLiveAudio = async (): Promise<AudioSession[]> => {
      const audioFrame = await openRenderFrame(bundle, width, height, 'audio');
      frames.push(audioFrame);
      const captures = await audioFrame.recordAudio({ durationSeconds, autoStart: options.autoStart });
      audioFrame.destroy();
      return captures.map((capture) => ({
        data: capture.data,
        startSeconds: Math.max(0, capture.startSeconds),
        offsetSeconds: Math.max(0, -capture.startSeconds),
        stopSeconds: null,
        volume: 1,
        loop: false,
        playbackRate: 1,
      }));
    };
    const buildAudio = async () => {
      const live = needsLiveAudio ? await recordLiveAudio() : [];
      return mixAudioSessions([...mediaSessions, ...live], durationSeconds, warnings);
    };
    const encoderConfig = { format, width, height, fps, mp4VideoCodec: options.mp4VideoCodec, durationSeconds };
    const onEncoderProgress = (stage: EncodeStage, fraction: number | null) => options.onProgress(stage, fraction);

    let session: ReturnType<EncoderClient['beginFrames']>;
    if (format === 'mp3') {
      if (needsLiveAudio) options.onProgress('recording-audio', null, `${durationSeconds} detik`);
      const audio = await buildAudio();
      checkAborted();
      if (!audio) {
        throw new ConverterError(
          'no-audio-track',
          'Animasi tidak memutar audio yang dapat direkam (elemen <audio>/<video> atau Web Audio), sehingga MP3 tidak dapat dibuat.',
        );
      }
      session = options.encoder.beginFrames({ ...encoderConfig, audio }, onEncoderProgress, signal);
      await session.ready;
    } else {
      const expectAudio = wantAudio && (mediaSessions.length > 0 || needsLiveAudio);
      if (wantAudio && !expectAudio) warnings.push('Animasi tidak memutar audio; hasil hanya berisi video.');
      session = options.encoder.beginFrames(
        { ...encoderConfig, audio: expectAudio ? 'deferred' : null },
        onEncoderProgress,
        signal,
      );
      await session.ready;
      // Record live audio while frames render, so both take about the animation's duration in total.
      const audioPromise = expectAudio ? buildAudio() : Promise.resolve(null);
      audioPromise.catch(() => undefined);

      const total = Math.max(1, Math.round(durationSeconds * fps));
      const renderFrame = await openRenderFrame(bundle, width, height);
      frames.push(renderFrame);
      const parallelNote = needsLiveAudio ? ' · audio direkam paralel' : '';
      options.onProgress('rendering', 0, `0/${total}${parallelNote}`);
      await renderFrame.render(
        { durationSeconds, fps, width, height, autoStart: options.autoStart, cropToStage: options.cropToStage },
        async (bitmap, index) => {
          checkAborted();
          await session.addFrame(bitmap, index);
          options.onProgress('rendering', (index + 1) / total, `${index + 1}/${total}${parallelNote}`);
        },
      );
      renderFrame.destroy();

      if (expectAudio) {
        if (needsLiveAudio) options.onProgress('recording-audio', null, 'menunggu rekaman audio selesai');
        const audio = await audioPromise;
        checkAborted();
        if (!audio) warnings.push('Audio tidak dapat direkam; hasil berisi trek audio hening.');
        session.setAudio(audio);
      }
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
