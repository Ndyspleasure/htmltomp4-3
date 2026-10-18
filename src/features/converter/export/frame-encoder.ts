/**
 * Encodes rendered frames (ImageBitmaps from the sandbox) and an optional pre-mixed audio track into
 * MP4 / WebM / MP3 with Mediabunny. Runs inside the encoder Web Worker.
 */
import {
  AUDIO_EXPORT,
  MP4_VIDEO_CODECS,
  OUTPUT_MIME,
  VIDEO_EXPORT,
  videoBitrateFor,
  type Mp4VideoCodec,
} from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { OutputFormat } from '../types';
import { ensureAudioEncoder, loadMediabunny, type ConvertResult } from './convert-media';
import {
  describeError,
  trialEncodeAudio,
  trialEncodeVideo,
  videoEncoderCandidates,
  type VideoEncoderCandidate,
} from './encoder-fallback';
import { MIX_SAMPLE_RATE } from '../render/audio-mix';
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
  /**
   * Pre-mixed audio, 'deferred' when the audio track will be supplied later via setAudio() (it is still
   * being recorded while frames render), or null for no audio track.
   */
  audio: MixedAudio | 'deferred' | null;
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
    private peak: number,
    private audioSource: InstanceType<Mediabunny['AudioSampleSource']> | null,
  ) {}

  static async create(config: FrameEncodeConfig): Promise<FrameEncoder> {
    const mb = await loadMediabunny();
    const notes: string[] = [];
    const { width, height, fps } = config;

    let format: InstanceType<Mediabunny['OutputFormat']>;
    let video: VideoEncoderCandidate | null = null;
    let limitedCompatibility = false;
    if (config.format === 'mp3') {
      format = new mb.Mp3OutputFormat();
    } else {
      video = await pickVideoEncoder(mb, config, notes);
      const meta = MP4_VIDEO_CODECS.find((entry) => entry.codec === video?.codec);
      limitedCompatibility = config.format === 'mp4' ? (meta?.limitedCompatibility ?? true) : false;
      format =
        config.format === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
    }
    const videoCodec = video?.codec ?? null;

    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    let videoSource: InstanceType<Mediabunny['VideoSampleSource']> | null = null;
    if (video) {
      videoSource = new mb.VideoSampleSource({
        codec: video.codec,
        quality: new mb.Quality({ bitrate: videoBitrateFor(width, height, fps) }),
        keyFrameInterval: VIDEO_EXPORT.keyFrameIntervalSeconds,
        hardwareAcceleration: video.hardwareAcceleration,
      });
      output.addVideoTrack(videoSource, { frameRate: fps });
    }

    let audioCodec: 'aac' | 'mp3' | 'opus' | null = null;
    let audioSource: InstanceType<Mediabunny['AudioSampleSource']> | null = null;
    let peak = 0;
    if (config.audio) {
      audioCodec = config.format === 'mp3' ? 'mp3' : config.format === 'mp4' ? 'aac' : 'opus';
      const bitrate =
        audioCodec === 'mp3'
          ? AUDIO_EXPORT.mp3BitrateBps
          : audioCodec === 'aac'
            ? AUDIO_EXPORT.aacBitrateBps
            : AUDIO_EXPORT.opusBitrateBps;
      const sampleRate = config.audio === 'deferred' ? MIX_SAMPLE_RATE : config.audio.sampleRate;
      await prepareAudioEncoder(mb, config.format, audioCodec, bitrate, sampleRate, notes);
      audioSource = new mb.AudioSampleSource({
        codec: audioCodec,
        quality: new mb.Quality({ bitrate, bitrateMode: 'constant' }),
      });
      output.addAudioTrack(audioSource);
      if (config.audio !== 'deferred') peak = peakOf(config.audio.channels);
    }

    await output.start();
    if (audioSource && config.audio && config.audio !== 'deferred') {
      await writeAudio(mb, audioSource, config.audio);
      audioSource.close();
      audioSource = null;
    }
    return new FrameEncoder(
      mb,
      config,
      output,
      videoSource,
      videoCodec,
      audioCodec,
      limitedCompatibility,
      notes,
      peak,
      audioSource,
    );
  }

  /** Supplies the deferred audio track. null writes silence so the declared track is never empty. */
  async setAudio(audio: MixedAudio | null): Promise<void> {
    const source = this.audioSource;
    if (!source) return;
    this.audioSource = null;
    const track =
      audio ??
      ({
        sampleRate: 48_000,
        channels: [0, 1].map(() => new Float32Array(Math.max(1, Math.round(this.config.durationSeconds * 48_000)))),
      } satisfies MixedAudio);
    this.peak = peakOf(track.channels);
    await writeAudio(this.mb, source, track);
    source.close();
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
    if (this.audioSource) await this.setAudio(null);
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

/**
 * Picks the first video encoder that survives a real trial encode (see encoder-fallback.ts). A fallback
 * away from the requested codec or from hardware encoding is reported to the user as a note.
 */
export async function pickVideoEncoder(
  mb: Mediabunny,
  config: FrameEncodeConfig,
  notes: string[],
): Promise<VideoEncoderCandidate> {
  const { width, height, fps } = config;
  const format = config.format === 'webm' ? 'webm' : 'mp4';
  const requested = format === 'mp4' ? config.mp4VideoCodec : null;
  const failures: string[] = [];
  for (const candidate of videoEncoderCandidates(format, requested)) {
    if (!(await mb.canEncodeVideo(candidate.codec, { width, height }).catch(() => false))) continue;
    const error = await trialEncodeVideo(mb, format, candidate, width, height, fps);
    if (!error) {
      if (failures.length > 0 || (requested && candidate.codec !== requested))
        notes.push(fallbackNote(candidate, requested, width, height));
      return candidate;
    }
    failures.push(`${labelOf(candidate.codec)} (${candidate.hardwareAcceleration}): ${describeError(error)}`);
  }
  const label = requested ? labelOf(requested) : 'WebM';
  throw new ConverterError(
    'codec-unavailable',
    failures.length > 0
      ? `Encoder video browser ini gagal pada ${width}×${height} (${failures.join('; ')}). Coba resolusi lebih kecil atau browser lain (Chrome/Edge terbaru).`
      : `Encoder ${label} tidak tersedia di browser ini. Pilih codec lain atau ekspor WebM.`,
  );
}

function fallbackNote(
  chosen: VideoEncoderCandidate,
  requested: Mp4VideoCodec | null,
  width: number,
  height: number,
): string {
  if (requested && chosen.codec !== requested) {
    return `Encoder ${labelOf(requested)} tidak tersedia atau gagal di browser ini pada ${width}×${height}; video dibuat dengan ${labelOf(chosen.codec)} (kompatibilitas pemutar lebih terbatas).`;
  }
  return `Encoder video hardware gagal pada ${width}×${height}; dipakai encoder software ${labelOf(chosen.codec)} (lebih lambat, hasil sama).`;
}

function labelOf(codec: string): string {
  return MP4_VIDEO_CODECS.find((entry) => entry.codec === codec)?.label ?? codec.toUpperCase();
}

/** Makes sure the audio encoder works for real; a failing native AAC/MP3 encoder is swapped for the WASM one. */
async function prepareAudioEncoder(
  mb: Mediabunny,
  format: OutputFormat,
  codec: 'aac' | 'mp3' | 'opus',
  bitrate: number,
  sampleRate: number,
  notes: string[],
): Promise<void> {
  const unavailable = () =>
    new ConverterError('codec-unavailable', `Encoder audio ${codec.toUpperCase()} tidak tersedia.`);
  const provider =
    codec === 'opus' ? ((await mb.canEncodeAudio('opus')) ? 'native' : null) : await ensureAudioEncoder(mb, codec);
  if (!provider) throw unavailable();
  const error = await trialEncodeAudio(mb, format, codec, bitrate, sampleRate);
  if (!error) return;
  if (provider === 'native' && codec !== 'opus' && (await ensureAudioEncoder(mb, codec, true))) {
    const retry = await trialEncodeAudio(mb, format, codec, bitrate, sampleRate);
    if (!retry) {
      notes.push(`Encoder audio ${codec.toUpperCase()} bawaan browser gagal; dipakai encoder WASM.`);
      return;
    }
  }
  throw new ConverterError(
    'codec-unavailable',
    `Encoder audio ${codec.toUpperCase()} browser ini gagal (${describeError(error)}). Coba matikan audio atau gunakan browser lain.`,
  );
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
