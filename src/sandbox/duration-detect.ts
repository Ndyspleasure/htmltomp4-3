import type { DetectedTiming } from '../features/converter/render/sandbox-protocol';

const MAX_REASONABLE_SECONDS = 3600;

interface GsapLike {
  globalTimeline?: { getChildren?: (nested: boolean, tweens: boolean, timelines: boolean) => GsapChild[] };
}
interface GsapChild {
  endTime?: () => number;
  repeat?: () => number;
}
interface AnimeInstance {
  duration?: number;
  loop?: boolean | number;
}
interface LottieAnimation {
  totalFrames?: number;
  frameRate?: number;
  loop?: boolean | number;
}

/**
 * Estimates how long the uploaded animation runs, from (in order of trust) an explicit declaration,
 * CSS/Web Animations, GSAP, anime.js, Lottie and autoplaying media. Infinite loops are reported but not
 * counted; the caller falls back to the user's duration when nothing finite is found.
 * `elapsedMs` is how long the document has been running, so remaining times can be turned into totals.
 */
export function detectTiming(win: Window & typeof globalThis, elapsedMs: number): DetectedTiming {
  const doc = win.document;
  const explicit = readExplicitDuration(win);
  if (explicit !== null) return { durationSeconds: explicit, looping: false, sources: ['deklarasi h2m:duration'] };

  const candidates: number[] = [];
  const sources = new Set<string>();
  let looping = false;
  const add = (seconds: number, source: string) => {
    if (Number.isFinite(seconds) && seconds > 0 && seconds < MAX_REASONABLE_SECONDS) {
      candidates.push(seconds);
      sources.add(source);
    }
  };

  if (typeof doc.getAnimations === 'function') {
    for (const animation of doc.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (!timing) continue;
      if (timing.iterations === Infinity) {
        looping = true;
        continue;
      }
      const current = typeof animation.currentTime === 'number' ? animation.currentTime : 0;
      const remainingMs = Number(timing.endTime) - current;
      const kind = animation.constructor?.name;
      const label =
        kind === 'CSSTransition' ? 'CSS transition' : kind === 'CSSAnimation' ? 'CSS animation' : 'Web Animations';
      add((elapsedMs + remainingMs) / 1000, label);
    }
  }

  const gsap = (win as unknown as { gsap?: GsapLike }).gsap;
  const children = gsap?.globalTimeline?.getChildren?.(false, true, true) ?? [];
  for (const child of children) {
    if (child.repeat?.() === -1) {
      looping = true;
      continue;
    }
    if (typeof child.endTime === 'function') add(child.endTime(), 'GSAP');
  }

  const anime = (win as unknown as { anime?: { running?: AnimeInstance[] } }).anime;
  for (const instance of anime?.running ?? []) {
    if (
      instance.loop === true ||
      (typeof instance.loop === 'number' && instance.loop > 1 && !Number.isFinite(instance.loop))
    ) {
      looping = true;
      continue;
    }
    const loops = typeof instance.loop === 'number' && instance.loop > 0 ? instance.loop : 1;
    if (typeof instance.duration === 'number') add((instance.duration * loops) / 1000, 'anime.js');
  }

  const lottie = (win as unknown as { lottie?: { getRegisteredAnimations?: () => LottieAnimation[] } }).lottie;
  for (const animation of lottie?.getRegisteredAnimations?.() ?? []) {
    if (animation.loop === true) {
      looping = true;
      continue;
    }
    if (animation.totalFrames && animation.frameRate) add(animation.totalFrames / animation.frameRate, 'Lottie');
  }

  doc.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => {
    const playing = media.autoplay || !media.paused;
    if (!playing) return;
    if (media.loop) {
      looping = true;
      return;
    }
    add(
      media.duration - (media.currentTime || 0) + elapsedMs / 1000,
      media instanceof HTMLVideoElement ? 'video' : 'audio',
    );
  });

  return {
    durationSeconds: candidates.length > 0 ? roundUp(Math.max(...candidates)) : null,
    looping,
    sources: [...sources],
  };
}

/** `<meta name="h2m:duration" content="12.5">`, `<html data-h2m-duration="12.5">` or `window.H2M_DURATION = 12.5`. */
function readExplicitDuration(win: Window & typeof globalThis): number | null {
  const doc = win.document;
  const raw =
    doc.querySelector('meta[name="h2m:duration"]')?.getAttribute('content') ??
    doc.documentElement.getAttribute('data-h2m-duration') ??
    (win as unknown as { H2M_DURATION?: unknown }).H2M_DURATION;
  const value = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(value) && value > 0 ? roundUp(value) : null;
}

function roundUp(seconds: number): number {
  return Math.ceil(seconds * 10 - 1e-6) / 10;
}
