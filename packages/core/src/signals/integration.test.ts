/**
 * Integration tests for Universal Signaling System
 *
 * Tests the complete signal flow from SmrtClass → SignalBus → Adapters
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import type { Signal, ISignalAdapter } from '@smrt/types';

// Mock custom adapter for testing
class MockAdapter implements ISignalAdapter {
  public signals: Signal[] = [];

  async handle(signal: Signal): Promise<void> {
    this.signals.push(signal);
  }

  reset() {
    this.signals = [];
  }
}

describe('Universal Signaling System - Integration', () => {
  beforeEach(() => {
    // Reset global config before each test
    config.reset();
  });

  afterEach(() => {
    config.reset();
  });

  it('should initialize with default logging enabled', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(1); // LoggerAdapter

    // Clean up signal emission would be tested in actual usage
    consoleSpy.mockRestore();
  });

  it('should disable logging when configured', async () => {
    config({ logging: false });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeUndefined(); // No adapters, so no bus
  });

  it('should enable metrics adapter when configured globally', async () => {
    config({
      logging: false, // Disable logging to isolate metrics
      metrics: { enabled: true },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(1); // MetricsAdapter
  });

  it('should enable pubsub adapter when configured globally', async () => {
    config({
      logging: false,
      pubsub: { enabled: true },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(1); // PubSubAdapter
  });

  it('should support custom adapters via global config', async () => {
    const mockAdapter = new MockAdapter();

    config({
      logging: false,
      signals: {
        adapters: [mockAdapter],
      },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(1); // MockAdapter

    // Emit test signal
    const testSignal: Signal = {
      id: 'test-1',
      objectId: 'obj-1',
      className: 'TestClass',
      method: 'testMethod',
      type: 'start',
      timestamp: Date.now(),
    };

    await instance.signalBus?.emit(testSignal);

    expect(mockAdapter.signals).toHaveLength(1);
    expect(mockAdapter.signals[0]).toMatchObject({
      id: 'test-1',
      type: 'start',
    });
  });

  it('should override global config with instance config', async () => {
    config({
      logging: true, // Global: enabled
      metrics: { enabled: false },
    });

    const mockAdapter = new MockAdapter();

    class TestClass extends SmrtClass {}
    const instance = new TestClass({
      logging: false, // Instance: disabled (overrides global)
      metrics: { enabled: true }, // Instance: enabled (overrides global)
      signals: { adapters: [mockAdapter] },
    });
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(2); // MetricsAdapter + MockAdapter (no LoggerAdapter)
  });

  it('should merge global and instance custom adapters', async () => {
    const globalAdapter = new MockAdapter();
    const instanceAdapter = new MockAdapter();

    config({
      logging: false,
      signals: { adapters: [globalAdapter] },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({
      signals: { adapters: [instanceAdapter] },
    });
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(2); // Both adapters

    // Emit signal to verify both adapters receive it
    const testSignal: Signal = {
      id: 'test-1',
      objectId: 'obj-1',
      className: 'TestClass',
      method: 'testMethod',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    };

    await instance.signalBus?.emit(testSignal);

    expect(globalAdapter.signals).toHaveLength(1);
    expect(instanceAdapter.signals).toHaveLength(1);
  });

  it('should use shared signal bus when provided', async () => {
    // Use a fresh adapter for this test (no global config interference)
    const mockAdapter = new MockAdapter();

    class TestClass extends SmrtClass {}
    const instance1 = new TestClass({
      logging: false,
      signals: { adapters: [mockAdapter] },
    });
    await instance1.initialize();

    class TestClass2 extends SmrtClass {}
    const instance2 = new TestClass2({
      logging: false,
      signals: { bus: instance1.signalBus }, // Share bus from instance1
    });
    await instance2.initialize();

    expect(instance1.signalBus).toBe(instance2.signalBus); // Same bus instance

    // Reset adapter to clear any signals from initialization
    mockAdapter.reset();

    // Emit from different instances, both should go to same adapter
    await instance1.signalBus?.emit({
      id: 'test-1',
      objectId: 'obj-1',
      className: 'TestClass',
      method: 'method1',
      type: 'start',
      timestamp: Date.now(),
    });

    await instance2.signalBus?.emit({
      id: 'test-2',
      objectId: 'obj-2',
      className: 'TestClass2',
      method: 'method2',
      type: 'start',
      timestamp: Date.now(),
    });

    expect(mockAdapter.signals).toHaveLength(2);
  });

  it('should configure with debug log level', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    config({
      logging: { level: 'debug' },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(1);

    consoleSpy.mockRestore();
  });

  it('should enable all adapters when configured', async () => {
    config({
      logging: { level: 'error' }, // Minimal logging
      metrics: { enabled: true },
      pubsub: { enabled: true },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    expect(instance.signalBus).toBeDefined();
    expect(instance.signalBus?.adapterCount).toBe(3); // Logger + Metrics + PubSub
  });

  it('should handle signal emission with error handling', async () => {
    // Adapter that throws errors
    class ErrorAdapter implements ISignalAdapter {
      async handle(): Promise<void> {
        throw new Error('Adapter error');
      }
    }

    const mockAdapter = new MockAdapter();

    config({
      logging: false,
      signals: {
        adapters: [new ErrorAdapter(), mockAdapter],
      },
    });

    class TestClass extends SmrtClass {}
    const instance = new TestClass({});
    await instance.initialize();

    // Should not throw even though ErrorAdapter throws
    await expect(
      instance.signalBus?.emit({
        id: 'test-1',
        objectId: 'obj-1',
        className: 'TestClass',
        method: 'testMethod',
        type: 'error',
        error: new Error('Test error'),
        timestamp: Date.now(),
      }),
    ).resolves.not.toThrow();

    // MockAdapter should still receive signal despite ErrorAdapter failing
    expect(mockAdapter.signals).toHaveLength(1);
  });
});
