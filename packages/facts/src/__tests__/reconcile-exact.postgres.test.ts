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
});
