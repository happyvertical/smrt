/**
 * Tests for Signal and ISignalAdapter types
 */

import { describe, expect, it } from 'vitest';
import type { Signal, SignalType, ISignalAdapter } from './signals.js';

describe('Signal Types', () => {
  it('should allow creating valid Signal objects', () => {
    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'TestClass',
      method: 'testMethod',
      type: 'start',
      timestamp: Date.now(),
    };

    expect(signal.id).toBe('exec-123');
    expect(signal.type).toBe('start');
  });

  it('should support all signal types', () => {
    const types: SignalType[] = ['start', 'step', 'end', 'error'];

    for (const type of types) {
      const signal: Signal = {
        id: 'exec-123',
        objectId: 'obj-456',
        className: 'Test',
        method: 'test',
        type,
        timestamp: Date.now(),
      };

      expect(signal.type).toBe(type);
    }
  });

  it('should support optional fields', () => {
    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'Test',
      method: 'test',
      type: 'end',
      timestamp: Date.now(),
      step: 'validation',
      args: [1, 'test', { key: 'value' }],
      result: { success: true },
      duration: 100,
      metadata: { traceId: 'trace-123' },
    };

    expect(signal.step).toBe('validation');
    expect(signal.args).toHaveLength(3);
    expect(signal.result).toEqual({ success: true });
    expect(signal.duration).toBe(100);
    expect(signal.metadata?.traceId).toBe('trace-123');
  });

  it('should support error signals', () => {
    const error = new Error('Test error');
    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'Test',
      method: 'test',
      type: 'error',
      timestamp: Date.now(),
      error,
      duration: 50,
    };

    expect(signal.type).toBe('error');
    expect(signal.error).toBe(error);
    expect(signal.duration).toBe(50);
  });
});

describe('ISignalAdapter Interface', () => {
  it('should allow implementing signal adapters', async () => {
    const receivedSignals: Signal[] = [];

    const adapter: ISignalAdapter = {
      async handle(signal: Signal): Promise<void> {
        receivedSignals.push(signal);
      },
    };

    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'Test',
      method: 'test',
      type: 'start',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]).toBe(signal);
  });

  it('should support async adapter implementations', async () => {
    let handledCount = 0;

    const adapter: ISignalAdapter = {
      async handle(signal: Signal): Promise<void> {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        handledCount++;
      },
    };

    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'Test',
      method: 'test',
      type: 'end',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);
    expect(handledCount).toBe(1);
  });
});
