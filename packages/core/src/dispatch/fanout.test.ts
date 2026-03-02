/**
 * Tests for fan-out delivery mode in DispatchBus
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatchBus, type DispatchBus } from './bus.js';
import type { DispatchMetadata } from './types.js';

describe('Fan-out Delivery', () => {
  let bus: DispatchBus;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-dispatch-fanout-${randomUUID().slice(0, 8)}.db`,
    );
    bus = await createDispatchBus({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (error) {
        console.warn('Failed to cleanup test database:', dbPath, error);
      }
    }
  });

  it('should create per-subscriber dispatch copies for fanout subscribers', async () => {
    // Subscribe three agents with fanout delivery
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Inventory',
      delivery: 'fanout',
    });
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Billing',
      delivery: 'fanout',
    });
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Notification',
      delivery: 'fanout',
    });

    await bus.emit(
      'order.placed',
      { orderId: 'ord-123', total: 99.99 },
      { source: 'Checkout' },
    );

    // Each fanout subscriber should be able to process independently
    const inventoryEvents: DispatchMetadata[] = [];
    const inventoryProcessed = await bus.process(
      'Inventory',
      async (_payload, metadata) => {
        inventoryEvents.push(metadata);
      },
    );

    const billingEvents: DispatchMetadata[] = [];
    const billingProcessed = await bus.process(
      'Billing',
      async (_payload, metadata) => {
        billingEvents.push(metadata);
      },
    );

    const notificationEvents: DispatchMetadata[] = [];
    const notificationProcessed = await bus.process(
      'Notification',
      async (_payload, metadata) => {
        notificationEvents.push(metadata);
      },
    );

    expect(inventoryProcessed).toBe(1);
    expect(billingProcessed).toBe(1);
    expect(notificationProcessed).toBe(1);

    expect(inventoryEvents[0].type).toBe('order.placed');
    expect(billingEvents[0].type).toBe('order.placed');
    expect(notificationEvents[0].type).toBe('order.placed');
  });

  it('should preserve at-most-once delivery for compete subscribers', async () => {
    // Subscribe with default compete delivery
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Inventory',
      delivery: 'compete',
    });
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Billing',
      delivery: 'compete',
    });

    await bus.emit(
      'order.placed',
      { orderId: 'ord-456' },
      { source: 'Checkout' },
    );

    // First subscriber claims the dispatch
    const inventoryProcessed = await bus.process('Inventory', async () => {});
    expect(inventoryProcessed).toBe(1);

    // Second subscriber finds nothing (dispatch already claimed)
    const billingProcessed = await bus.process('Billing', async () => {});
    expect(billingProcessed).toBe(0);
  });

  it('should handle mixed compete and fanout subscribers correctly', async () => {
    // Fanout subscribers each get their own copy
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Logger',
      delivery: 'fanout',
    });
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Analytics',
      delivery: 'fanout',
    });

    // Compete subscribers share a single dispatch
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Inventory',
      delivery: 'compete',
    });
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Billing',
      delivery: 'compete',
    });

    await bus.emit(
      'order.placed',
      { orderId: 'ord-789' },
      { source: 'Checkout' },
    );

    // Both fanout subscribers process independently
    const loggerProcessed = await bus.process('Logger', async () => {});
    const analyticsProcessed = await bus.process('Analytics', async () => {});
    expect(loggerProcessed).toBe(1);
    expect(analyticsProcessed).toBe(1);

    // First compete subscriber claims the shared dispatch
    const inventoryProcessed = await bus.process('Inventory', async () => {});
    expect(inventoryProcessed).toBe(1);

    // Second compete subscriber finds nothing
    const billingProcessed = await bus.process('Billing', async () => {});
    expect(billingProcessed).toBe(0);
  });

  it('should create dispatch with null target when no subscriptions exist', async () => {
    // No subscriptions — dispatch should still be created
    const dispatch = await bus.emit(
      'unsubscribed.event',
      { data: 'test' },
      { source: 'Test' },
    );

    expect(dispatch).toBeDefined();
    expect(dispatch.type).toBe('unsubscribed.event');

    const pending = await bus.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].targetSubscriber).toBeNull();
  });

  it('should handle fanout with wildcard subscriptions', async () => {
    await bus.subscribe({
      signalType: 'campaign.*',
      subscriber: 'Monitor',
      delivery: 'fanout',
    });
    await bus.subscribe({
      signalType: 'campaign.*',
      subscriber: 'Auditor',
      delivery: 'fanout',
    });

    await bus.emit('campaign.completed', { id: '1' }, { source: 'Suasor' });

    const monitorProcessed = await bus.process('Monitor', async () => {});
    const auditorProcessed = await bus.process('Auditor', async () => {});

    expect(monitorProcessed).toBe(1);
    expect(auditorProcessed).toBe(1);
  });

  it('should isolate fanout dispatches between subscribers', async () => {
    await bus.subscribe({
      signalType: 'task.done',
      subscriber: 'AgentA',
      delivery: 'fanout',
    });
    await bus.subscribe({
      signalType: 'task.done',
      subscriber: 'AgentB',
      delivery: 'fanout',
    });

    await bus.emit('task.done', { taskId: '1' }, { source: 'Scheduler' });

    // AgentA processes its copy
    const agentAEvents: DispatchMetadata[] = [];
    await bus.process('AgentA', async (_payload, metadata) => {
      agentAEvents.push(metadata);
    });
    expect(agentAEvents).toHaveLength(1);

    // AgentB still has its own pending copy
    const agentBEvents: DispatchMetadata[] = [];
    await bus.process('AgentB', async (_payload, metadata) => {
      agentBEvents.push(metadata);
    });
    expect(agentBEvents).toHaveLength(1);

    // Both dispatches are different records (different IDs)
    expect(agentAEvents[0].id).not.toBe(agentBEvents[0].id);
  });
});
