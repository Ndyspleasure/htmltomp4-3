import { ConverterError } from '../errors';
import type { OutputFormat } from '../types';

export interface OutputInspection {
  container: OutputFormat | 'unknown';
  mimeType: string;
  durationSeconds: number;
  video: { codec: string | null; width: number; height: number } | null;
  audio: { codec: string | null; sampleRate: number; channels: number } | null;
}

export interface OutputExpectations {
  format: OutputFormat;
  videoCodec?: string;
  audioCodec?: string;
  requireAudio: boolean;
}

/** Checks container signatures; a file extension is never accepted as proof of format. */
export function hasValidSignature(bytes: Uint8Array, format: OutputFormat): boolean {
  if (format === 'mp4') {
    return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
  }
  if (format === 'webm') {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  // MP3: either an ID3v2 tag or an MPEG audio frame sync.
  if (bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
}

/** Parses the produced file back with Mediabunny and reports its real container, tracks and duration. */
export async function inspectOutput(buffer: ArrayBuffer): Promise<OutputInspection> {
  const { Input, BufferSource, ALL_FORMATS, MP4, MP3, WEBM } = await import('mediabunny');
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  try {
    const format = await input.getFormat();
    const container: OutputInspection['container'] =
      format === MP4 ? 'mp4' : format === MP3 ? 'mp3' : format === WEBM ? 'webm' : 'unknown';
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    return {
      container,
      mimeType: await input.getMimeType(),
      durationSeconds: await input.computeDuration(),
      video: videoTrack
        ? {
            codec: await videoTrack.getCodec(),
            width: await videoTrack.getDisplayWidth(),
            height: await videoTrack.getDisplayHeight(),
          }
        : null,
      audio: audioTrack
        ? {
            codec: await audioTrack.getCodec(),
            sampleRate: await audioTrack.getSampleRate(),
            channels: await audioTrack.getNumberOfChannels(),
          }
        : null,
    };
  } finally {
    input.dispose();
  }
}

/** Throws output-invalid unless the inspected file is exactly what the user asked for. */
export function assertOutputMatches(inspection: OutputInspection, expected: OutputExpectations): void {
  const fail = (reason: string): never => {
    throw new ConverterError('output-invalid', `Validasi hasil gagal: ${reason}. File tidak ditawarkan untuk diunduh.`);
  };
  if (inspection.container !== expected.format) {
    fail(`container terbaca sebagai ${inspection.container}, bukan ${expected.format.toUpperCase()}`);
  }
  if (!(inspection.durationSeconds > 0)) fail('durasi hasil 0 detik');

  if (expected.format === 'mp3') {
    if (!inspection.audio) fail('tidak ada track audio');
    if (inspection.audio?.codec !== 'mp3') fail(`codec audio ${inspection.audio?.codec ?? 'tidak dikenal'}, bukan MP3`);
    if (inspection.video) fail('file MP3 berisi track video');
    return;
  }

  if (!inspection.video) fail('tidak ada track video');
  if (expected.videoCodec && inspection.video?.codec !== expected.videoCodec) {
    fail(`codec video ${inspection.video?.codec ?? 'tidak dikenal'}, seharusnya ${expected.videoCodec}`);
  }
  if (expected.requireAudio) {
    if (!inspection.audio) fail('track audio hilang');
    if (expected.audioCodec && inspection.audio?.codec !== expected.audioCodec) {
      fail(`codec audio ${inspection.audio?.codec ?? 'tidak dikenal'}, seharusnya ${expected.audioCodec}`);
    }
  }
}
