/**
 * Collects disposers for object URLs, media streams, workers, windows and other session resources so a
 * single call releases everything on completion, error, cancel or reset.
 */
export class ResourceTracker {
  private readonly disposers = new Map<string, () => void>();
  private counter = 0;

  /** Registers a disposer and returns a key that can release it early. */
  add(dispose: () => void, key = `r${++this.counter}`): string {
    this.release(key);
    this.disposers.set(key, dispose);
    return key;
  }

  trackObjectUrl(url: string, key?: string): string {
    return this.add(() => URL.revokeObjectURL(url), key);
  }

  trackStream(stream: MediaStream, key?: string): string {
    return this.add(() => stream.getTracks().forEach((track) => track.stop()), key);
  }

  release(key: string): void {
    const dispose = this.disposers.get(key);
    if (!dispose) return;
    this.disposers.delete(key);
    runSafely(dispose);
  }

  has(key: string): boolean {
    return this.disposers.has(key);
  }

  get size(): number {
    return this.disposers.size;
  }

  releaseAll(): void {
    const all = [...this.disposers.values()].reverse();
    this.disposers.clear();
    all.forEach(runSafely);
  }
}

function runSafely(dispose: () => void): void {
  try {
    dispose();
  } catch (error) {
    // Cleanup must continue for the remaining resources; report instead of swallowing silently.
    console.warn('[cleanup] gagal melepas resource', error);
  }
}
