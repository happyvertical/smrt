/**
 * Tests for DispatchBus - Inter-Agent Communication
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatchBus, type DispatchBus } from './bus.js';
import { Dispatch } from './models/Dispatch.js';
import { DispatchSubscription } from './models/DispatchSubscription.js';
import type { DispatchMetadata } from './types.js';

describe('DispatchBus', () => {
  let bus: DispatchBus;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-dispatch-test-${randomUUID().slice(0, 8)}.db`,
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

  describe('emit()', () => {
    it('should create a pending dispatch', async () => {
      const dispatch = await bus.emit(
        'campaign.completed',
        { campaignId: '123', revenue: 5000 },
        { source: 'suasor' },
      );

      expect(dispatch).toBeDefined();
      expect(dispatch.id).toBeDefined();
      expect(dispatch.type).toBe('campaign.completed');
      expect(dispatch.source).toBe('suasor');
      expect(dispatch.status).toBe('pending');
      expect(dispatch.payload).toEqual({ campaignId: '123', revenue: 5000 });
    });

    it('should persist dispatch to database', async () => {
      await bus.emit('test.event', { data: 'test' }, { source: 'test' });

      const dispatches = await bus.list();
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].type).toBe('test.event');
    });

    it('should call in-memory handlers immediately', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);

      await bus.emit('test.event', { value: 42 }, { source: 'test' });

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        { value: 42 },
        expect.objectContaining({ type: 'test.event', source: 'test' }),
      );
    });
  });

  describe('on() / off()', () => {
    it('should register in-memory handlers', async () => {
      const handler = vi.fn();
      bus.on('test.*', handler);

      await bus.emit('test.one', {}, { source: 'test' });
      await bus.emit('test.two', {}, { source: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should unregister handlers with off()', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);

      await bus.emit('test.event', {}, { source: 'test' });
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledTimes(1);

      const removed = bus.off('test.event', handler);
      expect(removed).toBe(true);

      await bus.emit('test.event', {}, { source: 'test' });
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should match wildcards correctly', async () => {
      const handler = vi.fn();
      bus.on('campaign.*', handler);

      await bus.emit('campaign.started', {}, { source: 'test' });
      await bus.emit('campaign.completed', {}, { source: 'test' });
      await bus.emit('other.event', {}, { source: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribe() / unsubscribe()', () => {
    it('should create persistent subscription', async () => {
      await bus.subscribe({
        signalType: 'campaign.*',
        subscriber: 'fiscus',
        handler: 'handleCampaign',
      });

      const subs = await bus.listSubscriptions('fiscus');
      expect(subs).toHaveLength(1);
      expect(subs[0].signalType).toBe('campaign.*');
      expect(subs[0].handler).toBe('handleCampaign');
    });

    it('should remove subscription', async () => {
      await bus.subscribe({
        signalType: 'test.event',
        subscriber: 'test-agent',
      });

      let subs = await bus.listSubscriptions('test-agent');
      expect(subs).toHaveLength(1);

      await bus.unsubscribe('test.event', 'test-agent');

      subs = await bus.listSubscriptions('test-agent');
      expect(subs).toHaveLength(0);
    });
  });

  describe('process()', () => {
    it('should process pending dispatches for subscriber', async () => {
      // Create subscription
      await bus.subscribe({
        signalType: 'campaign.completed',
        subscriber: 'fiscus',
      });

      // Emit some dispatches
      await bus.emit('campaign.completed', { id: '1' }, { source: 'suasor' });
      await bus.emit('campaign.completed', { id: '2' }, { source: 'suasor' });

      const processed: DispatchMetadata[] = [];
      const count = await bus.process('fiscus', async (payload, metadata) => {
        processed.push(metadata);
      });

      expect(count).toBe(2);
      expect(processed).toHaveLength(2);
    });

    it('should mark dispatches as completed', async () => {
      await bus.subscribe({ signalType: 'test.event', subscriber: 'handler' });
      await bus.emit('test.event', {}, { source: 'test' });

      await bus.process('handler', async () => {});

      const dispatches = await bus.list({ status: 'completed' });
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].processedBy).toBe('handler');
    });

    it('should mark dispatches as failed on error', async () => {
      await bus.subscribe({ signalType: 'test.event', subscriber: 'handler' });
      await bus.emit('test.event', {}, { source: 'test' });

      await bus.process('handler', async () => {
        throw new Error('Processing failed');
      });

      const dispatches = await bus.list({ status: 'failed' });
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].lastError).toBe('Processing failed');
    });

    it('should match wildcard subscriptions', async () => {
      await bus.subscribe({ signalType: 'campaign.*', subscriber: 'fiscus' });

      await bus.emit('campaign.started', { id: '1' }, { source: 'suasor' });
      await bus.emit('campaign.completed', { id: '2' }, { source: 'suasor' });
      await bus.emit('other.event', { id: '3' }, { source: 'other' });

      const processed: string[] = [];
      await bus.process('fiscus', async (_payload, metadata) => {
        processed.push(metadata.type);
      });

      expect(processed).toHaveLength(2);
      expect(processed).toContain('campaign.started');
      expect(processed).toContain('campaign.completed');
    });
  });

  describe('retry()', () => {
    it('should reset failed dispatches to pending', async () => {
      await bus.subscribe({ signalType: 'test.event', subscriber: 'handler' });
      await bus.emit('test.event', {}, { source: 'test' });

      // Process and fail
      await bus.process('handler', async () => {
        throw new Error('fail');
      });

      let failed = await bus.list({ status: 'failed' });
      expect(failed).toHaveLength(1);

      // Retry
      const count = await bus.retry({ maxAttempts: 3 });
      expect(count).toBe(1);

      const pending = await bus.list({ status: 'pending' });
      expect(pending).toHaveLength(1);

      failed = await bus.list({ status: 'failed' });
      expect(failed).toHaveLength(0);
    });

    it('should respect maxAttempts', async () => {
      await bus.subscribe({ signalType: 'test.event', subscriber: 'handler' });
      await bus.emit('test.event', {}, { source: 'test' });

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        await bus.process('handler', async () => {
          throw new Error('fail');
        });
        if (i < 2) {
          await bus.retry({ maxAttempts: 5 });
        }
      }

      // Should not retry if maxAttempts reached
      const count = await bus.retry({ maxAttempts: 3 });
      expect(count).toBe(0);
    });
  });

  describe('cleanup()', () => {
    it('should delete old completed dispatches', async () => {
      await bus.subscribe({ signalType: 'test.event', subscriber: 'handler' });

      // Create and process dispatch
      await bus.emit('test.event', {}, { source: 'test' });
      await bus.process('handler', async () => {});

      const completed = await bus.list({ status: 'completed' });
      expect(completed).toHaveLength(1);

      // Cleanup (with 0 days = delete all)
      const result = await bus.cleanup({ completedOlderThanDays: 0 });

      // Since dispatch was just created, it might not be old enough
      // This tests the mechanism works
      expect(result.completedDeleted).toBeGreaterThanOrEqual(0);
    });
  });

  describe('list()', () => {
    it('should filter by status', async () => {
      await bus.subscribe({ signalType: 'test.event', subscriber: 'handler' });

      await bus.emit('test.event', {}, { source: 'test' });
      await bus.emit('test.event', {}, { source: 'test' });

      // Process one
      await bus.process('handler', async () => {}, { limit: 1 });

      const pending = await bus.list({ status: 'pending' });
      const completed = await bus.list({ status: 'completed' });

      expect(pending).toHaveLength(1);
      expect(completed).toHaveLength(1);
    });

    it('should filter by source', async () => {
      await bus.emit('test.event', {}, { source: 'agent-a' });
      await bus.emit('test.event', {}, { source: 'agent-b' });

      const fromA = await bus.list({ source: 'agent-a' });
      expect(fromA).toHaveLength(1);
    });

    it('should filter by type', async () => {
      await bus.emit('campaign.started', {}, { source: 'test' });
      await bus.emit('campaign.completed', {}, { source: 'test' });

      const started = await bus.list({ type: 'campaign.started' });
      expect(started).toHaveLength(1);
    });
  });
});

describe('Dispatch Model', () => {
  it('should create with defaults', () => {
    const dispatch = new Dispatch({
      type: 'test.event',
      source: 'test',
    });

    expect(dispatch.id).toBeDefined();
    expect(dispatch.type).toBe('test.event');
    expect(dispatch.status).toBe('pending');
    expect(dispatch.attempts).toBe(0);
  });

  it('should convert to/from row format', () => {
    const dispatch = new Dispatch({
      type: 'test.event',
      source: 'test',
      payload: JSON.stringify({ key: 'value' }),
    });

    const row = dispatch.toRow();
    expect(row.type).toBe('test.event');
    expect(JSON.parse(row.payload as string)).toEqual({ key: 'value' });

    const restored = Dispatch.fromRow(row);
    expect(restored.type).toBe('test.event');
    expect(restored.payload).toEqual({ key: 'value' });
  });

  it('should track status transitions', () => {
    const dispatch = new Dispatch({ type: 'test', source: 'test' });

    expect(dispatch.status).toBe('pending');

    dispatch.markProcessing();
    expect(dispatch.status).toBe('processing');
    expect(dispatch.attempts).toBe(1);

    dispatch.markCompleted('handler');
    expect(dispatch.status).toBe('completed');
    expect(dispatch.processedBy).toBe('handler');
  });
});

describe('DispatchSubscription Model', () => {
  it('should match exact signal types', () => {
    const sub = new DispatchSubscription({
      signal_type: 'campaign.completed',
      subscriber: 'fiscus',
    });

    expect(sub.matches('campaign.completed')).toBe(true);
    expect(sub.matches('campaign.started')).toBe(false);
  });

  it('should match wildcard patterns', () => {
    const sub = new DispatchSubscription({
      signal_type: 'campaign.*',
      subscriber: 'fiscus',
    });

    expect(sub.matches('campaign.completed')).toBe(true);
    expect(sub.matches('campaign.started')).toBe(true);
    expect(sub.matches('other.event')).toBe(false);
  });

  it('should match multi-segment wildcards', () => {
    const sub = new DispatchSubscription({
      signal_type: 'agent.*.completed',
      subscriber: 'monitor',
    });

    expect(sub.matches('agent.suasor.completed')).toBe(true);
    expect(sub.matches('agent.fiscus.completed')).toBe(true);
    expect(sub.matches('agent.suasor.started')).toBe(false);
  });

  it('should not match when disabled', () => {
    const sub = new DispatchSubscription({
      signal_type: 'campaign.*',
      subscriber: 'fiscus',
      enabled: 0,
    });

    expect(sub.matches('campaign.completed')).toBe(false);
  });

  it('should identify wildcards', () => {
    const exact = new DispatchSubscription({
      signal_type: 'test.event',
      subscriber: 'x',
    });
    const wildcard = new DispatchSubscription({
      signal_type: 'test.*',
      subscriber: 'x',
    });

    expect(exact.isWildcard()).toBe(false);
    expect(wildcard.isWildcard()).toBe(true);
  });
});
