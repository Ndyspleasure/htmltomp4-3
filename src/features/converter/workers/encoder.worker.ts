/// <reference lib="webworker" />
import { ConverterError, toUserMessage } from '../errors';
import { convertRecording, probeEncoders } from '../export/convert-media';
import { FrameEncoder } from '../export/frame-encoder';
import type { EncoderRequest, EncoderResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const controllers = new Map<number, AbortController>();

interface FrameSession {
  encoder: Promise<FrameEncoder>;
  /** Frames are encoded strictly in order; every operation is chained onto this promise. */
  chain: Promise<void>;
  failed: boolean;
}
const frameSessions = new Map<number, FrameSession>();

function send(message: EncoderResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function sendError(id: number, error: unknown): void {
  const code = error instanceof ConverterError ? error.code : 'encoding-failed';
  send({ type: 'error', id, code, message: toUserMessage(error) });
}

function failSession(id: number, session: FrameSession, error: unknown): void {
  if (session.failed) return;
  session.failed = true;
  frameSessions.delete(id);
  session.encoder.then((encoder) => encoder.cancel()).catch(() => undefined);
  sendError(id, error);
}

self.addEventListener('message', (event: MessageEvent<EncoderRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'cancel': {
      controllers.get(message.id)?.abort();
      const session = frameSessions.get(message.id);
      if (session)
        failSession(message.id, session, new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.'));
      return;
    }
    case 'probe':
      probeEncoders(message.width, message.height).then(
        (support) => send({ type: 'probe-result', id: message.id, support }),
        (error: unknown) => sendError(message.id, error),
      );
      return;
    case 'frames-begin': {
      send({ type: 'progress', id: message.id, stage: 'loading-encoder', fraction: null });
      const encoder = FrameEncoder.create(message.config);
      const session: FrameSession = { encoder, chain: Promise.resolve(), failed: false };
      frameSessions.set(message.id, session);
      session.chain = encoder.then(
        () => send({ type: 'frames-ready', id: message.id }),
        (error: unknown) => failSession(message.id, session, error),
      );
      return;
    }
    case 'frames-add': {
      const session = frameSessions.get(message.id);
      if (!session) {
        message.bitmap.close();
        return;
      }
      session.chain = session.chain.then(async () => {
        if (session.failed) {
          message.bitmap.close();
          return;
        }
        try {
          await (await session.encoder).addFrame(message.bitmap, message.index);
          send({ type: 'frames-ack', id: message.id, index: message.index });
        } catch (error) {
          failSession(message.id, session, error);
        }
      });
      return;
    }
    case 'frames-end': {
      const session = frameSessions.get(message.id);
      if (!session) return;
      session.chain = session.chain.then(async () => {
        if (session.failed) return;
        try {
          send({ type: 'progress', id: message.id, stage: 'encoding', fraction: null });
          const result = await (
            await session.encoder
          ).finish(() => send({ type: 'progress', id: message.id, stage: 'validating', fraction: null }));
          frameSessions.delete(message.id);
          send({ type: 'convert-result', id: message.id, result }, [result.buffer]);
        } catch (error) {
          failSession(message.id, session, error);
        }
      });
      return;
    }
    case 'convert': {
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
    }
  }
});
