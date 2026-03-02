/**
 * Tests for declarative signal subscriptions and auto-processing in Agent lifecycle
 */

import { smrt } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { beforeAll, describe, expect, it } from 'vitest';
import { Agent } from './agent.js';

// Agent with declarative signal subscriptions
@smrt()
class EmailHandler extends Agent {
  protected config = {};

  static override signalSubscriptions: string[] = [
    'email.received',
    'email.bounced',
  ];

  dispatches: Array<{ payload: unknown; type: string }> = [];

  async handleDispatch(payload: unknown, metadata: any): Promise<void> {
    this.dispatches.push({ payload, type: metadata.type });
  }

  async run(): Promise<void> {
    // no-op
  }
}

// Agent without signal subscriptions
@smrt()
class PlainAgent extends Agent {
  protected config = {};
  ran = false;

  async run(): Promise<void> {
    this.ran = true;
  }
}

describe('Declarative Signal Subscriptions', () => {
  let sharedDb: any;

  beforeAll(async () => {
    sharedDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('should seed subscriptions from signalSubscriptions on first initialize()', async () => {
    const agent = new EmailHandler({
      name: 'email-handler-1',
      db: sharedDb,
    });

    await agent.initialize();

    const dispatch = await agent.getDispatch();
    const subs = await dispatch.listSubscriptions('EmailHandler');

    expect(subs).toHaveLength(2);
    const types = subs.map((s) => s.signalType).sort();
    expect(types).toEqual(['email.bounced', 'email.received']);
  });

  it('should not duplicate subscriptions on second initialize()', async () => {
    const agent = new EmailHandler({
      name: 'email-handler-2',
      db: sharedDb,
    });

    await agent.initialize();
    // Initialize again — should be idempotent
    await agent.initialize();

    const dispatch = await agent.getDispatch();
    const subs = await dispatch.listSubscriptions('EmailHandler');

    // Still only 2, not 4
    expect(subs).toHaveLength(2);
  });

  it('should not overwrite user-added DB subscriptions', async () => {
    // Use a fresh DB to avoid contamination from other tests
    const freshDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const agent = new EmailHandler({
      name: 'email-handler-3',
      db: freshDb,
    });

    // Initialize once to create tables and seed defaults
    await agent.initialize();

    // Pre-add a custom subscription
    const dispatch = await agent.getDispatch();
    await dispatch.subscribe({
      signalType: 'email.custom',
      subscriber: 'EmailHandler',
    });

    // Initialize again — should not lose the custom subscription
    await agent.initialize();

    const subs = await dispatch.listSubscriptions('EmailHandler');
    const types = subs.map((s) => s.signalType).sort();

    // Should have all 3: the 2 from static + 1 custom
    expect(types).toContain('email.custom');
    expect(types).toContain('email.received');
    expect(types).toContain('email.bounced');
  });
});

describe('Auto-process Dispatches in Execute Lifecycle', () => {
  let sharedDb: any;

  beforeAll(async () => {
    sharedDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('should auto-process pending dispatches before run()', async () => {
    const agent = new EmailHandler({
      name: 'email-handler-exec',
      db: sharedDb,
    });

    // Seed subscriptions first
    await agent.initialize();
    const dispatch = await agent.getDispatch();

    // Emit a dispatch before execute
    await dispatch.emit(
      'email.received',
      { from: 'test@example.com' },
      {
        source: 'MailServer',
      },
    );

    // Execute the agent — should auto-process the pending dispatch
    await agent.execute();

    expect(agent.dispatches).toHaveLength(1);
    expect(agent.dispatches[0].type).toBe('email.received');
    expect(agent.dispatches[0].payload).toEqual({ from: 'test@example.com' });
  });

  it('should skip dispatch processing when agent has no subscriptions', async () => {
    const agent = new PlainAgent({
      name: 'plain-agent-1',
      db: sharedDb,
    });

    // Execute should work fine without any subscriptions
    await agent.execute();

    expect(agent.ran).toBe(true);
    expect(agent.status).toBe('idle');
  });

  it('should skip dispatch processing when agent has no DB', async () => {
    const agent = new PlainAgent({
      name: 'plain-no-db',
    });

    // Execute without DB — should not error on dispatch check
    await agent.execute();

    expect(agent.ran).toBe(true);
    expect(agent.status).toBe('idle');
  });
});
