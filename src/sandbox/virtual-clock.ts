/**
 * Deterministic virtual time for render mode. Replaces timers, requestAnimationFrame, performance.now and
 * Date inside the sandbox so the animation advances exactly one frame per capture, independent of how long
 * rasterizing a frame takes. `passthrough` temporarily routes new timers to the real clock (used while the
 * frame rasterizer itself waits on timers).
 */
interface Timer {
  id: number;
  due: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  interval: number | null;
}

export class VirtualClock {
  now = 0;
  passthrough = false;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();
  private rafCallbacks = new Map<number, FrameRequestCallback>();
  private readonly realTimerIds = new Set<number>();
  private readonly startEpoch: number;
  private real!: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };

  constructor(startEpoch = Date.now()) {
    this.startEpoch = startEpoch;
  }

  install(win: Window & typeof globalThis): void {
    this.real = {
      setTimeout: win.setTimeout.bind(win),
      clearTimeout: win.clearTimeout.bind(win),
      setInterval: win.setInterval.bind(win),
      clearInterval: win.clearInterval.bind(win),
    };
    const clock = this;

    const schedule = (callback: unknown, delay: unknown, args: unknown[], repeat: boolean): number => {
      if (typeof callback !== 'function') return 0;
      const ms = Math.max(0, Number(delay) || 0);
      if (clock.passthrough) {
        const id = repeat
          ? clock.real.setInterval(callback as () => void, ms, ...args)
          : clock.real.setTimeout(callback as () => void, ms, ...args);
        clock.realTimerIds.add(Number(id));
        return Number(id);
      }
      const id = 1_000_000 + clock.nextId++;
      clock.timers.set(id, {
        id,
        due: clock.now + ms,
        callback: callback as (...a: unknown[]) => void,
        args,
        interval: repeat ? Math.max(1, ms) : null,
      });
      return id;
    };
    const cancel = (id: unknown) => {
      const key = Number(id);
      if (clock.realTimerIds.delete(key)) {
        clock.real.clearTimeout(key);
        clock.real.clearInterval(key);
      } else {
        clock.timers.delete(key);
      }
    };

    win.setTimeout = ((cb: unknown, delay?: unknown, ...args: unknown[]) =>
      schedule(cb, delay, args, false)) as typeof setTimeout;
    win.setInterval = ((cb: unknown, delay?: unknown, ...args: unknown[]) =>
      schedule(cb, delay, args, true)) as typeof setInterval;
    win.clearTimeout = cancel as typeof clearTimeout;
    win.clearInterval = cancel as typeof clearInterval;

    win.requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = clock.nextId++;
      clock.rafCallbacks.set(id, callback);
      return id;
    };
    win.cancelAnimationFrame = (id: number) => {
      clock.rafCallbacks.delete(id);
    };

    win.performance.now = () => clock.now;

    const RealDate = win.Date;
    const startEpoch = this.startEpoch;
    // A function (not a class) so that calling Date() without `new` still returns a string.
    const VirtualDate = function (this: unknown, ...args: unknown[]) {
      const instance = args.length === 0 ? new RealDate(startEpoch + clock.now) : new RealDate(...(args as [number]));
      return new.target ? instance : instance.toString();
    } as unknown as DateConstructor;
    Object.defineProperty(VirtualDate, 'prototype', { value: RealDate.prototype });
    Object.assign(VirtualDate, { now: () => startEpoch + clock.now, parse: RealDate.parse, UTC: RealDate.UTC });
    win.Date = VirtualDate as DateConstructor;
  }

  /** Runs all timers due up to `target` (in order) and then one round of animation-frame callbacks. */
  advanceTo(target: number): void {
    for (let guard = 0; guard < 100_000; guard++) {
      let next: Timer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.due <= target && (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id)))
          next = timer;
      }
      if (!next) break;
      this.now = Math.max(this.now, next.due);
      if (next.interval === null) this.timers.delete(next.id);
      else next.due += next.interval;
      try {
        next.callback(...next.args);
      } catch (error) {
        reportError(error);
      }
    }
    this.now = target;
    const callbacks = this.rafCallbacks;
    this.rafCallbacks = new Map();
    for (const callback of callbacks.values()) {
      try {
        callback(target);
      } catch (error) {
        reportError(error);
      }
    }
  }

  /** Waits on the real clock (used between frames so the browser can load images/fonts). */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.real.setTimeout(resolve, ms));
  }
}

function reportError(error: unknown): void {
  // Surface user-code errors like the browser would, without stopping the render loop.
  queueMicrotask(() => {
    throw error;
  });
}
