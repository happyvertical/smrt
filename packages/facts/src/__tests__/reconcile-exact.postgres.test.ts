import { EmbeddingProvider } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactSourceCollection } from '../fact-sources.js';
import { FactCollection } from '../facts.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('exact fact reconciliation on PostgreSQL (#3400)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Fact', 'FactSource'],
    });
    db = isolated.baseDb;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('serializes concurrent normalized matches and preserves tenant scope', async () => {
    const tenantA = '10000000-0000-4000-8000-000000000001';
    const tenantB = '10000000-0000-4000-8000-000000000002';
    const left = await FactCollection.create({ db });
    const right = await FactCollection.create({ db });
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockRejectedValue(
      new Error('embedding provider unavailable'),
    );
    vi.spyOn(left, 'semanticSearch').mockRejectedValue(
      new Error('embedding provider unavailable'),
    );
    vi.spyOn(right, 'semanticSearch').mockRejectedValue(
      new Error('embedding provider unavailable'),
    );

    const [first, second] = await Promise.all([
      left.reconcile({
        rawInput: 'Council approved the capital plan.',
        type: 'event',
        domain: 'civic',
        tenantId: tenantA,
        source: { sourceType: 'minutes', sourceTitle: 'Minutes A' },
      }),
      right.reconcile({
        rawInput: '  council APPROVED the capital plan.  ',
        type: 'event',
        domain: 'civic',
        tenantId: tenantA,
        source: { sourceType: 'agenda', sourceTitle: 'Agenda A' },
      }),
    ]);

    expect(second.fact.id).toBe(first.fact.id);
    const tenantAFacts = await left.list({
      where: {
        tenantId: tenantA,
        type: 'event',
        domain: 'civic',
        status: 'active',
      },
    });
    expect(tenantAFacts).toHaveLength(1);

    const sources = await FactSourceCollection.create({ db });
    expect(await sources.countForFact(first.fact.id as string)).toBe(2);
    expect((await left.get({ id: first.fact.id }))?.sourceCount).toBe(2);

    const otherTenant = await left.reconcile({
      rawInput: 'Council approved the capital plan.',
      type: 'event',
      domain: 'civic',
      tenantId: tenantB,
    });
    expect(otherTenant.fact.id).not.toBe(first.fact.id);
  });

  it('keeps concurrent identities transaction-isolated on one collection after a rollback', async () => {
    const collection = await FactCollection.create({ db });
    const tenantId = '10000000-0000-4000-8000-000000000003';
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockRejectedValue(
      new Error('embedding provider unavailable'),
    );
    vi.spyOn(collection, 'semanticSearch').mockRejectedValue(
      new Error('embedding provider unavailable'),
    );
    const originalCreate = FactSourceCollection.prototype.create;
    vi.spyOn(FactSourceCollection.prototype, 'create').mockImplementation(
      async function (input) {
        if (input.sourceTitle === 'rollback') {
          throw new Error('force reconciliation rollback');
        }
        return originalCreate.call(this, input);
      },
    );

    const successful = collection.reconcile({
      rawInput: 'Concurrent successful reconciliation.',
      type: 'event',
      domain: 'civic',
      tenantId,
      source: { sourceType: 'minutes', sourceTitle: 'success' },
    });
    const rolledBack = collection.reconcile({
      rawInput: 'Concurrent rolled back reconciliation.',
      type: 'event',
      domain: 'planning',
      tenantId,
      source: { sourceType: 'minutes', sourceTitle: 'rollback' },
    });

    await expect(rolledBack).rejects.toThrow('force reconciliation rollback');
    const result = await successful;
    expect(result.action).toBe('created');
    expect(
      await collection.count({ where: { tenantId, domain: 'planning' } }),
    ).toBe(0);

    const reused = await collection.reconcile({
      rawInput: 'Collection reuse after rollback.',
      type: 'event',
      domain: 'reuse',
      tenantId,
    });
    expect(reused.action).toBe('created');
  });
});
