import { PREVIEW } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { PreviewBundle } from '../types';

export type PreviewEvent =
  | { type: 'loaded'; warnings: string[] }
  | { type: 'runtime-error'; message: string }
  | { type: 'failed'; error: ConverterError };

export interface PreviewController {
  readonly iframe: HTMLIFrameElement;
  /** Resolves when the latest (re)load of the sandbox finished rendering the bundle. */
  readonly ready: Promise<void>;
  /** Reloads the sandbox and replays the bundle, restarting the animation from the beginning. */
  restart(): Promise<void>;
  setViewport(width: number, height: number): void;
  destroy(): void;
}

export interface MountOptions {
  width: number;
  height: number;
  onEvent?: (event: PreviewEvent) => void;
  /** Scale the fixed-size viewport to fit the container (true) or render 1:1 (false). */
  fit?: boolean;
}

/**
 * Renders a preview bundle inside a sandboxed iframe (scripts only, opaque origin). The iframe always has
 * the exact viewport size of the output so layouts match the recording; it is scaled visually to fit.
 */
export function mountPreview(container: HTMLElement, bundle: PreviewBundle, options: MountOptions): PreviewController {
  let width = options.width;
  let height = options.height;
  let destroyed = false;
  let iframe = createFrame();
  let cleanupLoad: () => void = () => undefined;
  const fit = options.fit ?? true;

  const stage = document.createElement('div');
  stage.className = 'h2m-stage';
  stage.style.position = 'relative';
  stage.style.overflow = 'hidden';
  stage.style.margin = '0 auto';
  container.replaceChildren(stage);

  const resizeObserver = new ResizeObserver(() => layout());
  resizeObserver.observe(container);

  function createFrame(): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', PREVIEW.sandboxFlags);
    frame.setAttribute('allow', PREVIEW.allowFeatures);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Preview animasi (terisolasi)');
    frame.setAttribute('loading', 'eager');
    frame.style.border = '0';
    frame.style.position = 'absolute';
    frame.style.top = '0';
    frame.style.left = '0';
    frame.style.transformOrigin = '0 0';
    frame.style.background = '#fff';
    return frame;
  }

  function layout(): void {
    const available = container.clientWidth || width;
    const maxHeight = fit ? container.clientHeight || Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
    const scale = fit ? Math.min(1, available / width, maxHeight > 0 ? maxHeight / height : 1) : 1;
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
    iframe.style.transform = scale === 1 ? '' : `scale(${scale})`;
    stage.style.width = `${Math.floor(width * scale)}px`;
    stage.style.height = `${Math.floor(height * scale)}px`;
  }

  function load(): Promise<void> {
    cleanupLoad();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        finish();
        const error = new ConverterError(
          'preview-failed',
          'Preview tidak merespons. Muat ulang halaman lalu coba lagi.',
        );
        options.onEvent?.({ type: 'failed', error });
        reject(error);
      }, PREVIEW.loaderTimeoutMs);

      const onMessage = (event: MessageEvent) => {
        // Only trust messages from our own sandbox frame. Their content is still treated as untrusted text.
        if (event.source !== iframe.contentWindow) return;
        const data: unknown = event.data;
        if (typeof data !== 'object' || data === null || !('type' in data)) return;
        const type = (data as { type: unknown }).type;
        const message = 'message' in data ? String((data as { message: unknown }).message).slice(0, 300) : '';
        if (type === 'h2m:sandbox-ready') {
          iframe.contentWindow?.postMessage({ type: 'h2m:load', bundle }, '*');
        } else if (type === 'h2m:sandbox-loaded') {
          window.clearTimeout(timer);
          const raw = 'warnings' in data ? (data as { warnings: unknown }).warnings : [];
          const warnings = Array.isArray(raw) ? raw.slice(0, 20).map((w) => String(w).slice(0, 500)) : [];
          options.onEvent?.({ type: 'loaded', warnings });
          resolve();
        } else if (type === 'h2m:sandbox-error') {
          finish();
          const error = new ConverterError('preview-failed', `Preview gagal dimuat: ${message}`);
          options.onEvent?.({ type: 'failed', error });
          reject(error);
        } else if (type === 'h2m:sandbox-runtime-error') {
          options.onEvent?.({ type: 'runtime-error', message });
        }
      };

      function finish() {
        window.clearTimeout(timer);
      }

      window.addEventListener('message', onMessage);
      cleanupLoad = () => {
        finish();
        window.removeEventListener('message', onMessage);
      };
      iframe.src = PREVIEW.sandboxPath;
      if (!iframe.isConnected) stage.append(iframe);
      layout();
    });
  }

  let ready = load();
  ready.catch(() => undefined); // surfaced through onEvent; avoid unhandled rejection noise

  return {
    get iframe() {
      return iframe;
    },
    get ready() {
      return ready;
    },
    restart() {
      if (destroyed) return Promise.resolve();
      const old = iframe;
      iframe = createFrame();
      old.replaceWith(iframe);
      old.src = 'about:blank';
      ready = load();
      ready.catch(() => undefined);
      return ready;
    },
    setViewport(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
      layout();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanupLoad();
      resizeObserver.disconnect();
      iframe.src = 'about:blank';
      stage.remove();
    },
  };
}
