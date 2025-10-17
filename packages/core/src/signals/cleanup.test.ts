/**
 * Tests for cleanup and memory leak prevention
 */

import type { SignalAdapter, Signal } from '@smrt/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import { SignalBus } from './bus.js';

// Mock adapter for testing
class TestAdapter implements SignalAdapter {
  public signals: Signal[] = [];

  async handle(signal: Signal): Promise<void> {
    this.signals.push(signal);
  }

  reset() {
    this.signals = [];
  }
}

describe('Cleanup and Memory Leak Prevention', () => {
  beforeEach(() => {
    config.reset();
  });

  afterEach(() => {
    config.reset();
  });

  describe('SignalBus Cleanup', () => {
    it('should unregister individual adapters', () => {
      const bus = new SignalBus();
      const adapter1 = new TestAdapter();
      const adapter2 = new TestAdapter();

      bus.register(adapter1);
      bus.register(adapter2);
      expect(bus.adapterCount).toBe(2);

      const removed = bus.unregister(adapter1);
      expect(removed).toBe(true);
      expect(bus.adapterCount).toBe(1);

      // Verify only adapter2 remains
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
      };

      bus.emit(signal);

      // Wait for async emit
      setTimeout(() => {
        expect(adapter1.signals).toHaveLength(0); // Unregistered, no signal
        expect(adapter2.signals).toHaveLength(1); // Still registered
      }, 10);
    });

    it('should return false when unregistering non-existent adapter', () => {
      const bus = new SignalBus();
      const adapter = new TestAdapter();

      const removed = bus.unregister(adapter);
      expect(removed).toBe(false);
    });

    it('should clear all adapters', () => {
      const bus = new SignalBus();
      const adapter1 = new TestAdapter();
      const adapter2 = new TestAdapter();
      const adapter3 = new TestAdapter();

      bus.register(adapter1);
      bus.register(adapter2);
      bus.register(adapter3);
      expect(bus.adapterCount).toBe(3);

      bus.clear();
      expect(bus.adapterCount).toBe(0);
    });

    it('should not emit signals after clearing adapters', async () => {
      const bus = new SignalBus();
      const adapter = new TestAdapter();

      bus.register(adapter);

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
      };

      await bus.emit(signal);
      expect(adapter.signals).toHaveLength(1);

      bus.clear();

      await bus.emit(signal);
      // Should still have only 1 signal (not 2)
      expect(adapter.signals).toHaveLength(1);
    });
  });

  describe('SmrtClass Cleanup', () => {
    it('should clean up registered adapters on destroy', async () => {
      const adapter = new TestAdapter();

      config({
        logging: false,
        signals: { adapters: [adapter] },
      });

      class TestClass extends SmrtClass {}
      const instance = new TestClass({});
      await instance.initialize();

      expect(instance.signalBus).toBeDefined();
      expect(instance.signalBus?.adapterCount).toBe(1);

      instance.destroy();

      // Adapter should be unregistered
      expect(instance.signalBus?.adapterCount).toBe(0);
    });

    it('should only clean up own adapters, not shared bus adapters', async () => {
      const sharedBus = new SignalBus();
      const sharedAdapter = new TestAdapter();
      sharedBus.register(sharedAdapter);

      class TestClass extends SmrtClass {}
      const instance = new TestClass({
        logging: false,
        signals: { bus: sharedBus },
      });
      await instance.initialize();

      expect(instance.signalBus).toBe(sharedBus);
      expect(sharedBus.adapterCount).toBe(1);

      instance.destroy();

      // Shared bus adapters should NOT be unregistered
      expect(sharedBus.adapterCount).toBe(1);
    });

    it('should handle destroy() when no signal bus exists', () => {
      class TestClass extends SmrtClass {}
      const instance = new TestClass({
        logging: false,
      });

      // Should not throw
      expect(() => instance.destroy()).not.toThrow();
    });

    it('should allow multiple destroy() calls', async () => {
      const adapter = new TestAdapter();

      config({
        logging: false,
        signals: { adapters: [adapter] },
      });

      class TestClass extends SmrtClass {}
      const instance = new TestClass({});
      await instance.initialize();

      instance.destroy();
      instance.destroy(); // Second call should not throw

      expect(instance.signalBus?.adapterCount).toBe(0);
    });
  });

  describe('Memory Leak Prevention', () => {
    it('should prevent adapter accumulation across instances', async () => {
      const globalAdapter = new TestAdapter();

      config({
        logging: false,
        signals: { adapters: [globalAdapter] },
      });

      class TestClass extends SmrtClass {}

      // Create and destroy multiple instances
      for (let i = 0; i < 5; i++) {
        const instance = new TestClass({});
        await instance.initialize();
        expect(instance.signalBus?.adapterCount).toBe(1); // Only global adapter
        instance.destroy();
      }

      // Global adapter should not accumulate
      // Create new instance to verify
      const finalInstance = new TestClass({});
      await finalInstance.initialize();
      expect(finalInstance.signalBus?.adapterCount).toBe(1);
      finalInstance.destroy();
    });

    it('should clean up instance-specific adapters', async () => {
      const instanceAdapter1 = new TestAdapter();
      const instanceAdapter2 = new TestAdapter();

      class TestClass extends SmrtClass {}

      const instance1 = new TestClass({
        logging: false,
        signals: { adapters: [instanceAdapter1] },
      });
      await instance1.initialize();

      const instance2 = new TestClass({
        logging: false,
        signals: { adapters: [instanceAdapter2] },
      });
      await instance2.initialize();

      expect(instance1.signalBus?.adapterCount).toBe(1);
      expect(instance2.signalBus?.adapterCount).toBe(1);

      instance1.destroy();

      // instance1's adapter should be cleaned up
      expect(instance1.signalBus?.adapterCount).toBe(0);
      // instance2's adapter should be unaffected
      expect(instance2.signalBus?.adapterCount).toBe(1);

      instance2.destroy();
    });

    it('should handle complex adapter configurations', async () => {
      const globalAdapter = new TestAdapter();
      const instanceAdapter = new TestAdapter();

      config({
        logging: false,
        signals: { adapters: [globalAdapter] },
      });

      class TestClass extends SmrtClass {}
      const instance = new TestClass({
        signals: { adapters: [instanceAdapter] },
      });
      await instance.initialize();

      // Should have both global and instance adapters
      expect(instance.signalBus?.adapterCount).toBe(2);

      instance.destroy();

      // Both should be unregistered (own bus)
      expect(instance.signalBus?.adapterCount).toBe(0);
    });
  });

  describe('Adapter Lifecycle', () => {
    it('should track all registered adapters for cleanup', async () => {
      const consoleSpy = vi
        .spyOn(console, 'debug')
        .mockImplementation(() => {});

      config({
        logging: { level: 'debug' },
        metrics: { enabled: true },
      });

      class TestClass extends SmrtClass {}
      const instance = new TestClass({});
      await instance.initialize();

      // Should have LoggerAdapter + MetricsAdapter
      expect(instance.signalBus?.adapterCount).toBe(2);

      instance.destroy();

      // All adapters should be cleaned up
      expect(instance.signalBus?.adapterCount).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should not affect other instances when cleaning up', async () => {
      const adapter1 = new TestAdapter();
      const adapter2 = new TestAdapter();

      config({ logging: false });

      class TestClass extends SmrtClass {}

      const instance1 = new TestClass({
        signals: { adapters: [adapter1] },
      });
      await instance1.initialize();

      const instance2 = new TestClass({
        signals: { adapters: [adapter2] },
      });
      await instance2.initialize();

      // Emit signal to both
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
      };

      await instance1.signalBus?.emit(signal);
      await instance2.signalBus?.emit(signal);

      expect(adapter1.signals).toHaveLength(1);
      expect(adapter2.signals).toHaveLength(1);

      // Clean up instance1
      instance1.destroy();

      // Emit again - only instance2 should receive
      const signal2: Signal = {
        ...signal,
        id: 'test-2',
      };

      await instance1.signalBus?.emit(signal2);
      await instance2.signalBus?.emit(signal2);

      // instance1 adapter should not receive new signal
      expect(adapter1.signals).toHaveLength(1);
      // instance2 adapter should receive new signal
      expect(adapter2.signals).toHaveLength(2);

      instance2.destroy();
    });
  });
});
