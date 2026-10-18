import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  trialEncodeVideo,
  videoEncoderCandidates,
  type VideoEncoderCandidate,
} from '../../src/features/converter/export/encoder-fallback';
import { pickVideoEncoder, type FrameEncodeConfig } from '../../src/features/converter/export/frame-encoder';
import { ConverterError } from '../../src/features/converter/errors';

vi.mock('../../src/features/converter/export/encoder-fallback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/converter/export/encoder-fallback')>()),
  trialEncodeVideo: vi.fn(),
}));

const trial = vi.mocked(trialEncodeVideo);
const key = (c: VideoEncoderCandidate) => `${c.codec}/${c.hardwareAcceleration}`;
const encodingError = () => new DOMException('The given encoding is not supported.', 'EncodingError');

const config = (over: Partial<FrameEncodeConfig> = {}): FrameEncodeConfig => ({
  format: 'mp4',
  width: 1080,
  height: 1920,
  fps: 30,
  mp4VideoCodec: 'avc',
  audio: null,
  durationSeconds: 60,
  ...over,
});
type PickMb = Parameters<typeof pickVideoEncoder>[0];
const fakeMb = (encodable: string[]) =>
  ({ canEncodeVideo: async (codec: string) => encodable.includes(codec) }) as unknown as PickMb;

describe('videoEncoderCandidates', () => {
  it('tries the requested codec (hardware default, then software) before the others', () => {
    expect(videoEncoderCandidates('mp4', 'avc').map(key)).toEqual([
      'avc/no-preference',
      'avc/prefer-software',
      'vp9/no-preference',
      'vp9/prefer-software',
      'av1/no-preference',
      'av1/prefer-software',
    ]);
    expect(videoEncoderCandidates('mp4', 'vp9').map(key).slice(0, 3)).toEqual([
      'vp9/no-preference',
      'vp9/prefer-software',
      'avc/no-preference',
    ]);
    expect(videoEncoderCandidates('webm', null).map((c) => c.codec)).toEqual([
      'vp9',
      'vp9',
      'vp8',
      'vp8',
      'av1',
      'av1',
    ]);
  });
});

describe('pickVideoEncoder', () => {
  beforeEach(() => trial.mockReset());

  it('keeps hardware H.264 when the trial encode works, without a note', async () => {
    trial.mockResolvedValue(null);
    const notes: string[] = [];
    expect(key(await pickVideoEncoder(fakeMb(['avc', 'vp9']), config(), notes))).toBe('avc/no-preference');
    expect(notes).toEqual([]);
  });

  it('falls back to software H.264 when the hardware encoder throws EncodingError', async () => {
    trial.mockImplementation(async (_mb, _format, candidate) =>
      candidate?.hardwareAcceleration === 'no-preference' ? encodingError() : null,
    );
    const notes: string[] = [];
    expect(key(await pickVideoEncoder(fakeMb(['avc', 'vp9']), config(), notes))).toBe('avc/prefer-software');
    expect(notes[0]).toMatch(/software H\.264/);
  });

  it('falls back to another MP4 codec and says so when H.264 fails entirely', async () => {
    trial.mockImplementation(async (_mb, _format, candidate) => (candidate?.codec === 'avc' ? encodingError() : null));
    const notes: string[] = [];
    expect(key(await pickVideoEncoder(fakeMb(['avc', 'vp9']), config(), notes))).toBe('vp9/no-preference');
    expect(notes[0]).toMatch(/H\.264 .*gagal di browser ini pada 1080×1920.*VP9/);
  });

  it('skips codecs the browser cannot encode at all', async () => {
    trial.mockResolvedValue(null);
    const notes: string[] = [];
    expect(key(await pickVideoEncoder(fakeMb(['vp9']), config(), notes))).toBe('vp9/no-preference');
    expect(notes[0]).toMatch(/H\.264 tidak tersedia/);
    expect(trial).not.toHaveBeenCalledWith(
      expect.anything(),
      'mp4',
      expect.objectContaining({ codec: 'avc' }),
      1080,
      1920,
      30,
    );
  });

  it('reports every failure in a readable error when nothing works', async () => {
    trial.mockResolvedValue(encodingError());
    const error = await pickVideoEncoder(fakeMb(['avc']), config(), []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConverterError);
    expect((error as ConverterError).code).toBe('codec-unavailable');
    expect((error as ConverterError).message).toMatch(/EncodingError: The given encoding is not supported/);
  });
});
