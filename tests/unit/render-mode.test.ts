// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { EncoderSupport } from '../../src/features/converter/export/convert-media';
import { directFormatAvailability } from '../../src/features/converter/export/export-options';
import { clickStartControl } from '../../src/sandbox/auto-start';
import { VirtualClock } from '../../src/sandbox/virtual-clock';

function fakeWindow() {
  return {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    performance: { now: () => 123 },
    Date,
  } as unknown as Window & typeof globalThis;
}

describe('VirtualClock', () => {
  it('runs timers in order on the virtual timeline and drives rAF once per tick', () => {
    const win = fakeWindow();
    const clock = new VirtualClock(1_000_000);
    clock.install(win);
    const log: string[] = [];
    win.setTimeout(() => log.push(`b@${win.performance.now()}`), 200);
    win.setTimeout(() => log.push(`a@${win.performance.now()}`), 100);
    const interval = win.setInterval(() => log.push(`i@${win.performance.now()}`), 150);
    win.requestAnimationFrame((t) => log.push(`raf@${t}`));
    clock.advanceTo(160);
    expect(log).toEqual(['a@100', 'i@150', 'raf@160']);
    clock.advanceTo(310);
    win.clearInterval(interval);
    clock.advanceTo(1000);
    expect(log).toEqual(['a@100', 'i@150', 'raf@160', 'b@200', 'i@300']);
  });

  it('virtualises Date while keeping Date() callable without new', () => {
    const win = fakeWindow();
    const clock = new VirtualClock(1_000_000);
    clock.install(win);
    clock.advanceTo(500);
    expect(win.Date.now()).toBe(1_000_500);
    expect(new win.Date().getTime()).toBe(1_000_500);
    expect(new win.Date(0).getTime()).toBe(0);
    expect(typeof (win.Date as unknown as () => string)()).toBe('string');
    expect(new win.Date() instanceof Date).toBe(true);
  });

  it('sends timers to the real clock while in passthrough', () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    win.setTimeout = globalThis.setTimeout;
    const clock = new VirtualClock();
    clock.install(win);
    const real = vi.fn();
    clock.passthrough = true;
    win.setTimeout(real, 50);
    clock.passthrough = false;
    clock.advanceTo(10_000);
    expect(real).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(real).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe('clickStartControl', () => {
  it.each(['▶ Putar', 'Play', 'Mulai', 'start now', 'Tonton video'])('clicks a "%s" button', (label) => {
    document.body.innerHTML = `<button id="x">${label}</button>`;
    const onClick = vi.fn();
    document.getElementById('x')!.addEventListener('click', onClick);
    expect(clickStartControl(document)).not.toBeNull();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('ignores unrelated or hidden buttons', () => {
    document.body.innerHTML = '<button>Kirim formulir</button><button style="display:none">Play</button>';
    expect(clickStartControl(document)).toBeNull();
  });
});

describe('directFormatAvailability', () => {
  const support: EncoderSupport = {
    webCodecs: true,
    mp4Video: { avc: false, vp9: true, av1: false },
    webmVideo: 'vp9',
    aac: 'wasm',
    mp3: 'wasm',
    opus: true,
  };

  it('does not depend on screen capture APIs', () => {
    expect(directFormatAvailability('mp4', support, true).available).toBe(true);
    expect(directFormatAvailability('mp3', support, true).available).toBe(true);
    expect(directFormatAvailability('webm', support, true).available).toBe(true);
  });

  it('reports missing encoders or rendering support', () => {
    expect(
      directFormatAvailability('mp4', { ...support, mp4Video: { avc: false, vp9: false, av1: false } }, true).available,
    ).toBe(false);
    expect(directFormatAvailability('mp3', { ...support, mp3: null }, true).available).toBe(false);
    expect(directFormatAvailability('mp4', support, false).available).toBe(false);
  });
});
