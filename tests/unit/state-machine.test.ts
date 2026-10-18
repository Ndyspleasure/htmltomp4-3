import { describe, expect, it } from 'vitest';
import { StatusMachine, canTransition, controlsFor } from '../../src/features/converter/state/state-machine';

describe('status machine', () => {
  it('follows the documented happy path', () => {
    const machine = new StatusMachine();
    const seen: string[] = [];
    machine.subscribe((status) => seen.push(status));
    for (const s of [
      'validating',
      'preparing-preview',
      'ready-to-record',
      'requesting-permission',
      'recording',
      'processing',
      'completed',
    ] as const) {
      machine.to(s);
    }
    expect(seen).toEqual([
      'validating',
      'preparing-preview',
      'ready-to-record',
      'requesting-permission',
      'recording',
      'processing',
      'completed',
    ]);
  });

  it('rejects skipping steps', () => {
    expect(canTransition('idle', 'recording')).toBe(false);
    expect(canTransition('ready-to-record', 'completed')).toBe(false);
    expect(() => new StatusMachine().to('processing')).toThrow(/tidak valid/);
  });

  it('allows reset to idle from anywhere and recovery after error/cancel', () => {
    expect(canTransition('recording', 'idle')).toBe(true);
    expect(canTransition('error', 'requesting-permission')).toBe(true);
    expect(canTransition('cancelled', 'processing')).toBe(true);
    expect(canTransition('completed', 'validating')).toBe(true);
  });

  it('exposes consistent controls per status', () => {
    expect(controlsFor('recording')).toMatchObject({
      canStop: true,
      canCancel: true,
      canRecord: false,
      canPickFile: false,
    });
    expect(controlsFor('processing')).toMatchObject({ canStop: false, canCancel: true, canEditSettings: false });
    expect(controlsFor('ready-to-record')).toMatchObject({ canRecord: true, canEditSettings: true, canPickFile: true });
    expect(controlsFor('validating').canPickFile).toBe(false);
  });
});
