/**
 * Tracks whether the document is still animating on the virtual clock: DOM mutations, canvas drawing and
 * finite Web Animations count as activity. Infinite CSS loops (pulsing buttons etc.) are ignored, so a
 * custom JS "video" that stops updating is recognised as finished even if a decoration keeps looping.
 */
export class ActivityMonitor {
  lastActivityMs = 0;
  /** True when an infinitely repeating animation is running (the page may loop forever). */
  infiniteRunning = false;
  private observer: MutationObserver | null = null;
  private now: () => number = () => 0;

  install(win: Window & typeof globalThis, now: () => number): void {
    this.now = now;
    const mark = () => {
      this.lastActivityMs = this.now();
    };
    for (const ctor of [win.CanvasRenderingContext2D, win.OffscreenCanvasRenderingContext2D]) {
      if (!ctor) continue;
      const proto = ctor.prototype as unknown as Record<string, unknown>;
      for (const method of [
        'fillRect',
        'clearRect',
        'strokeRect',
        'fill',
        'stroke',
        'drawImage',
        'fillText',
        'strokeText',
        'putImageData',
      ]) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = function (this: unknown, ...args: unknown[]) {
          mark();
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        };
      }
    }
    for (const ctor of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
      if (!ctor) continue;
      const proto = ctor.prototype as unknown as Record<string, unknown>;
      for (const method of ['drawArrays', 'drawElements', 'clear']) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = function (this: unknown, ...args: unknown[]) {
          mark();
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        };
      }
    }
  }

  /** Starts observing the written document. */
  observe(doc: Document): void {
    this.observer?.disconnect();
    this.observer = new MutationObserver((records) => {
      if (records.some(isRealChange)) this.lastActivityMs = this.now();
    });
    this.observer.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeOldValue: true,
      characterDataOldValue: true,
    });
  }

  /** Call after each virtual tick: finite running Web Animations also count as activity. */
  sample(doc: Document, nowMs: number): void {
    // Flush pending mutation records synchronously so they are attributed to this tick.
    if (this.observer && this.observer.takeRecords().some(isRealChange)) this.lastActivityMs = nowMs;
    this.infiniteRunning = false;
    if (typeof doc.getAnimations !== 'function') return;
    for (const animation of doc.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (!timing) continue;
      if (timing.iterations === Infinity) {
        this.infiniteRunning = true;
        continue;
      }
      const progress = timing.progress;
      if (
        progress !== null &&
        progress !== undefined &&
        timing.activeDuration &&
        Number(timing.localTime) < Number(timing.endTime)
      ) {
        this.lastActivityMs = nowMs;
      }
    }
  }

  disconnect(): void {
    this.observer?.disconnect();
  }
}

/**
 * Many players redraw every frame (`el.textContent = sameText`, `style.width = sameWidth`). Those writes
 * produce mutation records without changing anything visible, so they must not count as activity.
 */
export function isRealChange(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    const target = record.target as Element;
    const name = record.attributeName ?? '';
    const now = record.attributeNamespace
      ? target.getAttributeNS(record.attributeNamespace, name)
      : target.getAttribute(name);
    return now !== record.oldValue;
  }
  if (record.type === 'characterData') return (record.target as CharacterData).data !== record.oldValue;
  // childList: replacing text with identical text (textContent = same value) is not a change.
  const removed = [...record.removedNodes];
  const added = [...record.addedNodes];
  const textOnly = (nodes: Node[]) => nodes.every((node) => node.nodeType === Node.TEXT_NODE);
  if (removed.length > 0 && textOnly(removed) && textOnly(added)) {
    return removed.map((n) => n.textContent).join('') !== added.map((n) => n.textContent).join('');
  }
  return true;
}
