import { PREVIEW } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { PreviewBundle } from '../types';
import type { AppToSandbox, CapturedAudio, SandboxMode, SandboxToApp } from './sandbox-protocol';

type AnalyzeResult = Extract<SandboxToApp, { type: 'h2m:analyze-result' }>;

export interface RenderFrameHandle {
  analyze(options: Omit<Extract<AppToSandbox, { type: 'h2m:analyze' }>, 'type'>): Promise<AnalyzeResult>;
  /** Streams frames to `onFrame`; each frame is acknowledged after `onFrame` resolves (backpressure). */
  render(
    options: Omit<Extract<AppToSandbox, { type: 'h2m:render' }>, 'type'>,
    onFrame: (bitmap: ImageBitmap, index: number) => Promise<void>,
  ): Promise<number>;
  /** Audio mode only: plays in real time and returns the recorded Web Audio output. */
  recordAudio(options: Omit<Extract<AppToSandbox, { type: 'h2m:record-audio' }>, 'type'>): Promise<CapturedAudio[]>;
  cancel(): void;
  destroy(): void;
}

/**
 * Loads the bundle into an invisible sandboxed iframe in render mode (virtual clock). The iframe keeps
 * the exact output viewport size and stays inside the page viewport (scaled down, transparent) so lazy
 * images still load.
 */
export async function openRenderFrame(
  bundle: PreviewBundle,
  width: number,
  height: number,
  mode: Exclude<SandboxMode, 'preview'> = 'render',
): Promise<RenderFrameHandle> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', PREVIEW.sandboxFlags);
  iframe.setAttribute('allow', PREVIEW.allowFeatures);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.title = 'Render animasi (tersembunyi)';
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    border: '0',
    transform: 'scale(0.05)',
    transformOrigin: '0 0',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '-1',
  });

  const listeners = new Set<(message: SandboxToApp) => void>();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || typeof event.data !== 'object' || event.data === null) return;
    listeners.forEach((listener) => listener(event.data as SandboxToApp));
  };
  window.addEventListener('message', onMessage);
  const send = (message: AppToSandbox) => iframe.contentWindow?.postMessage(message, '*');
  const destroy = () => {
    window.removeEventListener('message', onMessage);
    listeners.clear();
    iframe.src = 'about:blank';
    iframe.remove();
  };

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      listeners.delete(listener);
      reject(new ConverterError('preview-failed', 'Sandbox render tidak merespons.'));
    }, PREVIEW.loaderTimeoutMs);
    const listener = (message: SandboxToApp) => {
      if (message.type === 'h2m:sandbox-ready') send({ type: 'h2m:load', bundle, mode });
      else if (message.type === 'h2m:sandbox-loaded' || message.type === 'h2m:sandbox-error') {
        window.clearTimeout(timer);
        listeners.delete(listener);
        if (message.type === 'h2m:sandbox-error')
          reject(new ConverterError('preview-failed', `Render gagal dimuat: ${message.message}`));
        else resolve();
      }
    };
    listeners.add(listener);
    iframe.src = PREVIEW.sandboxPath;
    document.body.append(iframe);
  }).catch((error: unknown) => {
    destroy();
    throw error;
  });

  const awaitMessage = <T extends SandboxToApp['type']>(
    type: T,
    onOther?: (message: SandboxToApp) => void,
  ): Promise<Extract<SandboxToApp, { type: T }>> =>
    new Promise((resolve, reject) => {
      const listener = (message: SandboxToApp) => {
        if (message.type === type) {
          listeners.delete(listener);
          resolve(message as Extract<SandboxToApp, { type: T }>);
        } else if (message.type === 'h2m:render-error') {
          listeners.delete(listener);
          reject(new ConverterError('encoding-failed', `Render frame gagal: ${String(message.message).slice(0, 300)}`));
        } else {
          onOther?.(message);
        }
      };
      listeners.add(listener);
    });

  return {
    analyze(options) {
      const result = awaitMessage('h2m:analyze-result');
      send({ type: 'h2m:analyze', ...options });
      return result;
    },
    async render(options, onFrame) {
      let chain = Promise.resolve();
      let failure: unknown = null;
      const done = awaitMessage('h2m:render-done', (message) => {
        if (message.type !== 'h2m:render-frame') return;
        const { bitmap, index } = message;
        chain = chain.then(async () => {
          if (failure) {
            bitmap.close();
            return;
          }
          try {
            await onFrame(bitmap, index);
            send({ type: 'h2m:render-ack', index });
          } catch (error) {
            failure = error;
            send({ type: 'h2m:render-cancel' });
          }
        });
      });
      send({ type: 'h2m:render', ...options });
      const finished = await Promise.race([
        done,
        // Surface encoder failures even while the sandbox is still producing frames.
        new Promise<never>((_, reject) => {
          const poll = window.setInterval(() => {
            if (failure) {
              window.clearInterval(poll);
              reject(failure);
            }
          }, 100);
          done.finally(() => window.clearInterval(poll)).catch(() => undefined);
        }),
      ]);
      await chain;
      if (failure) throw failure;
      return finished.frames;
    },
    async recordAudio(options) {
      const result = awaitMessage('h2m:audio-result');
      send({ type: 'h2m:record-audio', ...options });
      return (await result).captures;
    },
    cancel() {
      send({ type: 'h2m:render-cancel' });
    },
    destroy,
  };
}
