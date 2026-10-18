/**
 * Render/audio modes of the sandbox. In render mode the user's document runs on a virtual clock: the
 * analysis pass finds the duration (explicit/library timing or "until the page stops changing") and
 * collects media playback for offline mixing; the render pass rasterizes one frame per tick and streams
 * frames to the converter with a small in-flight window. Audio mode plays the document in real time and
 * records its Web Audio output.
 */
import { RECORDING_LIMITS } from '../config/converter-config';
import type { AudioSession, CapturedAudio, SandboxToApp } from '../features/converter/render/sandbox-protocol';
import { ActivityMonitor } from './activity-monitor';
import { AnimationSync } from './animation-sync';
import { WebAudioCapture } from './audio-capture';
import { clickStartControl } from './auto-start';
import { detectTiming } from './duration-detect';
import { FrameRasterizer } from './frame-rasterizer';
import { MediaTracker } from './media-tracker';
import { VirtualClock } from './virtual-clock';

const MAX_IN_FLIGHT_FRAMES = 3;
/** The animation counts as finished after this long without any visual change. */
const QUIET_MS = 2000;
/** Still frames kept after the last change, so the final state is visible in the video. */
const END_HOLD_MS = 500;
const MIN_AUTO_MS = 1000;
const LOOP_GIVE_UP_MS = 30_000;

export class RenderController {
  readonly clock = new VirtualClock();
  readonly media = new MediaTracker(this.clock);
  private readonly animations = new AnimationSync();
  private readonly activity = new ActivityMonitor();
  private readonly webAudio = new WebAudioCapture('silence');
  private cancelled = false;
  private acked = -1;
  private ackWaiter: (() => void) | null = null;

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly post: (message: SandboxToApp, transfer?: Transferable[]) => void,
  ) {}

  /** Must run before the user's document is written. */
  install(): void {
    this.clock.install(this.win);
    this.media.install(this.win);
    this.activity.install(this.win, () => this.clock.now);
    this.webAudio.install(this.win);
    forcePreserveDrawingBuffer(this.win);
  }

  /** Called right after the user's document was written. */
  afterWrite(): void {
    this.media.adoptAutoplay(this.win.document);
    this.activity.observe(this.win.document);
  }

  cancel(): void {
    this.cancelled = true;
    this.ackWaiter?.();
  }

  ack(index: number): void {
    this.acked = Math.max(this.acked, index);
    this.ackWaiter?.();
  }

  private step(ms: number): void {
    this.clock.advanceTo(ms);
    this.media.tick();
    this.animations.sync(this.win.document, ms);
    this.activity.sample(this.win.document, ms);
  }

  /** Brings the document to virtual t=0: loaded, fonts ready, start button clicked. */
  private async start(autoStart: boolean): Promise<string | null> {
    await waitForDocument(this.win, (ms) => this.clock.sleep(ms));
    this.step(0);
    const clicked = autoStart ? clickStartControl(this.win.document) : null;
    this.step(0);
    this.activity.lastActivityMs = 0;
    return clicked;
  }

  async analyze(options: {
    durationSeconds: number | null;
    fallbackSeconds: number;
    fps: number;
    collectAudio: boolean;
    autoStart: boolean;
  }) {
    const clickedStart = await this.start(options.autoStart);
    const timing = detectTiming(this.win, 0);
    const warnings: string[] = [];
    this.activity.lastActivityMs = 0;
    const frameMs = 1000 / options.fps;
    const maxMs = RECORDING_LIMITS.maxDurationSeconds * 1000;
    let durationSeconds: number;

    if (options.durationSeconds !== null) {
      durationSeconds = Math.min(options.durationSeconds, RECORDING_LIMITS.maxDurationSeconds);
      await this.run(durationSeconds * 1000, frameMs);
    } else {
      const libraryMs = timing.durationSeconds !== null ? timing.durationSeconds * 1000 : 0;
      let quietEnd: number | null = null;
      for (let index = 1; index * frameMs <= maxMs && !this.cancelled; index++) {
        const now = index * frameMs;
        this.step(now);
        if (index % 30 === 0) await this.clock.sleep(0); // let media metadata/load events through
        // Only CSS loops and nothing else for a long time: treat as an endless loop without stepping to the cap.
        if (now >= LOOP_GIVE_UP_MS && this.activity.lastActivityMs === 0 && libraryMs === 0) break;
        if (now < Math.max(MIN_AUTO_MS, libraryMs) || now - this.activity.lastActivityMs < QUIET_MS) continue;
        // Something animated and then stopped changing: that is the end. Pure CSS loops never "end".
        if (this.activity.lastActivityMs > 0 || libraryMs > 0 || !this.activity.infiniteRunning) {
          quietEnd = Math.max(libraryMs, this.activity.lastActivityMs + END_HOLD_MS);
          break;
        }
      }
      const animated = this.activity.lastActivityMs > 0 || libraryMs > 0;
      if (quietEnd !== null && animated) {
        durationSeconds = Math.ceil(quietEnd / 100) / 10;
        if (!timing.sources.length) timing.sources.push('animasi berhenti berubah');
        timing.durationSeconds = durationSeconds;
      } else {
        // Looping forever, or nothing moves at all: use the duration the user entered.
        timing.looping = this.activity.infiniteRunning || quietEnd === null;
        timing.durationSeconds = null;
        durationSeconds = options.fallbackSeconds;
        if (!timing.looping) warnings.push('Tidak ada animasi yang terdeteksi; dipakai durasi yang diisi.');
      }
    }

    const audio = options.collectAudio ? await this.collectAudio(durationSeconds, warnings) : [];
    if (this.webAudio.speechUsed) {
      warnings.push(
        'Animasi memakai suara sintetis (speechSynthesis) yang tidak dapat direkam browser; voice-over tidak ikut.',
      );
    }
    return {
      durationSeconds,
      timing,
      audio,
      webAudioUsed: this.webAudio.used,
      speechUsed: this.webAudio.speechUsed,
      clickedStart,
      warnings,
    };
  }

  private async run(untilMs: number, frameMs: number): Promise<void> {
    for (let index = 1; index * frameMs <= untilMs && !this.cancelled; index++) {
      this.step(index * frameMs);
      if (index % 30 === 0) await this.clock.sleep(0);
    }
  }

  async render(options: {
    durationSeconds: number;
    fps: number;
    width: number;
    height: number;
    autoStart: boolean;
  }): Promise<number> {
    await this.start(options.autoStart);
    const rasterizer = new FrameRasterizer(this.win.document, this.clock, options.width, options.height);
    const total = Math.max(1, Math.round(options.durationSeconds * options.fps));
    const frameMs = 1000 / options.fps;
    try {
      for (let index = 0; index < total; index++) {
        if (this.cancelled) throw new Error('Render dibatalkan.');
        while (index - this.acked > MAX_IN_FLIGHT_FRAMES && !this.cancelled) {
          await new Promise<void>((resolve) => (this.ackWaiter = resolve));
          this.ackWaiter = null;
        }
        this.step(index * frameMs);
        await this.media.syncVideos(this.win);
        const bitmap = await rasterizer.capture();
        this.post({ type: 'h2m:render-frame', index, bitmap }, [bitmap]);
      }
      return total;
    } finally {
      rasterizer.dispose();
    }
  }

  private async collectAudio(durationSeconds: number, warnings: string[]): Promise<AudioSession[]> {
    const sessions: AudioSession[] = [];
    const cache = new Map<string, ArrayBuffer | null>();
    for (const session of this.media.sessions) {
      const element = session.element;
      if (element.muted || element.volume === 0 || !session.url) continue;
      const startSeconds = session.startMs / 1000;
      if (startSeconds >= durationSeconds) continue;
      if (!cache.has(session.url)) {
        try {
          const response = await fetch(session.url);
          cache.set(session.url, response.ok ? await response.arrayBuffer() : null);
        } catch {
          cache.set(session.url, null);
        }
        if (!cache.get(session.url))
          warnings.push(`Audio "${shortName(session.url)}" tidak dapat dimuat (CORS/jaringan).`);
      }
      const data = cache.get(session.url);
      if (!data) continue;
      sessions.push({
        data: data.slice(0),
        startSeconds,
        offsetSeconds: session.offsetSeconds,
        stopSeconds: session.stopMs === null ? null : session.stopMs / 1000,
        volume: element.volume,
        loop: element.loop,
        playbackRate: element.playbackRate || 1,
      });
    }
    return sessions;
  }
}

/**
 * Audio mode: plays the document in real time (no virtual clock) and records what Web Audio sends to the
 * speakers. Media elements are muted here because they are mixed offline from the analysis pass.
 */
export class AudioPassController {
  private readonly capture = new WebAudioCapture('record');

  constructor(private readonly win: Window & typeof globalThis) {}

  install(): void {
    this.capture.install(this.win);
    const proto = this.win.HTMLMediaElement.prototype;
    const play = proto.play;
    proto.play = function (this: HTMLMediaElement) {
      this.muted = true;
      return play.call(this);
    };
  }

  async record(options: { durationSeconds: number; autoStart: boolean }): Promise<CapturedAudio[]> {
    const sleep = (ms: number) => new Promise<void>((resolve) => this.win.setTimeout(resolve, ms));
    await waitForDocument(this.win, sleep);
    const origin = this.win.performance.now();
    this.capture.setOrigin(origin);
    if (options.autoStart) clickStartControl(this.win.document);
    await sleep(options.durationSeconds * 1000 + 300);
    return this.capture.finish();
  }
}

/** Lets the freshly written document, its fonts and media metadata load before t=0. */
async function waitForDocument(win: Window & typeof globalThis, sleep: (ms: number) => Promise<void>): Promise<void> {
  const doc = win.document;
  if (doc.readyState !== 'complete') {
    await Promise.race([
      new Promise<void>((resolve) => win.addEventListener('load', () => resolve(), { once: true })),
      sleep(10_000),
    ]);
  }
  await Promise.race([doc.fonts?.ready ?? Promise.resolve(), sleep(5_000)]);
  await Promise.all(
    [...doc.querySelectorAll<HTMLMediaElement>('audio, video')].map((media) =>
      media.readyState >= 1 || !media.currentSrc
        ? undefined
        : Promise.race([
            new Promise<void>((resolve) => media.addEventListener('loadedmetadata', () => resolve(), { once: true })),
            sleep(5_000),
          ]),
    ),
  );
}

/** WebGL canvases must keep their drawing buffer so the rasterizer can read them after the frame. */
function forcePreserveDrawingBuffer(win: Window & typeof globalThis): void {
  const proto = win.HTMLCanvasElement.prototype;
  const original = proto.getContext;
  proto.getContext = function getContext(this: HTMLCanvasElement, type: string, options?: Record<string, unknown>) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      return original.call(this, type, { ...(options ?? {}), preserveDrawingBuffer: true });
    }
    return original.call(this, type, options);
  } as typeof proto.getContext;
}

function shortName(url: string): string {
  if (url.startsWith('blob:')) return 'aset lokal';
  return url.split('/').pop()?.slice(0, 60) ?? url;
}
