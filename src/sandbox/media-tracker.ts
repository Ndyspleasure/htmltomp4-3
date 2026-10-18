/**
 * Render-mode replacement for real media playback. play()/pause() on <audio>/<video> (and `new Audio()`)
 * are recorded on the virtual timeline instead of producing sound, so the audio can be mixed offline in
 * exact sync and videos can be seeked frame by frame.
 */
import type { VirtualClock } from './virtual-clock';

export interface MediaSession {
  element: HTMLMediaElement;
  url: string;
  startMs: number;
  offsetSeconds: number;
  stopMs: number | null;
}

export class MediaTracker {
  readonly sessions: MediaSession[] = [];
  private readonly active = new Map<HTMLMediaElement, MediaSession>();

  constructor(private readonly clock: VirtualClock) {}

  install(win: Window & typeof globalThis): void {
    const tracker = this;
    const proto = win.HTMLMediaElement.prototype;
    const realPause = proto.pause;
    const currentTime = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    const paused = Object.getOwnPropertyDescriptor(proto, 'paused');

    proto.play = function play(this: HTMLMediaElement) {
      tracker.start(this);
      return Promise.resolve();
    };
    proto.pause = function pause(this: HTMLMediaElement) {
      tracker.stop(this);
      realPause.call(this);
    };
    if (currentTime?.get && currentTime.set) {
      const { get, set } = currentTime;
      Object.defineProperty(proto, 'currentTime', {
        configurable: true,
        get(this: HTMLMediaElement) {
          const session = tracker.active.get(this);
          return session && !(this instanceof win.HTMLVideoElement) ? tracker.positionOf(session) : get.call(this);
        },
        set(this: HTMLMediaElement, value: number) {
          const session = tracker.active.get(this);
          if (session) {
            tracker.stop(this);
            set.call(this, value);
            tracker.start(this, Number(value) || 0);
          } else {
            set.call(this, value);
          }
        },
      });
    }
    if (paused?.get) {
      const { get } = paused;
      Object.defineProperty(proto, 'paused', {
        configurable: true,
        get(this: HTMLMediaElement) {
          return tracker.active.has(this) ? false : get.call(this);
        },
      });
    }
    this.realPause = (element) => realPause.call(element);
    this.readCurrentTime = (element) => (currentTime?.get ? (currentTime.get.call(element) as number) : 0);
    this.writeCurrentTime = (element, value) => currentTime?.set?.call(element, value);
  }

  private writeCurrentTime: (element: HTMLMediaElement, value: number) => void = () => undefined;

  private realPause: (element: HTMLMediaElement) => void = () => undefined;
  private readCurrentTime: (element: HTMLMediaElement) => number = () => 0;

  /** Converts autoplaying elements in the written document into virtual playback starting at t=0. */
  adoptAutoplay(doc: Document): void {
    doc.querySelectorAll<HTMLMediaElement>('audio[autoplay], video[autoplay]').forEach((element) => {
      element.autoplay = false;
      this.realPause(element);
      this.start(element);
    });
  }

  start(element: HTMLMediaElement, offsetSeconds?: number): void {
    if (this.active.has(element)) return;
    const session: MediaSession = {
      element,
      url: element.currentSrc || element.src,
      startMs: this.clock.now,
      offsetSeconds: offsetSeconds ?? this.readCurrentTime(element),
      stopMs: null,
    };
    this.active.set(element, session);
    this.sessions.push(session);
    element.dispatchEvent(new Event('play'));
    element.dispatchEvent(new Event('playing'));
  }

  stop(element: HTMLMediaElement): void {
    const session = this.active.get(element);
    if (!session) return;
    session.stopMs = this.clock.now;
    this.active.delete(element);
    element.dispatchEvent(new Event('pause'));
  }

  positionOf(session: MediaSession): number {
    const elapsed = ((this.clock.now - session.startMs) / 1000) * (session.element.playbackRate || 1);
    const position = session.offsetSeconds + elapsed;
    const duration = session.element.duration;
    if (Number.isFinite(duration) && duration > 0) {
      return session.element.loop ? position % duration : Math.min(position, duration);
    }
    return position;
  }

  /** Fires `ended` for non-looping media that reached their end on the virtual timeline. */
  tick(): void {
    for (const [element, session] of [...this.active]) {
      const duration = element.duration;
      if (!element.loop && Number.isFinite(duration) && duration > 0 && this.positionOf(session) >= duration) {
        session.stopMs = session.startMs + ((duration - session.offsetSeconds) / (element.playbackRate || 1)) * 1000;
        this.active.delete(element);
        element.dispatchEvent(new Event('ended'));
      }
    }
  }

  /** Seeks playing <video> elements to their virtual position so the next frame shows the right picture. */
  async syncVideos(win: Window & typeof globalThis, timeoutMs = 2000): Promise<void> {
    const seeks: Promise<void>[] = [];
    for (const [element, session] of this.active) {
      if (!(element instanceof win.HTMLVideoElement) || element.readyState < 1) continue;
      const target = this.positionOf(session);
      if (Math.abs(this.readCurrentTime(element) - target) < 0.001) continue;
      seeks.push(
        new Promise<void>((resolve) => {
          const done = () => {
            element.removeEventListener('seeked', done);
            resolve();
          };
          element.addEventListener('seeked', done);
          this.clock.sleep(timeoutMs).then(done);
          this.writeCurrentTime(element, target);
        }),
      );
    }
    await Promise.all(seeks);
  }
}
