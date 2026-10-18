import { setCaptureHandle } from '../capture/display-capture';
import { toUserMessage } from '../errors';
import { mountPreview, type PreviewController } from '../preview/mount-preview';
import type { OpenerToPreview, PreviewToOpener } from './window-protocol';

/**
 * Runs in the /preview window. It is a trusted page that only hosts the sandboxed preview iframe at the
 * output resolution so the user can pick this tab in the screen-capture dialog.
 */
export function initPreviewWindow(doc: Document): void {
  const host = doc.querySelector<HTMLElement>('[data-el="window-host"]');
  const status = doc.querySelector<HTMLElement>('[data-el="window-status"]');
  const opener = window.opener as Window | null;
  if (!host || !status) return;
  if (!opener) {
    status.textContent = 'Halaman ini dibuka dari tombol "Buka jendela preview" di halaman converter.';
    return;
  }

  let controller: PreviewController | null = null;
  const send = (message: PreviewToOpener) => opener.postMessage(message, location.origin);

  window.addEventListener('message', (event: MessageEvent<OpenerToPreview>) => {
    if (event.origin !== location.origin || event.source !== opener) return;
    const message = event.data;
    if (message.type === 'h2m:preview-init') {
      controller?.destroy();
      doc.title = message.title;
      setCaptureHandle(message.handle);
      status.remove();
      controller = mountPreview(host, message.bundle, {
        width: message.width,
        height: message.height,
        onEvent: (previewEvent) => {
          if (previewEvent.type === 'failed')
            send({ type: 'h2m:preview-error', message: toUserMessage(previewEvent.error) });
        },
      });
      // mountPreview loads immediately; report readiness after the sandbox confirms.
      controller.ready.then(
        async () => send({ type: 'h2m:preview-ready', cropTarget: await createCropTarget(host) }),
        (error: unknown) => send({ type: 'h2m:preview-error', message: toUserMessage(error) }),
      );
    } else if (message.type === 'h2m:preview-restart' && controller) {
      controller.restart().then(
        () => send({ type: 'h2m:preview-restarted' }),
        (error: unknown) => send({ type: 'h2m:preview-error', message: toUserMessage(error) }),
      );
    } else if (message.type === 'h2m:preview-resize' && controller) {
      controller.setViewport(message.width, message.height);
    }
  });

  window.addEventListener('pagehide', () => controller?.destroy());
  send({ type: 'h2m:preview-hello' });
}

/** Region Capture target for the preview stage, so the converter can crop away letterboxing (Chromium only). */
async function createCropTarget(host: HTMLElement): Promise<unknown> {
  const stage = host.querySelector('.h2m-stage');
  const cropTarget = (window as unknown as { CropTarget?: { fromElement(el: Element): Promise<unknown> } }).CropTarget;
  if (!stage || !cropTarget) return undefined;
  try {
    return await cropTarget.fromElement(stage);
  } catch {
    return undefined;
  }
}
