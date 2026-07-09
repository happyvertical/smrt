/**
 * Multi-instance agents (#1890) — framework primitives.
 *
 * Proves the opt-in per-instance identity the framework provides:
 *   - a **singleton** (non-opted) agent is byte-for-byte unchanged — it ignores
 *     any `instanceKey`, keeps the bare class-keyed dispatch subscriber, an
 *     un-suffixed memory scope, and no interest scoping (the N=1 default);
 *   - two **multi-instance** instances of one class run independently — distinct
 *     dispatch subscribers so an emit for one instance is never processed by the
 *     other, partitioned interests so they don't double-handle the same rows, and
 *     separate memory scopes.
 *
 * The package scopes its own dispatch/interests to the instance's config by
 * overriding the framework seams (`resolveSignalSubscriptions`,
 * `instanceInterestFilter`); these reference agents stand in for that.
 *
 * Real in-memory SQLite throughout; nothing external is touched.
 */

import {
  getTestDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { beforeAll, describe, expect, it } from 'vitest';
import { Agent, type AgentOptions } from './agent.js';
import type { ObjectFilter } from './interests.js';
import type { AgentLearningConfig } from './learning.js';

// -----------------------------------------------------------------------------
// Reference agents
// -----------------------------------------------------------------------------

/** A plain singleton agent — does NOT opt into multi-instance. */
@smrt()
class SoloAgent extends Agent {
  protected config = {};

  static override signalSubscriptions: string[] = ['ping'];

  handled = 0;

  async handleDispatch(): Promise<void> {
    this.handled += 1;
  }

  async run(): Promise<void> {}
}

/**
 * A multi-instance worker. It scopes its seeded subscription to its own instance
 * key so an emit targeted at one instance's signal type only matches that
 * instance's subscription — the package scoping dispatch by the instance config.
 */
@smrt()
class MultiWorker extends Agent {
  protected config = {};

  static override multiInstance = true;
  static override signalSubscriptions: string[] = ['task.assigned'];

  handled: Array<Record<string, unknown>> = [];

  protected override resolveSignalSubscriptions(): string[] {
    const key = this.getInstanceKey();
    return (this.constructor as typeof MultiWorker).signalSubscriptions.map(
      (type) => (key ? `${type}.${key}` : type),
    );
  }

  async handleDispatch(payload: unknown): Promise<void> {
    this.handled.push(payload as Record<string, unknown>);
  }

  async run(): Promise<void> {}
}

/** A registered object the scanners query. */
@smrt()
class Ticket extends SmrtObject {
  title: string = '';
  category: string = '';
}

class TicketCollection extends SmrtCollection<Ticket> {
  static readonly _itemClass = Ticket;
}

/**
 * A multi-instance scanner that partitions the tickets it processes by its
 * instance key via the `instanceInterestFilter` seam.
 */
@smrt()
class MultiScanner extends Agent {
  protected config = {};

  static override multiInstance = true;

  constructor(options: AgentOptions = {}) {
    super({
      ...options,
      interests: { objects: { Ticket: { sort: 'created_at DESC' } } },
    });
  }

  protected override instanceInterestFilter(): ObjectFilter | undefined {
    const key = this.getInstanceKey();
    return key ? { category: key } : undefined;
  }

  async run(): Promise<void> {}
}

/** A multi-instance learning agent — proves per-instance memory partitioning. */
@smrt()
class MultiLearner extends Agent {
  static override multiInstance = true;
  static override learning: AgentLearningConfig = { enabled: true };

  protected config = {};

  aiCalls = 0;

  async run(): Promise<void> {
    const recalled = this.recalledMemories.find((m) => m.key === 'strategy');
    if (!recalled) {
      this.aiCalls += 1;
    }
    this.stageLearning({
      scope: this.learningScope(),
      key: 'strategy',
      value: recalled ? String(recalled.value) : `v${this.aiCalls}`,
    });
  }

  // Expose the protected scope for assertions.
  publicLearningScope(): string {
    return this.learningScope();
  }
}

describe('Multi-instance agents (#1890)', () => {
  describe('singleton (non-opted) regression', () => {
    it('ignores instanceKey and keeps the bare class-keyed identity', () => {
      const a = new SoloAgent({ name: 'solo-a', instanceKey: 'ignored-a' });
      const b = new SoloAgent({ name: 'solo-b', instanceKey: 'ignored-b' });

      // Opt-in is off → no instance key, even though one was passed.
      expect(a.getInstanceKey()).toBeNull();
      expect(b.getInstanceKey()).toBeNull();

      // Both share the same class-keyed subscriber (no `#suffix`).
      expect(a.getDispatchSubscriber()).toBe(b.getDispatchSubscriber());
      expect(a.getDispatchSubscriber()).not.toContain('#');
    });

    it('seeds subscriptions under the class-keyed subscriber (unchanged)', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const agent = new SoloAgent({ name: 'solo-sub', db, instanceKey: 'x' });
      await agent.initialize();

      const bus = await agent.getDispatch();
      const scoped = await bus.listSubscriptions(
        `${agent.getDispatchSubscriber()}#x`,
      );
      const classKeyed = await bus.listSubscriptions(
        agent.getDispatchSubscriber(),
      );

      // Nothing was seeded under a per-instance name; all under the bare type.
      expect(scoped).toHaveLength(0);
      expect(classKeyed.map((s) => s.signalType)).toEqual(['ping']);
    });
  });

  describe('per-instance dispatch identity', () => {
    it('gives each instance a distinct, key-suffixed subscriber', () => {
      const support = new MultiWorker({ name: 'w1', instanceKey: 'support' });
      const sales = new MultiWorker({ name: 'w2', instanceKey: 'sales' });

      expect(support.getInstanceKey()).toBe('support');
      expect(support.getDispatchSubscriber()).not.toBe(
        sales.getDispatchSubscriber(),
      );
      expect(support.getDispatchSubscriber().endsWith('#support')).toBe(true);
      expect(sales.getDispatchSubscriber().endsWith('#sales')).toBe(true);
    });

    it('does not cross-process: an emit for one instance is not handled by the other', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const support = new MultiWorker({
        name: 'w-support',
        db,
        instanceKey: 'support',
      });
      const sales = new MultiWorker({
        name: 'w-sales',
        db,
        instanceKey: 'sales',
      });

      await support.initialize();
      await sales.initialize();

      const bus = await support.getDispatch();
      // Package routes this signal to the "support" instance.
      await bus.emit('task.assigned.support', { id: 't1' }, { source: 'test' });

      await support.execute();
      await sales.execute();

      expect(support.handled).toHaveLength(1);
      expect(support.handled[0]).toEqual({ id: 't1' });
      // The sales instance never saw the support task.
      expect(sales.handled).toHaveLength(0);
    });
  });

  describe('per-instance interest scoping', () => {
    let db: Awaited<ReturnType<typeof getTestDatabase>>;
    let tickets: TicketCollection;

    beforeAll(async () => {
      db = await getTestDatabase();
      tickets = await TicketCollection.create({ db });
      await (await tickets.create({ title: 'S1', category: 'support' })).save();
      await (await tickets.create({ title: 'S2', category: 'support' })).save();
      await (await tickets.create({ title: 'X1', category: 'sales' })).save();
    });

    it('partitions the objects each instance processes by its config', async () => {
      const support = new MultiScanner({
        name: 's-support',
        db,
        instanceKey: 'support',
      });
      const sales = new MultiScanner({
        name: 's-sales',
        db,
        instanceKey: 'sales',
      });
      await support.initialize();
      await sales.initialize();

      const supportItems = await support.interesting();
      const salesItems = await sales.interesting();

      expect(supportItems).toHaveLength(2);
      expect(
        supportItems.every((i) => (i.data as Ticket).category === 'support'),
      ).toBe(true);

      expect(salesItems).toHaveLength(1);
      expect((salesItems[0].data as Ticket).category).toBe('sales');
    });
  });

  describe('per-instance memory scope', () => {
    it('partitions learning memory by instance and starts each cold', async () => {
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const support = new MultiLearner({
        name: 'l-support',
        db,
        instanceKey: 'support',
      });
      const sales = new MultiLearner({
        name: 'l-sales',
        db,
        instanceKey: 'sales',
      });

      // Distinct, key-suffixed memory scopes.
      expect(support.publicLearningScope()).not.toBe(
        sales.publicLearningScope(),
      );
      expect(support.publicLearningScope().endsWith('#support')).toBe(true);

      await support.execute(); // support learns
      await sales.execute(); // sales starts cold — own scope + own owner id

      // Each generated its own strategy independently (no cross-pollination).
      expect(support.aiCalls).toBe(1);
      expect(sales.aiCalls).toBe(1);

      // support reuses its own memory on a second run (no new generation).
      await support.execute();
      expect(support.aiCalls).toBe(1);
    });
  });
});
