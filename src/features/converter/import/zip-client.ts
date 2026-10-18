import { ConverterError } from '../errors';
import type { ZipRequest, ZipResponse } from '../workers/protocol';
import { readZip, type ZipReadResult } from './read-zip';

/**
 * Extracts a ZIP inside a short-lived Web Worker so large archives do not freeze the UI.
 * Falls back to the main thread when module workers are unavailable.
 */
export function readZipInWorker(bytes: Uint8Array): Promise<ZipReadResult> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/zip.worker.ts', import.meta.url), { type: 'module', name: 'zip' });
  } catch {
    return Promise.resolve().then(() => readZip(bytes));
  }
  return new Promise<ZipReadResult>((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.addEventListener('message', (event: MessageEvent<ZipResponse>) => {
      finish();
      const response = event.data;
      if (response.ok) resolve(response.result);
      else reject(new ConverterError(response.code, response.message));
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      finish();
      reject(new ConverterError('worker-failed', 'Gagal membaca ZIP di worker.'));
    });
    const copy = bytes.slice().buffer;
    worker.postMessage({ id: 1, bytes: copy } satisfies ZipRequest, [copy]);
  });
}
