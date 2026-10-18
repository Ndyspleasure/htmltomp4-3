import { ENCODER_STALL_TIMEOUT_MS } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import type { EncoderRequest, EncoderResponse } from '../workers/protocol';
import type { ConvertRequest, ConvertResult, EncodeStage, EncoderSupport, ProgressCallback } from './convert-media';

export type { ConvertRequest, ConvertResult, EncodeStage, EncoderSupport };

interface Pending {
  resolve: (value: never) => void;
  reject: (error: unknown) => void;
  onProgress?: ProgressCallback;
  stallTimer?: number;
}

/**
 * Main-thread facade for the encoder Web Worker. The worker (and the Mediabunny/WASM code it loads)
 * is created lazily on first use and terminated on dispose(), cancel or stall.
 */
export class EncoderClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  probe(width: number, height: number): Promise<EncoderSupport> {
    return this.call<EncoderSupport>({ type: 'probe', id: 0, width, height });
  }

  convert(request: ConvertRequest, onProgress: ProgressCallback, signal?: AbortSignal): Promise<ConvertResult> {
    return this.call<ConvertResult>({ type: 'convert', id: 0, request }, onProgress, signal);
  }

  dispose(): void {
    this.failAll(new ConverterError('encoding-cancelled', 'Encoder dihentikan.'));
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/encoder.worker.ts', import.meta.url), {
        type: 'module',
        name: 'encoder',
      });
    } catch (error) {
      throw new ConverterError('worker-failed', 'Browser tidak dapat menjalankan Web Worker untuk encoding.', {
        cause: error,
      });
    }
    worker.addEventListener('message', (event: MessageEvent<EncoderResponse>) => this.onMessage(event.data));
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.failAll(
        new ConverterError('worker-failed', `Worker encoder gagal: ${event.message || 'error tidak diketahui'}.`),
      );
      this.worker?.terminate();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private call<T>(message: EncoderRequest, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (value: never) => void, reject };
      if (onProgress) entry.onProgress = onProgress;
      this.pending.set(id, entry);
      this.armStallTimer(id);
      signal?.addEventListener(
        'abort',
        () => {
          worker.postMessage({ type: 'cancel', id } satisfies EncoderRequest);
          // Hard stop if the encoder does not acknowledge the cancel quickly.
          window.setTimeout(() => {
            if (this.pending.has(id)) {
              this.settle(id, new ConverterError('encoding-cancelled', 'Proses konversi dibatalkan.'));
              this.worker?.terminate();
              this.worker = null;
            }
          }, 1500);
        },
        { once: true },
      );
      worker.postMessage({ ...message, id });
    });
  }

  private onMessage(message: EncoderResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    switch (message.type) {
      case 'progress':
        this.armStallTimer(message.id);
        entry.onProgress?.(message.stage, message.fraction);
        break;
      case 'probe-result':
        this.settle(message.id, undefined, message.support);
        break;
      case 'convert-result':
        this.settle(message.id, undefined, message.result);
        break;
      case 'error':
        this.settle(message.id, new ConverterError(message.code, message.message));
        break;
    }
  }

  private armStallTimer(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    window.clearTimeout(entry.stallTimer);
    entry.stallTimer = window.setTimeout(() => {
      this.settle(
        id,
        new ConverterError(
          'encoding-stalled',
          'Encoder tidak merespons terlalu lama. Coba durasi/resolusi lebih kecil.',
        ),
      );
      this.worker?.terminate();
      this.worker = null;
    }, ENCODER_STALL_TIMEOUT_MS);
  }

  private settle(id: number, error?: unknown, value?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    window.clearTimeout(entry.stallTimer);
    this.pending.delete(id);
    if (error) entry.reject(error);
    else entry.resolve(value as never);
  }

  private failAll(error: unknown): void {
    for (const id of [...this.pending.keys()]) this.settle(id, error);
  }
}
