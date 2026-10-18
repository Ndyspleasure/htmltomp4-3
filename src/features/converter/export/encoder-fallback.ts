/**
 * isConfigSupported() only checks a configuration on paper: platform encoders (notably hardware H.264
 * on Windows/macOS, or Firefox's) can accept a config and then fail on the first real frame with
 * "EncodingError". Before rendering — when frames can no longer be replayed — the frame encoder runs
 * a few real frames through each candidate and keeps the first one that actually produces output.
 */
import { MP4_VIDEO_CODECS, VIDEO_EXPORT, WEBM_VIDEO_CODECS, videoBitrateFor } from '../../../config/converter-config';
import type { OutputFormat } from '../types';
import type { loadMediabunny } from './convert-media';

type Mediabunny = Awaited<ReturnType<typeof loadMediabunny>>;
type VideoCodec = Parameters<Mediabunny['canEncodeVideo']>[0];

export type HardwareAcceleration = 'no-preference' | 'prefer-software';

export interface VideoEncoderCandidate {
  codec: VideoCodec;
  hardwareAcceleration: HardwareAcceleration;
}

/** Frames encoded by the trial; a couple is enough for platform encoders to fail if they are going to. */
const TRIAL_FRAMES = 3;

/**
 * Candidates in order of preference: the requested codec first (default acceleration, then software),
 * then the remaining codecs of the container. For MP4 the requested codec comes first even when it is
 * not H.264, so a user's explicit choice is honoured before falling back.
 */
export function videoEncoderCandidates(
  format: Exclude<OutputFormat, 'mp3'>,
  preferred: VideoCodec | null,
): VideoEncoderCandidate[] {
  const container: readonly VideoCodec[] =
    format === 'mp4' ? MP4_VIDEO_CODECS.map((entry) => entry.codec) : WEBM_VIDEO_CODECS;
  const codecs =
    preferred && container.includes(preferred)
      ? [preferred, ...container.filter((codec) => codec !== preferred)]
      : [...container];
  return codecs.flatMap((codec) => [
    { codec, hardwareAcceleration: 'no-preference' as const },
    { codec, hardwareAcceleration: 'prefer-software' as const },
  ]);
}

/** Encodes a few blank frames with the given settings. Returns the error when the encoder fails, else null. */
export async function trialEncodeVideo(
  mb: Mediabunny,
  format: Exclude<OutputFormat, 'mp3'>,
  candidate: VideoEncoderCandidate,
  width: number,
  height: number,
  fps: number,
): Promise<unknown> {
  if (typeof OffscreenCanvas !== 'function') return null;
  const output = new mb.Output({
    format: format === 'mp4' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  try {
    const source = new mb.VideoSampleSource({
      codec: candidate.codec,
      quality: new mb.Quality({ bitrate: videoBitrateFor(width, height, fps) }),
      keyFrameInterval: VIDEO_EXPORT.keyFrameIntervalSeconds,
      hardwareAcceleration: candidate.hardwareAcceleration,
    });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    for (let index = 0; index < TRIAL_FRAMES; index++) {
      if (context) {
        context.fillStyle = index % 2 === 0 ? '#000' : '#fff';
        context.fillRect(0, 0, width, height);
      }
      const sample = new mb.VideoSample(canvas, { timestamp: index / fps, duration: 1 / fps });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    source.close();
    await output.finalize();
    const buffer = output.target.buffer;
    return buffer && buffer.byteLength > 0 ? null : new Error('Encoder tidak menghasilkan data.');
  } catch (error) {
    await output.cancel().catch(() => undefined);
    return error ?? new Error('Encoder gagal.');
  }
}

/** Encodes a short block of silence; returns the error when the audio encoder fails, else null. */
export async function trialEncodeAudio(
  mb: Mediabunny,
  format: OutputFormat,
  codec: 'aac' | 'mp3' | 'opus',
  bitrate: number,
  sampleRate: number,
): Promise<unknown> {
  const output = new mb.Output({
    format:
      format === 'mp3'
        ? new mb.Mp3OutputFormat()
        : format === 'mp4'
          ? new mb.Mp4OutputFormat()
          : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  try {
    const source = new mb.AudioSampleSource({ codec, quality: new mb.Quality({ bitrate, bitrateMode: 'constant' }) });
    output.addAudioTrack(source);
    await output.start();
    const frames = Math.round(sampleRate / 10);
    const sample = new mb.AudioSample({
      data: new Float32Array(frames * 2),
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate,
      timestamp: 0,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
    source.close();
    await output.finalize();
    return null;
  } catch (error) {
    await output.cancel().catch(() => undefined);
    return error ?? new Error('Encoder audio gagal.');
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error)
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}
