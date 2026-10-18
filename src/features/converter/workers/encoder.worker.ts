/// <reference lib="webworker" />
import { ConverterError, toUserMessage } from '../errors';
import { convertRecording, probeEncoders } from '../export/convert-media';
import type { EncoderRequest, EncoderResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const controllers = new Map<number, AbortController>();

function send(message: EncoderResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function sendError(id: number, error: unknown): void {
  const code = error instanceof ConverterError ? error.code : 'encoding-failed';
  send({ type: 'error', id, code, message: toUserMessage(error) });
}

self.addEventListener('message', (event: MessageEvent<EncoderRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    controllers.get(message.id)?.abort();
    return;
  }
  if (message.type === 'probe') {
    probeEncoders(message.width, message.height).then(
      (support) => send({ type: 'probe-result', id: message.id, support }),
      (error: unknown) => sendError(message.id, error),
    );
    return;
  }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  convertRecording(
    message.request,
    (stage, fraction) => send({ type: 'progress', id: message.id, stage, fraction }),
    controller.signal,
  )
    .then(
      (result) => send({ type: 'convert-result', id: message.id, result }, [result.buffer]),
      (error: unknown) => sendError(message.id, error),
    )
    .finally(() => controllers.delete(message.id));
});
