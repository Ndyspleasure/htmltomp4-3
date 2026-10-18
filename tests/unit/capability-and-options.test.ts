import { describe, expect, it } from 'vitest';
import { pickRecorderMime } from '../../src/features/converter/capture/capability-check';
import type { EncoderSupport } from '../../src/features/converter/export/convert-media';
import { bestMp4Codec, formatAvailability } from '../../src/features/converter/export/export-options';

const support = (over: Partial<EncoderSupport> = {}): EncoderSupport => ({
  webCodecs: true,
  mp4Video: { avc: true, vp9: true, av1: false },
  webmVideo: 'vp9',
  aac: 'native',
  mp3: 'wasm',
  opus: true,
  ...over,
});
const recorder = { video: 'video/webm;codecs=vp9,opus', audio: 'audio/webm;codecs=opus' };

describe('pickRecorderMime', () => {
  it('returns the first supported candidate and survives throwing checks', () => {
    const supported = new Set(['video/webm']);
    const pick = pickRecorderMime(['video/mp4;codecs=avc1', 'bad', 'video/webm'], (m) => {
      if (m === 'bad') throw new Error('boom');
      return supported.has(m);
    });
    expect(pick).toBe('video/webm');
    expect(pickRecorderMime(['a'], () => false)).toBeNull();
  });
});

describe('export options', () => {
  it('prefers H.264, then VP9, then AV1', () => {
    expect(bestMp4Codec(support())).toBe('avc');
    expect(bestMp4Codec(support({ mp4Video: { avc: false, vp9: true, av1: true } }))).toBe('vp9');
    expect(bestMp4Codec(support({ mp4Video: { avc: false, vp9: false, av1: false } }))).toBeNull();
  });

  it('reports formats unavailable without display capture', () => {
    expect(formatAvailability('mp4', support(), recorder, false).available).toBe(false);
  });

  it('requires an audio recorder and an MP3 encoder for MP3', () => {
    expect(formatAvailability('mp3', support(), recorder, true).available).toBe(true);
    expect(formatAvailability('mp3', support(), { ...recorder, audio: null }, true).available).toBe(false);
    expect(formatAvailability('mp3', support({ mp3: null }), recorder, true).available).toBe(false);
  });

  it('offers MP4 remux when only MediaRecorder H.264 is available', () => {
    const none = support({ mp4Video: { avc: false, vp9: false, av1: false } });
    expect(formatAvailability('mp4', none, recorder, true).available).toBe(false);
    const result = formatAvailability('mp4', none, { ...recorder, video: 'video/mp4;codecs=avc1,mp4a.40.2' }, true);
    expect(result.available).toBe(true);
    expect(result.reason).toMatch(/remux/);
  });

  it('requires a WebM encoder for WebM', () => {
    expect(formatAvailability('webm', support({ webmVideo: null }), recorder, true).available).toBe(false);
  });
});
