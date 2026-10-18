import { createContext, destroyContext, domToCanvas } from 'modern-screenshot';
import type { VirtualClock } from './virtual-clock';

type ScreenshotContext = Awaited<ReturnType<typeof createContext>>;

/**
 * Rasterizes the sandbox document into ImageBitmaps of exactly width × height pixels using an SVG
 * foreignObject snapshot (modern-screenshot). A single context is reused across frames so fonts and
 * images are embedded once.
 */
export class FrameRasterizer {
  private context: ScreenshotContext | null = null;

  constructor(
    private readonly doc: Document,
    private readonly clock: VirtualClock,
    private readonly width: number,
    private readonly height: number,
  ) {}

  async capture(): Promise<ImageBitmap> {
    // The library waits on real timers (image decode, timeouts); let those through while it runs.
    this.clock.passthrough = true;
    try {
      this.context ??= await createContext(this.doc.documentElement, {
        width: this.width,
        height: this.height,
        scale: 1,
        backgroundColor: backgroundOf(this.doc),
        timeout: 15_000,
        style: { margin: '0' },
        features: { restoreScrollPosition: true },
      });
      this.context.sandbox ??= noDefaultStyleSandbox();
      const canvas = await domToCanvas(this.context);
      return await createImageBitmap(canvas, 0, 0, this.width, this.height);
    } finally {
      this.clock.passthrough = false;
    }
  }

  dispose(): void {
    if (this.context) destroyContext(this.context);
    this.context = null;
  }
}

/** Uses the page background so transparent documents render like they do in a browser tab. */
function backgroundOf(doc: Document): string {
  const view = doc.defaultView;
  if (!view) return '#ffffff';
  for (const element of [doc.body, doc.documentElement]) {
    if (!element) continue;
    const color = view.getComputedStyle(element).backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
  }
  return '#ffffff';
}

/**
 * modern-screenshot normally diffs computed styles against defaults read from a helper iframe. Inside
 * our opaque-origin sandbox every child frame is cross-origin and unreadable, so we hand it a stub
 * without a window: the library then inlines all computed styles (larger snapshot, same result).
 */
function noDefaultStyleSandbox(): HTMLIFrameElement {
  return { contentWindow: null, remove: () => undefined } as unknown as HTMLIFrameElement;
}
