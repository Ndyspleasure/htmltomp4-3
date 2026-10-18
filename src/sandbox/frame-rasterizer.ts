import { createContext, destroyContext, domToCanvas } from 'modern-screenshot';
import type { VirtualClock } from './virtual-clock';

type ScreenshotContext = Awaited<ReturnType<typeof createContext>>;

/**
 * Rasterizes a node of the sandbox document into ImageBitmaps of exactly width × height pixels using an
 * SVG foreignObject snapshot (modern-screenshot). With a stage element the stage is scaled to fit the
 * output (letterboxed only if the shapes differ); without one the whole viewport is captured.
 * A single context is reused across frames so fonts and images are embedded once.
 */
export class FrameRasterizer {
  private context: ScreenshotContext | null = null;
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(
    private readonly doc: Document,
    private readonly clock: VirtualClock,
    private readonly width: number,
    private readonly height: number,
    private readonly stage: HTMLElement | null,
  ) {
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D tidak tersedia.');
    this.ctx = ctx;
  }

  async capture(): Promise<ImageBitmap> {
    // The library waits on real timers (image decode, timeouts); let those through while it runs.
    this.clock.passthrough = true;
    try {
      const node = this.stage ?? this.doc.documentElement;
      const rect = this.stage ? this.stage.getBoundingClientRect() : { width: this.width, height: this.height };
      const scale = this.stage ? Math.min(this.width / rect.width, this.height / rect.height) : 1;
      this.context ??= await createContext(node, {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scale,
        backgroundColor: backgroundOf(this.doc, this.stage),
        timeout: 15_000,
        ...(this.stage ? {} : { style: { margin: '0' } }),
        features: { restoreScrollPosition: true },
        filter: isVisibleNode,
      });
      this.context.sandbox ??= noDefaultStyleSandbox();
      const snapshot = await domToCanvas(this.context);
      // Compose onto the exact output size (centres the stage when its aspect ratio differs).
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.width, this.height);
      const drawWidth = Math.min(this.width, snapshot.width);
      const drawHeight = Math.min(this.height, snapshot.height);
      this.ctx.drawImage(
        snapshot,
        Math.round((this.width - drawWidth) / 2),
        Math.round((this.height - drawHeight) / 2),
        drawWidth,
        drawHeight,
      );
      return this.canvas.transferToImageBitmap();
    } finally {
      this.clock.passthrough = false;
    }
  }

  dispose(): void {
    if (this.context) destroyContext(this.context);
    this.context = null;
  }
}

/** Skips subtrees that cannot be seen (inactive scenes), which keeps each snapshot small and fast. */
function isVisibleNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return true;
  const element = node as Element;
  const view = element.ownerDocument.defaultView;
  if (!view || element.id === '__SANDBOX__h2m') return true;
  const style = view.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

/**
 * modern-screenshot normally diffs computed styles against defaults read from a helper iframe. Inside
 * our opaque-origin sandbox every child frame is cross-origin and unreadable, so we hand it a stub
 * without a window: the library then inlines all computed styles (larger snapshot, same result).
 */
function noDefaultStyleSandbox(): HTMLIFrameElement {
  return { contentWindow: null, remove: () => undefined } as unknown as HTMLIFrameElement;
}

/** Uses the page (or stage) background so transparent documents render like they do in a browser tab. */
function backgroundOf(doc: Document, stage: HTMLElement | null): string {
  const view = doc.defaultView;
  if (!view) return '#ffffff';
  for (const element of [stage, doc.body, doc.documentElement]) {
    if (!element) continue;
    const color = view.getComputedStyle(element).backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
  }
  return '#ffffff';
}
