import { describe, expect, it, vi } from 'vitest';
import {
  RESOLUTION_PRESETS,
  VIDEO_EXPORT,
  videoBitrateFor,
  DEFAULT_SETTINGS,
  RECORDING_LIMITS,
} from '../../src/config/converter-config';
import { ResourceTracker } from '../../src/features/converter/cleanup/resource-tracker';
import { ConverterError, toUserMessage } from '../../src/features/converter/errors';
import { buildOutputFileName, formatBytes, formatDuration } from '../../src/features/converter/format';

describe('format helpers', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatDuration(65.9)).toBe('01:05');
    expect(formatDuration(-1)).toBe('-');
  });

  it('builds safe output names with the real extension', () => {
    const name = buildOutputFileName('../My Anim (final).zip', 'mp4', new Date(2026, 0, 2, 3, 4, 5));
    expect(name).toBe('My-Anim-final-20260102-030405.mp4');
    expect(buildOutputFileName('###.html', 'mp3', new Date(2026, 0, 2, 3, 4, 5))).toBe('animasi-20260102-030405.mp3');
  });
});

describe('config', () => {
  it('uses even dimensions (required by H.264/4:2:0)', () => {
    for (const preset of RESOLUTION_PRESETS) {
      expect(preset.width % 2).toBe(0);
      expect(preset.height % 2).toBe(0);
    }
  });

  it('keeps the bitrate within bounds', () => {
    expect(videoBitrateFor(300, 250, 24)).toBe(VIDEO_EXPORT.minBitrateBps);
    expect(videoBitrateFor(1920, 1080, 60)).toBe(12_441_600);
    expect(videoBitrateFor(3840, 2160, 60)).toBe(VIDEO_EXPORT.maxBitrateBps);
    expect(videoBitrateFor(1280, 720, 30)).toBe(2_764_800);
  });

  it('has defaults inside the configured limits', () => {
    expect(DEFAULT_SETTINGS.durationSeconds).toBeGreaterThanOrEqual(RECORDING_LIMITS.minDurationSeconds);
    expect(DEFAULT_SETTINGS.durationSeconds).toBeLessThanOrEqual(RECORDING_LIMITS.maxDurationSeconds);
    expect(RESOLUTION_PRESETS.some((p) => p.id === DEFAULT_SETTINGS.resolutionId)).toBe(true);
  });
});

describe('ResourceTracker', () => {
  it('releases everything once, in reverse order, even if one disposer throws', () => {
    const tracker = new ResourceTracker();
    const order: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tracker.add(() => order.push('a'));
    tracker.add(() => {
      throw new Error('fail');
    });
    tracker.add(() => order.push('c'));
    tracker.releaseAll();
    tracker.releaseAll();
    expect(order).toEqual(['c', 'a']);
    expect(warn).toHaveBeenCalledOnce();
    expect(tracker.size).toBe(0);
  });

  it('replaces resources registered under the same key', () => {
    const tracker = new ResourceTracker();
    const first = vi.fn();
    tracker.add(first, 'k');
    tracker.add(() => undefined, 'k');
    expect(first).toHaveBeenCalledOnce();
    expect(tracker.has('k')).toBe(true);
  });

  it('stops tracks and revokes object URLs', () => {
    const tracker = new ResourceTracker();
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    tracker.trackStream(stream);
    tracker.trackObjectUrl('blob:x');
    tracker.releaseAll();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});

describe('toUserMessage', () => {
  it('maps errors to readable messages', () => {
    expect(toUserMessage(new ConverterError('zip-bomb', 'pesan'))).toBe('pesan');
    expect(toUserMessage(new DOMException('x', 'NotAllowedError'))).toMatch(/Izin ditolak/);
    expect(toUserMessage(new RangeError('Array buffer allocation failed'))).toMatch(/Memori/);
    expect(toUserMessage('weird')).toMatch(/tidak diketahui/);
  });
});
