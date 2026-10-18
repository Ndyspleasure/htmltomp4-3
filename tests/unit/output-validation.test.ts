import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConverterError } from '../../src/features/converter/errors';
import {
  assertOutputMatches,
  hasValidSignature,
  inspectOutput,
} from '../../src/features/converter/export/output-validation';

const fixture = (name: string) => {
  const bytes = readFileSync(new URL(`../fixtures/media/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

describe('hasValidSignature', () => {
  it('recognises real containers and rejects mislabeled data', () => {
    expect(hasValidSignature(new Uint8Array(fixture('h264-aac.mp4')), 'mp4')).toBe(true);
    expect(hasValidSignature(new Uint8Array(fixture('tone.mp3')), 'mp3')).toBe(true);
    expect(hasValidSignature(new Uint8Array(fixture('vp9-opus.webm')), 'webm')).toBe(true);
    expect(hasValidSignature(new Uint8Array(fixture('vp9-opus.webm')), 'mp4')).toBe(false);
    expect(hasValidSignature(new Uint8Array(fixture('h264-aac.mp4')), 'mp3')).toBe(false);
    expect(hasValidSignature(new Uint8Array([0, 0]), 'mp3')).toBe(false);
  });
});

describe('inspectOutput + assertOutputMatches', () => {
  it('reads back an H.264/AAC MP4', async () => {
    const info = await inspectOutput(fixture('h264-aac.mp4'));
    expect(info.container).toBe('mp4');
    expect(info.video).toMatchObject({ codec: 'avc', width: 64, height: 64 });
    expect(info.audio?.codec).toBe('aac');
    expect(info.durationSeconds).toBeGreaterThan(0.9);
    expect(() =>
      assertOutputMatches(info, { format: 'mp4', videoCodec: 'avc', audioCodec: 'aac', requireAudio: true }),
    ).not.toThrow();
  });

  it('reads back an MP3', async () => {
    const info = await inspectOutput(fixture('tone.mp3'));
    expect(info.container).toBe('mp3');
    expect(info.audio?.codec).toBe('mp3');
    expect(info.video).toBeNull();
    expect(() => assertOutputMatches(info, { format: 'mp3', requireAudio: true })).not.toThrow();
  });

  it('rejects a WebM presented as MP4', async () => {
    const info = await inspectOutput(fixture('vp9-opus.webm'));
    expect(info.container).toBe('webm');
    expect(() => assertOutputMatches(info, { format: 'mp4', requireAudio: false })).toThrow(ConverterError);
  });

  it('rejects an MP4 missing the required audio track or with the wrong codec', async () => {
    const info = await inspectOutput(fixture('video-only.mp4'));
    expect(() => assertOutputMatches(info, { format: 'mp4', requireAudio: true, audioCodec: 'aac' })).toThrow(
      /audio hilang/,
    );
    expect(() => assertOutputMatches(info, { format: 'mp4', videoCodec: 'vp9', requireAudio: false })).toThrow(
      /codec video/,
    );
    expect(() => assertOutputMatches(info, { format: 'mp3', requireAudio: true })).toThrow(/container/);
  });

  it('rejects zero-duration output', () => {
    expect(() =>
      assertOutputMatches(
        {
          container: 'mp3',
          mimeType: 'audio/mpeg',
          durationSeconds: 0,
          video: null,
          audio: { codec: 'mp3', sampleRate: 44100, channels: 2 },
        },
        { format: 'mp3', requireAudio: true },
      ),
    ).toThrow(/durasi/);
  });
});
