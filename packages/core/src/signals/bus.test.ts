/**
 * Tests for SignalBus
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { SignalBus } from './bus.js';
import type { Signal, ISignalAdapter } from '@have/types';

describe('SignalBus', () => {
  let bus: SignalBus;

  beforeEach(() => {
    bus = new SignalBus();
  });

  it('should register adapters', () => {
    const adapter: ISignalAdapter = {
      async handle(signal: Signal) {},
    };

    bus.register(adapter);
    expect(bus.adapterCount).toBe(1);
  });

  it('should unregister adapters', () => {
    const adapter: ISignalAdapter = {
      async handle(signal: Signal) {},
    };

    bus.register(adapter);
    expect(bus.adapterCount).toBe(1);

    bus.unregister(adapter);
    expect(bus.adapterCount).toBe(0);
  });

  it('should emit signals to registered adapters', async () => {
    const receivedSignals: Signal[] = [];

    const adapter: ISignalAdapter = {
      async handle(signal: Signal) {
        receivedSignals.push(signal);
      },
    };

    bus.register(adapter);

    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'TestClass',
      method: 'testMethod',
      type: 'start',
      timestamp: Date.now(),
    };

    await bus.emit(signal);

    // Wait a bit for async adapter execution
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]).toBe(signal);
  });

  it('should emit signals to multiple adapters', async () => {
    const received1: Signal[] = [];
    const received2: Signal[] = [];

    const adapter1: ISignalAdapter = {
      async handle(signal: Signal) {
        received1.push(signal);
      },
    };

    const adapter2: ISignalAdapter = {
      async handle(signal: Signal) {
        received2.push(signal);
      },
    };

    bus.register(adapter1);
    bus.register(adapter2);

    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'TestClass',
      method: 'testMethod',
      type: 'end',
      timestamp: Date.now(),
    };

    await bus.emit(signal);

    // Wait for async adapter execution
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it('should handle adapter errors gracefully', async () => {
    const errorAdapter: ISignalAdapter = {
      async handle(signal: Signal) {
        throw new Error('Adapter error');
      },
    };

    const workingAdapter: ISignalAdapter = {
      async handle(signal: Signal) {
        // Should still execute even if errorAdapter throws
      },
    };

    bus.register(errorAdapter);
    bus.register(workingAdapter);

    const signal: Signal = {
      id: 'exec-123',
      objectId: 'obj-456',
      className: 'TestClass',
      method: 'testMethod',
      type: 'error',
      timestamp: Date.now(),
    };

    // Should not throw
    await expect(bus.emit(signal)).resolves.toBeUndefined();
  });

  it('should generate unique execution IDs', () => {
    const id1 = bus.generateExecutionId();
    const id2 = bus.generateExecutionId();

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('should clear all adapters', () => {
    const adapter1: ISignalAdapter = {
      async handle(signal: Signal) {},
    };

    const adapter2: ISignalAdapter = {
      async handle(signal: Signal) {},
    };

    bus.register(adapter1);
    bus.register(adapter2);
    expect(bus.adapterCount).toBe(2);

    bus.clear();
    expect(bus.adapterCount).toBe(0);
  });

  it('should support different signal types', async () => {
    const receivedTypes: string[] = [];

    const adapter: ISignalAdapter = {
      async handle(signal: Signal) {
        receivedTypes.push(signal.type);
      },
    };

    bus.register(adapter);

    const signalTypes: Array<'start' | 'step' | 'end' | 'error'> = [
      'start',
      'step',
      'end',
      'error',
    ];

    for (const type of signalTypes) {
      await bus.emit({
        id: `exec-${type}`,
        objectId: 'obj-456',
        className: 'Test',
        method: 'test',
        type,
        timestamp: Date.now(),
      });
    }

    // Wait for all async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receivedTypes).toEqual(['start', 'step', 'end', 'error']);
  });
});
