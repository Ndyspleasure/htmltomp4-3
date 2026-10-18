/**
 * Encodes rendered frames (ImageBitmaps from the sandbox) and an optional pre-mixed audio track into
 * MP4 / WebM / MP3 with Mediabunny. Runs inside the encoder Web Worker.
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
import { ensureAudioEncoder, loadMediabunny, type ConvertResult } from './convert-media';
import { assertOutputMatches, hasValidSignature, inspectOutput } from './output-validation';

export interface MixedAudio {
  sampleRate: number;
  /** Planar float samples, one array per channel. */
  channels: Float32Array[];
}

export interface FrameEncodeConfig {
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  mp4VideoCodec: Mp4VideoCodec;
  audio: MixedAudio | null;
  durationSeconds: number;
}

type Mediabunny = Awaited<ReturnType<typeof loadMediabunny>>;

const AUDIO_CHUNK_FRAMES = 4096;

export class FrameEncoder {
  private constructor(
    private readonly mb: Mediabunny,
    private readonly config: FrameEncodeConfig,
    private readonly output: InstanceType<Mediabunny['Output']>,
    private readonly videoSource: InstanceType<Mediabunny['VideoSampleSource']> | null,
    private readonly videoCodec: string | null,
    private readonly audioCodec: 'aac' | 'mp3' | 'opus' | null,
    private readonly limitedCompatibility: boolean,
    private readonly notes: string[],
    private readonly peak: number,
  ) {}

  static async create(config: FrameEncodeConfig): Promise<FrameEncoder> {
    const mb = await loadMediabunny();
    const notes: string[] = [];
    const { width, height, fps } = config;

    let format: InstanceType<Mediabunny['OutputFormat']>;
    let videoCodec: string | null = null;
    let limitedCompatibility = false;
    if (config.format === 'mp3') {
      format = new mb.Mp3OutputFormat();
    } else if (config.format === 'webm') {
      videoCodec = await mb.getFirstEncodableVideoCodec([...WEBM_VIDEO_CODECS], { width, height });
      if (!videoCodec)
        throw new ConverterError('codec-unavailable', 'Browser tidak memiliki encoder video untuk WebM.');
      format = new mb.WebMOutputFormat();
    } else {
      const meta = MP4_VIDEO_CODECS.find((entry) => entry.codec === config.mp4VideoCodec);
      if (!(await mb.canEncodeVideo(config.mp4VideoCodec, { width, height }))) {
        throw new ConverterError(
          'codec-unavailable',
          `Encoder ${meta?.label ?? config.mp4VideoCodec} tidak tersedia di browser ini. Pilih codec lain atau ekspor WebM.`,
        );
      }
      videoCodec = config.mp4VideoCodec;
      limitedCompatibility = meta?.limitedCompatibility ?? true;
      format = new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
    }

    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    let videoSource: InstanceType<Mediabunny['VideoSampleSource']> | null = null;
    if (videoCodec) {
      videoSource = new mb.VideoSampleSource({
        codec: videoCodec as Parameters<Mediabunny['canEncodeVideo']>[0],
        quality: new mb.Quality({ bitrate: videoBitrateFor(width, height, fps) }),
        keyFrameInterval: VIDEO_EXPORT.keyFrameIntervalSeconds,
      });
      output.addVideoTrack(videoSource, { frameRate: fps });
    }

    let audioCodec: 'aac' | 'mp3' | 'opus' | null = null;
    let audioSource: InstanceType<Mediabunny['AudioSampleSource']> | null = null;
    let peak = 0;
    if (config.audio) {
      audioCodec = config.format === 'mp3' ? 'mp3' : config.format === 'mp4' ? 'aac' : 'opus';
      const provider =
        audioCodec === 'opus'
          ? (await mb.canEncodeAudio('opus'))
            ? 'native'
            : null
          : await ensureAudioEncoder(mb, audioCodec);
      if (!provider)
        throw new ConverterError('codec-unavailable', `Encoder audio ${audioCodec.toUpperCase()} tidak tersedia.`);
      const bitrate =
        audioCodec === 'mp3'
          ? AUDIO_EXPORT.mp3BitrateBps
          : audioCodec === 'aac'
            ? AUDIO_EXPORT.aacBitrateBps
            : AUDIO_EXPORT.opusBitrateBps;
      audioSource = new mb.AudioSampleSource({
        codec: audioCodec,
        quality: new mb.Quality({ bitrate, bitrateMode: 'constant' }),
      });
      output.addAudioTrack(audioSource);
      peak = peakOf(config.audio.channels);
    }

    await output.start();
    if (audioSource && config.audio) {
      await writeAudio(mb, audioSource, config.audio);
      audioSource.close();
    }
    return new FrameEncoder(mb, config, output, videoSource, videoCodec, audioCodec, limitedCompatibility, notes, peak);
  }

  async addFrame(bitmap: ImageBitmap, index: number): Promise<void> {
    if (!this.videoSource) {
      bitmap.close();
      return;
    }
    const sample = new this.mb.VideoSample(bitmap, {
      timestamp: index / this.config.fps,
      duration: 1 / this.config.fps,
    });
    try {
      await this.videoSource.add(sample);
    } finally {
      sample.close();
      bitmap.close();
    }
  }

  async finish(onValidating: () => void): Promise<ConvertResult> {
    this.videoSource?.close();
    await this.output.finalize();
    const buffer = (this.output.target as InstanceType<Mediabunny['BufferTarget']>).buffer;
    if (!buffer || buffer.byteLength === 0)
      throw new ConverterError('output-invalid', 'Encoder tidak menghasilkan data.');
    onValidating();
    if (!hasValidSignature(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16)), this.config.format)) {
      throw new ConverterError('output-invalid', 'Signature file hasil tidak sesuai format yang diminta.');
    }
    const inspection = await inspectOutput(buffer);
    assertOutputMatches(inspection, {
      format: this.config.format,
      ...(this.videoCodec ? { videoCodec: this.videoCodec } : {}),
      ...(this.audioCodec ? { audioCodec: this.audioCodec } : {}),
      requireAudio: this.audioCodec !== null,
    });
    const audioSilent = this.audioCodec ? this.peak < AUDIO_EXPORT.silenceThreshold : null;
    if (audioSilent) this.notes.push('Audio terdeteksi hening (tidak ada suara).');
    return {
      buffer,
      mimeType: OUTPUT_MIME[this.config.format],
      inspection,
      audioSilent,
      limitedCompatibility: this.limitedCompatibility,
      notes: this.notes,
    };
  }

  async cancel(): Promise<void> {
    await this.output.cancel().catch(() => undefined);
  }
}

async function writeAudio(
  mb: Mediabunny,
  source: InstanceType<Mediabunny['AudioSampleSource']>,
  audio: MixedAudio,
): Promise<void> {
  const channels = audio.channels.length;
  const length = audio.channels[0]?.length ?? 0;
  for (let start = 0; start < length; start += AUDIO_CHUNK_FRAMES) {
    const frames = Math.min(AUDIO_CHUNK_FRAMES, length - start);
    const planar = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) planar.set(audio.channels[c]!.subarray(start, start + frames), c * frames);
    const sample = new mb.AudioSample({
      data: planar,
      format: 'f32-planar',
      numberOfChannels: channels,
      sampleRate: audio.sampleRate,
      timestamp: start / audio.sampleRate,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }
}

function peakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i] ?? 0);
      if (value > peak) peak = value;
    }
  }
  return peak;
}
