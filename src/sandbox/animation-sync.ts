/**
 * Pins CSS animations/transitions and Web Animations to the virtual clock. Each animation is paused the
 * first time it is seen and its currentTime is then set explicitly for every frame.
 */
export class AnimationSync {
  private readonly startTimes = new WeakMap<Animation, number>();

  sync(doc: Document, nowMs: number): void {
    if (typeof doc.getAnimations !== 'function') return;
    for (const animation of doc.getAnimations()) {
      let start = this.startTimes.get(animation);
      if (start === undefined) {
        const current = typeof animation.currentTime === 'number' ? animation.currentTime : 0;
        start = nowMs - current;
        this.startTimes.set(animation, start);
        animation.pause();
      }
      try {
        animation.currentTime = Math.max(0, nowMs - start);
      } catch {
        // Some animations (e.g. scroll-driven) cannot be seeked by time; leave them as they are.
      }
    }
  }
}
