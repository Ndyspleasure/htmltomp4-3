/**
 * Media conversion core built on Mediabunny (WebCodecs + WASM AAC/MP3 encoders). Runs inside the
 * encoder Web Worker; it only falls back to the main thread when module workers are unavailable.
 */
import {
  AUDIO_EXPORT,
  MP4_VIDEO_CODECS,
  OUTPUT_MIME,
  VIDEO_EXPORT,
  WEBM_VIDEO_CODECS,
  videoBitrateFor,
  type Mp4VideoCodec,
} from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { OutputFormat } from '../types';
import { assertOutputMatches, hasValidSignature, inspectOutput, type OutputInspection } from './output-validation';

export type EncodeStage =
  'loading-encoder' | 'reading-input' | 'analyzing' | 'recording-audio' | 'rendering' | 'encoding' | 'validating';

export interface EncoderSupport {
  webCodecs: boolean;
  mp4Video: Record<Mp4VideoCodec, boolean>;
  webmVideo: string | null;
  aac: 'native' | 'wasm' | null;
  mp3: 'native' | 'wasm' | null;
  opus: boolean;
}

export interface ConvertRequest {
  blob: Blob;
  format: OutputFormat;
  width: number;
  height: number;
  frameRate: number;
  includeAudio: boolean;
  mp4VideoCodec: Mp4VideoCodec;
}

export interface ConvertResult {
  buffer: ArrayBuffer;
  mimeType: string;
  inspection: OutputInspection;
  audioSilent: boolean | null;
  limitedCompatibility: boolean;
  notes: string[];
}

export type ProgressCallback = (stage: EncodeStage, fraction: number | null) => void;

type Mediabunny = typeof import('mediabunny');

let mediabunnyPromise: Promise<Mediabunny> | null = null;
export function loadMediabunny(): Promise<Mediabunny> {
  mediabunnyPromise ??= import('mediabunny');
  return mediabunnyPromise;
}

/** Registers WASM encoders only when the browser has no native one. Returns how the codec is provided. */
export async function ensureAudioEncoder(mb: Mediabunny, codec: 'aac' | 'mp3'): Promise<'native' | 'wasm' | null> {
  if (await mb.canEncodeAudio(codec)) return 'native';
  if (typeof WebAssembly !== 'object') return null;
  if (codec === 'mp3') {
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    registerMp3Encoder();
  } else {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  }
  return (await mb.canEncodeAudio(codec)) ? 'wasm' : null;
}

export async function probeEncoders(width: number, height: number): Promise<EncoderSupport> {
  const mb = await loadMediabunny();
  const mp4Video = {} as Record<Mp4VideoCodec, boolean>;
  for (const { codec } of MP4_VIDEO_CODECS) {
    mp4Video[codec] = await mb.canEncodeVideo(codec, { width, height }).catch(() => false);
  }
  const wasm = typeof WebAssembly === 'object';
  const webmVideo = await mb.getFirstEncodableVideoCodec([...WEBM_VIDEO_CODECS], { width, height }).catch(() => null);
  return {
    webCodecs: typeof VideoEncoder === 'function',
    mp4Video,
    webmVideo,
    // WASM encoders are only downloaded when an export actually needs them (lazy-loading).
    aac: (await mb.canEncodeAudio('aac').catch(() => false)) ? 'native' : wasm ? 'wasm' : null,
    mp3: (await mb.canEncodeAudio('mp3').catch(() => false)) ? 'native' : wasm ? 'wasm' : null,
    opus: await mb.canEncodeAudio('opus').catch(() => false),
  };
}

export async function convertRecording(
  request: ConvertRequest,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<ConvertResult> {
  const notes: string[] = [];
  onProgress('loading-encoder', null);
  const mb = await loadMediabunny();
  throwIfAborted(signal);

  onProgress('reading-input', null);
  const input = new mb.Input({ source: new mb.BlobSource(request.blob), formats: mb.ALL_FORMATS });
  try {
    const videoTrack = request.format === 'mp3' ? null : await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (request.format !== 'mp3' && !videoTrack) {
      throw new ConverterError('no-video-track', 'Rekaman tidak memiliki track video.');
    }
    if (request.format === 'mp3' && !audioTrack) {
      throw new ConverterError(
        'no-audio-track',
        'Rekaman tidak memiliki track audio, sehingga MP3 tidak dapat dibuat.',
      );
    }
    if (videoTrack && !(await videoTrack.canDecode())) {
      throw new ConverterError(
        'codec-unavailable',
        'Browser tidak dapat mendekode video hasil rekaman (WebCodecs tidak tersedia).',
      );
    }

    let useAudio = request.format === 'mp3' || request.includeAudio;
    if (useAudio && audioTrack && !(await audioTrack.canDecode())) {
      if (request.format === 'mp3') {
        throw new ConverterError('codec-unavailable', 'Browser tidak dapat mendekode audio hasil rekaman.');
      }
      notes.push('Audio rekaman tidak dapat didekode browser ini; hasil dibuat tanpa audio.');
      useAudio = false;
    }
    if (useAudio && !audioTrack && request.format !== 'mp3') {
      notes.push('Rekaman tidak memiliki audio; hasil hanya berisi video.');
      useAudio = false;
    }

    const plan = await planTarget(mb, request, videoTrack, notes);
    throwIfAborted(signal);

    const output = new mb.Output({ format: plan.outputFormat, target: new mb.BufferTarget() });
    const audioCodec = request.format === 'mp3' ? 'mp3' : request.format === 'mp4' ? 'aac' : 'opus';
    if (useAudio && audioCodec !== 'opus') {
      const provider = await ensureAudioEncoder(mb, audioCodec);
      if (!provider)
        throw new ConverterError('codec-unavailable', `Encoder audio ${audioCodec.toUpperCase()} tidak tersedia.`);
    }

    let peak = 0;
    const conversion = await mb.Conversion.init({
      input,
      output,
      showWarnings: false,
      tracks: 'primary',
      video: plan.video,
      audio: useAudio
        ? {
            codec: audioCodec,
            quality: new mb.Quality({
              bitrate:
                audioCodec === 'mp3'
                  ? AUDIO_EXPORT.mp3BitrateBps
                  : audioCodec === 'aac'
                    ? AUDIO_EXPORT.aacBitrateBps
                    : AUDIO_EXPORT.opusBitrateBps,
              bitrateMode: 'constant',
            }),
            process: (sample) => {
              peak = Math.max(peak, measurePeak(sample));
              return sample;
            },
          }
        : { discard: true },
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
      throw new ConverterError(
        'codec-unavailable',
        `Konversi tidak dapat dijalankan di browser ini (${reasons || 'alasan tidak diketahui'}).`,
      );
    }

    const abort = () => void conversion.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    conversion.onProgress = (progress) => onProgress('encoding', progress);
    onProgress('encoding', 0);
    try {
      await conversion.execute();
    } catch (error) {
      if (error instanceof mb.ConversionCanceledError || signal?.aborted) {
        throw new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.', { cause: error });
      }
      throw new ConverterError('encoding-failed', `Encoding gagal: ${errorMessage(error)}`, { cause: error });
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength === 0)
      throw new ConverterError('output-invalid', 'Encoder tidak menghasilkan data.');

    onProgress('validating', null);
    if (!hasValidSignature(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16)), request.format)) {
      throw new ConverterError('output-invalid', 'Signature file hasil tidak sesuai format yang diminta.');
    }
    const inspection = await inspectOutput(buffer);
    assertOutputMatches(inspection, {
      format: request.format,
      ...(plan.videoCodec ? { videoCodec: plan.videoCodec } : {}),
      ...(useAudio ? { audioCodec } : {}),
      requireAudio: useAudio,
    });

    const audioSilent = useAudio ? peak < AUDIO_EXPORT.silenceThreshold : null;
    if (audioSilent)
      notes.push('Audio terdeteksi hening (tidak ada suara). Periksa apakah animasi memutar audio saat direkam.');

    return {
      buffer,
      mimeType: OUTPUT_MIME[request.format],
      inspection,
      audioSilent,
      limitedCompatibility: plan.limitedCompatibility,
      notes,
    };
  } finally {
    input.dispose();
  }
}

interface TargetPlan {
  outputFormat: InstanceType<Mediabunny['OutputFormat']>;
  video: NonNullable<Parameters<Mediabunny['Conversion']['init']>[0]['video']>;
  videoCodec: string | null;
  limitedCompatibility: boolean;
}

async function planTarget(
  mb: Mediabunny,
  request: ConvertRequest,
  videoTrack: Awaited<ReturnType<InstanceType<Mediabunny['Input']>['getPrimaryVideoTrack']>>,
  notes: string[],
): Promise<TargetPlan> {
  if (request.format === 'mp3') {
    return {
      outputFormat: new mb.Mp3OutputFormat(),
      video: { discard: true },
      videoCodec: null,
      limitedCompatibility: false,
    };
  }

  const resize = {
    width: request.width,
    height: request.height,
    fit: 'contain' as const,
    frameRate: request.frameRate,
    quality: new mb.Quality({ bitrate: videoBitrateFor(request.width, request.height, request.frameRate) }),
    keyFrameInterval: VIDEO_EXPORT.keyFrameIntervalSeconds,
  };

  if (request.format === 'webm') {
    const codec = await mb.getFirstEncodableVideoCodec([...WEBM_VIDEO_CODECS], {
      width: request.width,
      height: request.height,
    });
    if (!codec) throw new ConverterError('codec-unavailable', 'Browser tidak memiliki encoder video untuk WebM.');
    return {
      outputFormat: new mb.WebMOutputFormat(),
      video: { ...resize, codec },
      videoCodec: codec,
      limitedCompatibility: false,
    };
  }

  const codec = request.mp4VideoCodec;
  const meta = MP4_VIDEO_CODECS.find((entry) => entry.codec === codec);
  const outputFormat = new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
  if (await mb.canEncodeVideo(codec, { width: request.width, height: request.height })) {
    return {
      outputFormat,
      video: { ...resize, codec },
      videoCodec: codec,
      limitedCompatibility: meta?.limitedCompatibility ?? true,
    };
  }
  // No encoder, but the recording already holds this codec (e.g. MediaRecorder wrote H.264): remux without resizing.
  if (videoTrack && (await videoTrack.getCodec()) === codec) {
    notes.push('Encoder video tidak tersedia; rekaman di-remux tanpa mengubah resolusi/FPS.');
    return {
      outputFormat,
      video: { codec },
      videoCodec: codec,
      limitedCompatibility: meta?.limitedCompatibility ?? true,
    };
  }
  throw new ConverterError(
    'codec-unavailable',
    `Encoder ${meta?.label ?? codec} tidak tersedia di browser ini. Pilih codec lain atau ekspor WebM.`,
  );
}

function measurePeak(sample: {
  numberOfFrames: number;
  numberOfChannels: number;
  allocationSize(o: { planeIndex: number; format: 'f32-planar' }): number;
  copyTo(d: Float32Array, o: { planeIndex: number; format: 'f32-planar' }): void;
}): number {
  let peak = 0;
  for (let plane = 0; plane < sample.numberOfChannels; plane += 1) {
    const options = { planeIndex: plane, format: 'f32-planar' as const };
    const data = new Float32Array(sample.allocationSize(options) / 4);
    sample.copyTo(data, options);
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i] ?? 0);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
