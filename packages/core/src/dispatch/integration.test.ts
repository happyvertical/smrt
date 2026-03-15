/**
 * Integration Tests for DispatchBus - Agent-to-Agent Communication
 *
 * These tests simulate real-world scenarios where multiple agents
 * communicate through the dispatch system.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatchBus, type DispatchBus } from './bus.js';
import type { DispatchMetadata } from './types.js';

describe('Agent-to-Agent Communication', () => {
  let bus: DispatchBus;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-dispatch-integration-${randomUUID().slice(0, 8)}.db`,
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
        // Log cleanup errors but don't fail tests
        console.warn('Failed to cleanup test database:', dbPath, error);
      }
    }
  });

  it('should enable Suasor to notify Fiscus of completed campaigns', async () => {
    // Fiscus subscribes to campaign events
    await bus.subscribe({
      signalType: 'campaign.completed',
      subscriber: 'Fiscus',
      handler: 'handleCampaignRevenue',
    });

    // Suasor completes a campaign and emits event
    await bus.emit(
      'campaign.completed',
      {
        campaignId: 'camp-123',
        revenue: 5000.0,
        impressions: 100000,
        clicks: 2500,
      },
      { source: 'Suasor', sourceId: 'suasor-instance-1' },
    );

    // Verify dispatch was created
    const pending = await bus.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('campaign.completed');
    expect(pending[0].source).toBe('Suasor');

    // Fiscus processes the dispatch
    const receivedEvents: { payload: unknown; metadata: DispatchMetadata }[] =
      [];
    const processed = await bus.process('Fiscus', async (payload, metadata) => {
      receivedEvents.push({ payload, metadata });
    });

    expect(processed).toBe(1);
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].metadata.type).toBe('campaign.completed');
    expect(receivedEvents[0].payload).toEqual({
      campaignId: 'camp-123',
      revenue: 5000.0,
      impressions: 100000,
      clicks: 2500,
    });

    // Verify dispatch is now completed
    const completed = await bus.list({ status: 'completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].processedBy).toBe('Fiscus');
  });

  it('should support wildcard subscriptions for event families', async () => {
    // Monitor agent subscribes to all campaign events
    await bus.subscribe({
      signalType: 'campaign.*',
      subscriber: 'Monitor',
    });

    // Various campaign events
    await bus.emit('campaign.started', { id: '1' }, { source: 'Suasor' });
    await bus.emit('campaign.paused', { id: '1' }, { source: 'Suasor' });
    await bus.emit('campaign.resumed', { id: '1' }, { source: 'Suasor' });
    await bus.emit('campaign.completed', { id: '1' }, { source: 'Suasor' });

    // Also emit unrelated event
    await bus.emit('invoice.created', { id: '99' }, { source: 'Fiscus' });

    const events: string[] = [];
    await bus.process('Monitor', async (_payload, metadata) => {
      events.push(metadata.type);
    });

    // Should have processed only campaign events
    expect(events).toHaveLength(4);
    expect(events).toContain('campaign.started');
    expect(events).toContain('campaign.paused');
    expect(events).toContain('campaign.resumed');
    expect(events).toContain('campaign.completed');
    expect(events).not.toContain('invoice.created');
  });

  it('should handle processing failures and retries', async () => {
    await bus.subscribe({
      signalType: 'task.execute',
      subscriber: 'Worker',
    });

    await bus.emit(
      'task.execute',
      { taskId: 'task-1' },
      { source: 'Scheduler' },
    );

    // First attempt fails
    let attempts = 0;
    await bus.process('Worker', async () => {
      attempts++;
      throw new Error('Temporary failure');
    });

    // Verify it's marked as failed
    const failed = await bus.list({ status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0].attempts).toBe(1);

    // Retry the failed dispatch
    await bus.retry({ maxAttempts: 3 });

    // Second attempt succeeds
    await bus.process('Worker', async () => {
      attempts++;
      // Success this time
    });

    const completed = await bus.list({ status: 'completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].attempts).toBe(2);
  });

  it('should support multiple subscribers to the same event', async () => {
    // Multiple agents subscribe to the same event
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Inventory',
    });
    await bus.subscribe({ signalType: 'order.placed', subscriber: 'Billing' });
    await bus.subscribe({
      signalType: 'order.placed',
      subscriber: 'Notification',
    });

    await bus.emit(
      'order.placed',
      { orderId: 'ord-123', total: 99.99 },
      { source: 'Checkout' },
    );

    // First subscriber processes the dispatch
    const inventoryProcessed = await bus.process('Inventory', async () => {});
    expect(inventoryProcessed).toBe(1);

    // Dispatch is now completed - subsequent subscribers won't find pending dispatches
    // This is "at-most-once" delivery: the first subscriber to process claims the dispatch
    const billingProcessed = await bus.process('Billing', async () => {});
    const notificationProcessed = await bus.process(
      'Notification',
      async () => {},
    );

    expect(billingProcessed).toBe(0);
    expect(notificationProcessed).toBe(0);

    // Single dispatch was processed by Inventory
    const completed = await bus.list({ status: 'completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].processedBy).toBe('Inventory');
  });

  it('should support fan-out delivery where all subscribers process independently', async () => {
    // Multiple agents subscribe with fanout delivery
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

    // All 3 subscribers process the dispatch independently
    const inventoryProcessed = await bus.process('Inventory', async () => {});
    const billingProcessed = await bus.process('Billing', async () => {});
    const notificationProcessed = await bus.process(
      'Notification',
      async () => {},
    );

    expect(inventoryProcessed).toBe(1);
    expect(billingProcessed).toBe(1);
    expect(notificationProcessed).toBe(1);

    // All 3 dispatches were processed (one per subscriber)
    const completed = await bus.list({ status: 'completed' });
    expect(completed).toHaveLength(3);
  });

  it('should support event metadata for tracing', async () => {
    await bus.subscribe({ signalType: 'trace.test', subscriber: 'Logger' });

    await bus.emit(
      'trace.test',
      { action: 'test' },
      {
        source: 'TestRunner',
        sourceId: 'runner-001',
        metadata: {
          traceId: 'trace-abc123',
          spanId: 'span-xyz789',
          environment: 'test',
        },
      },
    );

    let receivedMetadata: DispatchMetadata | null = null;
    await bus.process('Logger', async (_payload, metadata) => {
      receivedMetadata = metadata;
    });

    expect(receivedMetadata).not.toBeNull();
    expect(receivedMetadata?.source).toBe('TestRunner');
    expect(receivedMetadata?.sourceId).toBe('runner-001');
    expect(receivedMetadata?.metadata).toEqual({
      traceId: 'trace-abc123',
      spanId: 'span-xyz789',
      environment: 'test',
    });
  });

  it('should support correlationId for request/response linking', async () => {
    const correlationId = 'corr-req-001';

    // Histrio subscribes to video requests
    await bus.subscribe({
      signalType: 'histrio.request',
      subscriber: 'Histrio',
    });

    // Praeco subscribes to video completions (fanout so multiple agents can react)
    await bus.subscribe({
      signalType: 'histrio.completed',
      subscriber: 'Praeco',
      delivery: 'fanout',
    });

    // 1. Praeco emits a video request with a correlationId
    const request = await bus.emit(
      'histrio.request',
      { contentId: 'article-42', script: 'Today the council approved...' },
      { source: 'Praeco', correlationId },
    );

    expect(request.correlationId).toBe(correlationId);

    // 2. Histrio processes the request and sees the correlationId in metadata
    let receivedCorrelationId = '';
    await bus.process('Histrio', async (_payload, metadata) => {
      receivedCorrelationId = metadata.correlationId;
    });

    expect(receivedCorrelationId).toBe(correlationId);

    // 3. Histrio emits a completion with the same correlationId
    await bus.emit(
      'histrio.completed',
      { contentId: 'article-42', videoAssetId: 'video-99' },
      { source: 'Histrio', correlationId },
    );

    // 4. Query by correlationId to find both request and response
    const correlated = await bus.list({ correlationId });
    expect(correlated).toHaveLength(2);

    const types = correlated.map((d) => d.type).sort();
    expect(types).toEqual(['histrio.completed', 'histrio.request']);

    // All dispatches share the same correlationId
    for (const d of correlated) {
      expect(d.correlationId).toBe(correlationId);
    }
  });
});
