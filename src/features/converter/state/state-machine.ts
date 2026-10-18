import type { ConversionStatus } from '../types';

/**
 * Allowed UI status transitions (arsitektur.md §8):
 * idle → validating → preparing-preview → ready-to-record → requesting-permission → recording → processing → completed,
 * with cancelled/error as alternatives. Any state may return to idle (reset/new file).
 */
const AFTER_RUN: readonly ConversionStatus[] = [
  'requesting-permission',
  'processing',
  'preparing-preview',
  'validating',
  'ready-to-record',
];

const TRANSITIONS: Record<ConversionStatus, readonly ConversionStatus[]> = {
  idle: ['validating'],
  validating: ['preparing-preview', 'error'],
  'preparing-preview': ['ready-to-record', 'error'],
  'ready-to-record': ['requesting-permission', 'preparing-preview', 'validating'],
  'requesting-permission': ['recording', 'ready-to-record', 'error'],
  recording: ['processing', 'cancelled', 'error'],
  processing: ['completed', 'cancelled', 'error'],
  completed: AFTER_RUN,
  cancelled: AFTER_RUN,
  error: AFTER_RUN,
};

export function canTransition(from: ConversionStatus, to: ConversionStatus): boolean {
  return to === 'idle' || from === to || TRANSITIONS[from].includes(to);
}

export class StatusMachine {
  private current: ConversionStatus = 'idle';
  private readonly listeners = new Set<(status: ConversionStatus, previous: ConversionStatus) => void>();

  get status(): ConversionStatus {
    return this.current;
  }

  to(next: ConversionStatus): void {
    if (!canTransition(this.current, next)) {
      throw new Error(`Transisi status tidak valid: ${this.current} → ${next}`);
    }
    const previous = this.current;
    this.current = next;
    this.listeners.forEach((listener) => listener(next, previous));
  }

  subscribe(listener: (status: ConversionStatus, previous: ConversionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Which controls are enabled for a status; keeps buttons consistent during transitions. */
export function controlsFor(status: ConversionStatus) {
  const busy = status === 'validating' || status === 'preparing-preview' || status === 'requesting-permission';
  return {
    canPickFile: !busy && status !== 'recording' && status !== 'processing',
    canEditSettings:
      status === 'ready-to-record' || status === 'completed' || status === 'cancelled' || status === 'error',
    canRecord: status === 'ready-to-record' || status === 'completed' || status === 'cancelled' || status === 'error',
    canStop: status === 'recording',
    canCancel: status === 'recording' || status === 'processing',
    canRestartPreview:
      status === 'ready-to-record' || status === 'completed' || status === 'cancelled' || status === 'error',
  };
}
