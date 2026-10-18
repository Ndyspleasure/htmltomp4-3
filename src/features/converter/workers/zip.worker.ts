/// <reference lib="webworker" />
import { ConverterError, toUserMessage } from '../errors';
import { readZip } from '../import/read-zip';
import type { ZipRequest, ZipResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener('message', (event: MessageEvent<ZipRequest>) => {
  const { id, bytes } = event.data;
  let response: ZipResponse;
  try {
    const result = readZip(new Uint8Array(bytes));
    response = { id, ok: true, result };
    self.postMessage(
      response,
      result.files.map((file) => file.data.buffer as ArrayBuffer),
    );
  } catch (error) {
    response = {
      id,
      ok: false,
      code: error instanceof ConverterError ? error.code : 'zip-invalid',
      message: toUserMessage(error),
    };
    self.postMessage(response);
  }
});
