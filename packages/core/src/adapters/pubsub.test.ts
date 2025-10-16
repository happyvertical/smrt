/**
 * Tests for PubSubAdapter
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { PubSubAdapter } from './pubsub.js';
import type { Signal } from '@have/types';

describe('PubSubAdapter', () => {
  let adapter: PubSubAdapter;

  beforeEach(() => {
    adapter = new PubSubAdapter();
  });

  it('should broadcast signals to subscribers', async () => {
    const received: Signal[] = [];

    adapter.subscribe((signal) => {
      received.push(signal);
    });

    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(signal);
  });

  it('should broadcast to multiple subscribers', async () => {
    const received1: Signal[] = [];
    const received2: Signal[] = [];

    adapter.subscribe((signal) => {
      received1.push(signal);
    });

    adapter.subscribe((signal) => {
      received2.push(signal);
    });

    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it('should apply filters when subscribing', async () => {
    const errorSignals: Signal[] = [];

    adapter.subscribe(
      (signal) => {
        errorSignals.push(signal);
      },
      (signal) => signal.type === 'error',
    );

    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    });

    await adapter.handle({
      id: 'exec-2',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'error',
      error: new Error('Test'),
      timestamp: Date.now(),
    });

    expect(errorSignals).toHaveLength(1);
    expect(errorSignals[0].type).toBe('error');
  });

  it('should allow unsubscribing', async () => {
    const received: Signal[] = [];

    const subId = adapter.subscribe((signal) => {
      received.push(signal);
    });

    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);

    adapter.unsubscribe(subId);

    await adapter.handle({
      id: 'exec-2',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1); // Still only 1
  });

  it('should track subscriber count', () => {
    expect(adapter.subscriberCount).toBe(0);

    const sub1 = adapter.subscribe(() => {});
    expect(adapter.subscriberCount).toBe(1);

    const sub2 = adapter.subscribe(() => {});
    expect(adapter.subscriberCount).toBe(2);

    adapter.unsubscribe(sub1);
    expect(adapter.subscriberCount).toBe(1);

    adapter.unsubscribe(sub2);
    expect(adapter.subscriberCount).toBe(0);
  });

  it('should clear all subscriptions', async () => {
    const received: Signal[] = [];

    adapter.subscribe((signal) => {
      received.push(signal);
    });

    adapter.subscribe((signal) => {
      received.push(signal);
    });

    expect(adapter.subscriberCount).toBe(2);

    adapter.clearSubscriptions();

    expect(adapter.subscriberCount).toBe(0);

    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(0);
  });

  it('should handle subscriber errors gracefully', async () => {
    const received: Signal[] = [];

    // First subscriber throws
    adapter.subscribe(() => {
      throw new Error('Subscriber error');
    });

    // Second subscriber should still receive signal
    adapter.subscribe((signal) => {
      received.push(signal);
    });

    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(received).toHaveLength(1);
  });

  describe('Static filter helpers', () => {
    it('should filter by class', async () => {
      const received: Signal[] = [];

      adapter.subscribe((signal) => {
        received.push(signal);
      }, PubSubAdapter.filterByClass('Product'));

      await adapter.handle({
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-2',
        objectId: 'obj-2',
        className: 'Category',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].className).toBe('Product');
    });

    it('should filter by method', async () => {
      const received: Signal[] = [];

      adapter.subscribe((signal) => {
        received.push(signal);
      }, PubSubAdapter.filterByMethod('analyze'));

      await adapter.handle({
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-2',
        objectId: 'obj-1',
        className: 'Product',
        method: 'validate',
        type: 'start',
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('analyze');
    });

    it('should filter by type', async () => {
      const received: Signal[] = [];

      adapter.subscribe((signal) => {
        received.push(signal);
      }, PubSubAdapter.filterByType('error'));

      await adapter.handle({
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-2',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'error',
        error: new Error('Test'),
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('error');
    });

    it('should filter by class and method', async () => {
      const received: Signal[] = [];

      adapter.subscribe(
        (signal) => {
          received.push(signal);
        },
        PubSubAdapter.filterByClassAndMethod('Product', 'analyze'),
      );

      await adapter.handle({
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-2',
        objectId: 'obj-1',
        className: 'Product',
        method: 'validate',
        type: 'start',
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-3',
        objectId: 'obj-2',
        className: 'Category',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].className).toBe('Product');
      expect(received[0].method).toBe('analyze');
    });

    it('should combine multiple filters', async () => {
      const received: Signal[] = [];

      const filter = PubSubAdapter.combineFilters(
        PubSubAdapter.filterByClass('Product'),
        PubSubAdapter.filterByType('error'),
      );

      adapter.subscribe((signal) => {
        received.push(signal);
      }, filter);

      await adapter.handle({
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'start',
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-2',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
        type: 'error',
        error: new Error('Test'),
        timestamp: Date.now(),
      });

      await adapter.handle({
        id: 'exec-3',
        objectId: 'obj-2',
        className: 'Category',
        method: 'analyze',
        type: 'error',
        error: new Error('Test'),
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].className).toBe('Product');
      expect(received[0].type).toBe('error');
    });
  });

  it('should support async subscribers', async () => {
    const received: Signal[] = [];

    adapter.subscribe(async (signal) => {
      // Simulate async operation
      await new Promise((resolve) => setTimeout(resolve, 10));
      received.push(signal);
    });

    await adapter.handle({
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
  });
});
