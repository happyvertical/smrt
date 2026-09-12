/**
 * FactCollection tests - getEntityBriefing
 *
 * Tests for the entity briefing feature which aggregates
 * facts related to a specific entity via FactSubject links.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smrt } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fact } from '../fact';
import { FactSubjectCollection } from '../fact-subjects';
import { FactCollection } from '../facts';

@smrt({ tableStrategy: 'sti' })
class CatalogFactSubtype extends Fact {}

class CatalogFactSubtypeCollection extends FactCollection {
  static readonly _itemClass = CatalogFactSubtype;
}

describe('getEntityBriefing', () => {
  let tempDir: string;
  let dbPath: string;
  let facts: FactCollection;
  let subjects: FactSubjectCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-briefing-test-'));
    dbPath = join(tempDir, 'facts.db');

    facts = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    subjects = await FactSubjectCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should return empty briefing for entity with no links', async () => {
    const briefing = await facts.getEntityBriefing('Profile', 'no-links');

    expect(briefing.entityType).toBe('Profile');
    expect(briefing.entityId).toBe('no-links');
    expect(briefing.facts).toEqual([]);
    expect(briefing.totalCount).toBe(0);
    expect(briefing.byType).toEqual({});
    expect(briefing.byStatus).toEqual({});
  });

  it('should return facts linked to an entity', async () => {
    // Create facts
    const fact1 = await facts.create({
      textRefined: 'John is the mayor',
      type: 'assertion',
      status: 'active',
    });
    const fact2 = await facts.create({
      textRefined: 'John attended the council meeting',
      type: 'event',
      status: 'active',
    });

    // Link to entity
    await subjects.linkEntity(
      fact1.id as string,
      'Profile',
      'john-123',
      'subject',
    );
    await subjects.linkEntity(
      fact2.id as string,
      'Profile',
      'john-123',
      'participant',
    );

    const briefing = await facts.getEntityBriefing('Profile', 'john-123');

    expect(briefing.entityType).toBe('Profile');
    expect(briefing.entityId).toBe('john-123');
    expect(briefing.totalCount).toBe(2);
    expect(briefing.facts.length).toBe(2);
  });

  it('should count facts by type', async () => {
    const fact1 = await facts.create({
      textRefined: 'Fact assertion 1',
      type: 'assertion',
      status: 'active',
    });
    const fact2 = await facts.create({
      textRefined: 'Fact assertion 2',
      type: 'assertion',
      status: 'active',
    });
    const fact3 = await facts.create({
      textRefined: 'Fact event 1',
      type: 'event',
      status: 'active',
    });

    await subjects.linkEntity(fact1.id as string, 'Place', 'place-1');
    await subjects.linkEntity(fact2.id as string, 'Place', 'place-1');
    await subjects.linkEntity(fact3.id as string, 'Place', 'place-1');

    const briefing = await facts.getEntityBriefing('Place', 'place-1');

    expect(briefing.byType).toEqual({
      assertion: 2,
      event: 1,
    });
  });

  it('should count facts by status', async () => {
    const fact1 = await facts.create({
      textRefined: 'Active fact',
      type: 'assertion',
      status: 'active',
    });
    const fact2 = await facts.create({
      textRefined: 'Pending fact',
      type: 'assertion',
      status: 'pending',
    });
    const fact3 = await facts.create({
      textRefined: 'Superseded fact',
      type: 'assertion',
      status: 'superseded',
    });

    await subjects.linkEntity(fact1.id as string, 'Event', 'event-1');
    await subjects.linkEntity(fact2.id as string, 'Event', 'event-1');
    await subjects.linkEntity(fact3.id as string, 'Event', 'event-1');

    const briefing = await facts.getEntityBriefing('Event', 'event-1');

    expect(briefing.byStatus).toEqual({
      active: 1,
      pending: 1,
      superseded: 1,
    });
  });

  it('should not include facts linked to other entities', async () => {
    const fact1 = await facts.create({
      textRefined: 'Fact for entity A',
      type: 'assertion',
      status: 'active',
    });
    const fact2 = await facts.create({
      textRefined: 'Fact for entity B',
      type: 'assertion',
      status: 'active',
    });

    await subjects.linkEntity(fact1.id as string, 'Profile', 'entity-a');
    await subjects.linkEntity(fact2.id as string, 'Profile', 'entity-b');

    const briefingA = await facts.getEntityBriefing('Profile', 'entity-a');
    const briefingB = await facts.getEntityBriefing('Profile', 'entity-b');

    expect(briefingA.totalCount).toBe(1);
    expect(briefingA.facts[0].id).toBe(fact1.id);
    expect(briefingB.totalCount).toBe(1);
    expect(briefingB.facts[0].id).toBe(fact2.id);
  });

  it('should handle multiple entity types', async () => {
    const fact1 = await facts.create({
      textRefined: 'Fact about profile',
      type: 'assertion',
      status: 'active',
    });
    const fact2 = await facts.create({
      textRefined: 'Fact about place',
      type: 'observation',
      status: 'active',
    });

    // Same entityId but different entityType
    await subjects.linkEntity(fact1.id as string, 'Profile', 'shared-id');
    await subjects.linkEntity(fact2.id as string, 'Place', 'shared-id');

    const profileBriefing = await facts.getEntityBriefing(
      'Profile',
      'shared-id',
    );
    const placeBriefing = await facts.getEntityBriefing('Place', 'shared-id');

    expect(profileBriefing.totalCount).toBe(1);
    expect(profileBriefing.facts[0].type).toBe('assertion');
    expect(placeBriefing.totalCount).toBe(1);
    expect(placeBriefing.facts[0].type).toBe('observation');
  });

  it('keeps semantic browse results scoped to the requested tenant', async () => {
    const tenantFact = await facts.create({
      tenantId: 'tenant-a',
      textRefined: 'Bridge reopened for tenant A',
      type: 'assertion',
      status: 'active',
    });
    const otherTenantFact = await facts.create({
      tenantId: 'tenant-b',
      textRefined: 'Bridge reopened for tenant B',
      type: 'assertion',
      status: 'active',
    });

    vi.spyOn(facts, 'semanticSearch').mockResolvedValue([
      tenantFact,
      otherTenantFact,
    ]);

    const results = await facts.browseCatalog('bridge', {
      tenantId: 'tenant-a',
      latestOnly: false,
    });

    expect(results.map((fact) => fact.id)).toEqual([tenantFact.id]);
  });

  it('applies offset when browsing catalog results', async () => {
    const browseFacts = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        facts.create({
          textRefined: `Catalog fact ${index + 1}`,
          type: 'assertion',
          status: 'active',
        }),
      ),
    );

    vi.spyOn(facts, 'semanticSearch').mockResolvedValue(browseFacts as any);
    const querySpy = vi.spyOn((facts as any).db, 'query');
    querySpy.mockClear();

    const results = await facts.browseCatalog('catalog', {
      limit: 5,
      offset: 10,
      latestOnly: false,
    });

    expect(results.map((fact) => fact.textRefined)).toEqual([
      'Catalog fact 11',
      'Catalog fact 12',
      'Catalog fact 13',
      'Catalog fact 14',
      'Catalog fact 15',
    ]);
    expect(
      querySpy.mock.calls.filter(([sql]) =>
        String(sql).includes('semantic_candidates'),
      ),
    ).toHaveLength(1);
    expect(facts.semanticSearch).toHaveBeenCalledWith(
      'catalog',
      expect.objectContaining({ limit: 15 }),
    );
  });

  it('bounds the non-latest catalog query to the requested SQL page', async () => {
    await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        facts.create({
          textRefined: `Paged catalog fact ${index + 1}`,
          type: 'assertion',
          status: 'active',
        }),
      ),
    );
    const querySpy = vi.spyOn((facts as any).db, 'query');
    querySpy.mockClear();

    const results = await facts.browseCatalog('', {
      limit: 5,
      offset: 10,
      latestOnly: false,
    });

    expect(results).toHaveLength(5);
    const catalogQuery = querySpy.mock.calls.find(([sql]) =>
      String(sql).includes('FROM facts'),
    );
    expect(catalogQuery?.[0]).toContain('LIMIT ? OFFSET ?');
    expect(catalogQuery?.slice(-2)).toEqual([5, 10]);
  });

  it('keeps empty catalog pages tenant-global scoped in SQL', async () => {
    const tenantFact = await facts.create({
      tenantId: 'tenant-a',
      textRefined: 'Tenant catalog fact',
      type: 'assertion',
      status: 'active',
    });
    const globalFact = await facts.create({
      textRefined: 'Global catalog fact',
      type: 'assertion',
      status: 'active',
    });
    const otherTenantFact = await facts.create({
      tenantId: 'tenant-b',
      textRefined: 'Other tenant catalog fact',
      type: 'assertion',
      status: 'active',
    });

    const results = await facts.browseCatalog('', {
      tenantId: 'tenant-a',
      latestOnly: false,
    });

    expect(results.map((fact) => fact.id)).toEqual(
      expect.arrayContaining([tenantFact.id, globalFact.id]),
    );
    expect(results.map((fact) => fact.id)).not.toContain(otherTenantFact.id);
  });

  it('keeps the catalog status policy distinct for global and tenant pages', async () => {
    const globalActive = await facts.create({
      textRefined: 'Global active catalog fact',
      type: 'assertion',
      status: 'active',
    });
    const globalPending = await facts.create({
      textRefined: 'Global pending catalog fact',
      type: 'assertion',
      status: 'pending',
    });
    const tenantPending = await facts.create({
      tenantId: 'tenant-a',
      textRefined: 'Tenant pending catalog fact',
      type: 'assertion',
      status: 'pending',
    });

    const globalResults = await facts.browseCatalog('', { latestOnly: false });
    const tenantResults = await facts.browseCatalog('', {
      tenantId: 'tenant-a',
      latestOnly: false,
    });

    expect(globalResults.map((fact) => fact.id)).toEqual([globalActive.id]);
    expect(tenantResults.map((fact) => fact.id)).toEqual(
      expect.arrayContaining([
        globalActive.id,
        globalPending.id,
        tenantPending.id,
      ]),
    );
  });

  it('resolves latest catalog facts from one batched query', async () => {
    const browseFacts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        facts.create({
          textRefined: `Catalog fact ${index + 1}`,
          type: 'assertion',
          status: 'active',
        }),
      ),
    );
    const querySpy = vi.spyOn((facts as any).db, 'query');
    querySpy.mockClear();

    const results = await facts.browseCatalog('', {
      limit: 5,
      latestOnly: true,
    });

    expect(results).toHaveLength(5);
    expect(
      querySpy.mock.calls.filter(([sql]) => String(sql).includes('FROM facts')),
    ).toHaveLength(1);
    const catalogQuery = querySpy.mock.calls.find(([sql]) =>
      String(sql).includes('WITH RECURSIVE'),
    );
    expect(catalogQuery?.[0]).toContain('LIMIT ? OFFSET ?');
    expect(catalogQuery?.slice(-2)).toEqual([5, 0]);
    const browseFactIds = new Set(browseFacts.map((fact) => fact.id));
    expect(results.every((fact) => browseFactIds.has(fact.id))).toBe(true);
  });

  it('selects the highest-confidence latest leaf without chain queries', async () => {
    const root = await facts.create({
      textRefined: 'Catalog root fact',
      type: 'assertion',
      status: 'active',
      confidence: 0.1,
    });
    await facts.create({
      textRefined: 'Lower-confidence successor',
      type: 'assertion',
      status: 'active',
      previousFactId: root.id as string,
      confidence: 0.3,
    });
    const latest = await facts.create({
      textRefined: 'Higher-confidence successor',
      type: 'assertion',
      status: 'active',
      previousFactId: root.id as string,
      confidence: 0.9,
    });
    const querySpy = vi.spyOn((facts as any).db, 'query');
    querySpy.mockClear();

    const results = await facts.browseCatalog('', {
      limit: 5,
      latestOnly: true,
    });

    expect(results.map((fact) => fact.id)).toContain(latest.id);
    expect(
      querySpy.mock.calls.filter(([sql]) => String(sql).includes('FROM facts')),
    ).toHaveLength(1);
  });

  it('preserves legacy latest-chain resolution in the text fallback', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        facts.create({
          textRefined: `Catalog fallback fact ${index + 1}`,
          type: 'assertion',
          status: 'active',
        }),
      ),
    );
    vi.spyOn(facts, 'semanticSearch').mockRejectedValue(
      new Error('Embeddings unavailable'),
    );
    const querySpy = vi.spyOn((facts as any).db, 'query');
    querySpy.mockClear();

    const results = await facts.browseCatalog('fallback', {
      limit: 5,
      offset: 10,
      latestOnly: true,
    });

    expect(results).toHaveLength(5);
    expect(
      querySpy.mock.calls.filter(([sql]) => String(sql).includes('FROM facts')),
    ).toHaveLength(31);
  });

  it('treats text fallback wildcard characters as literal text', async () => {
    const fact = await facts.create({
      textRefined: 'Catalog value 100%_\\ retained',
      type: 'assertion',
      status: 'active',
    });
    vi.spyOn(facts, 'semanticSearch').mockRejectedValue(
      new Error('Embeddings unavailable'),
    );

    const results = await facts.browseCatalog('100%_\\', {
      latestOnly: false,
    });

    expect(results.map((result) => result.id)).toEqual([fact.id]);
  });

  it('preserves Unicode case folding in the text fallback', async () => {
    const kelvin = await facts.create({
      textRefined: 'Temperature is 300K',
      type: 'assertion',
      status: 'active',
    });
    const accent = await facts.create({
      textRefined: 'Café catalog fact',
      type: 'assertion',
      status: 'active',
    });
    vi.spyOn(facts, 'semanticSearch').mockRejectedValue(
      new Error('Embeddings unavailable'),
    );

    expect(
      (await facts.browseCatalog('k', { latestOnly: false })).map(
        (fact) => fact.id,
      ),
    ).toContain(kelvin.id);
    expect(
      (await facts.browseCatalog('É', { latestOnly: false })).map(
        (fact) => fact.id,
      ),
    ).toContain(accent.id);
  });

  it('follows a successor outside the active catalog filter', async () => {
    const root = await facts.create({
      textRefined: 'Active catalog root',
      type: 'assertion',
      status: 'active',
      confidence: 0.1,
    });
    const latest = await facts.create({
      textRefined: 'Superseded successor',
      type: 'assertion',
      status: 'superseded',
      previousFactId: root.id as string,
      confidence: 0.9,
    });
    const querySpy = vi.spyOn((facts as any).db, 'query');
    querySpy.mockClear();

    const results = await facts.browseCatalog('', {
      latestOnly: true,
      includeSuperseded: false,
    });

    expect(results.map((fact) => fact.id)).toEqual([latest.id]);
    expect(
      querySpy.mock.calls.filter(([sql]) => String(sql).includes('FROM facts')),
    ).toHaveLength(1);
  });

  it('returns the repeated fact when a latest catalog branch cycles', async () => {
    const root = await facts.create({
      textRefined: 'Cyclic catalog root',
      type: 'assertion',
      status: 'active',
      confidence: 0.1,
    });
    const successor = await facts.create({
      textRefined: 'Cyclic catalog successor',
      type: 'assertion',
      status: 'superseded',
      previousFactId: root.id as string,
      confidence: 0.9,
    });
    root.previousFactId = successor.id as string;
    await root.save();

    const results = await facts.browseCatalog('', {
      latestOnly: true,
      includeSuperseded: false,
    });

    expect(results.map((fact) => fact.id)).toEqual([root.id]);
  });

  it('keeps implicit and explicit tenant catalog reads in an STI child scope', async () => {
    const subtypeFacts = await CatalogFactSubtypeCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const baseFact = await facts.create({
      textRefined: 'Base fact outside subtype scope',
      type: 'assertion',
      status: 'active',
      tenantId: 'tenant-a',
    });
    const childFact = await subtypeFacts.create({
      textRefined: 'Subtype fact inside scope',
      type: 'assertion',
      status: 'active',
      tenantId: 'tenant-a',
    });
    const baseSuccessor = await facts.create({
      textRefined: 'Base successor outside subtype chain',
      type: 'assertion',
      status: 'active',
      tenantId: 'tenant-a',
      previousFactId: childFact.id as string,
      confidence: 1,
    });

    const implicit = await subtypeFacts.browseCatalog('', {
      latestOnly: true,
    });
    const explicit = await subtypeFacts.browseCatalog('', {
      tenantId: 'tenant-a',
      latestOnly: true,
    });

    expect(implicit.map((fact) => fact.id)).toEqual([childFact.id]);
    expect(explicit.map((fact) => fact.id)).toEqual([childFact.id]);
    expect(implicit.map((fact) => fact.id)).not.toContain(baseFact.id);
    expect(explicit.map((fact) => fact.id)).not.toContain(baseSuccessor.id);
  });
});
