/**
 * FactCollection tests - getEntityBriefing
 *
 * Tests for the entity briefing feature which aggregates
 * facts related to a specific entity via FactSubject links.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactSubjectCollection } from '../fact-subjects';
import { FactCollection } from '../facts';

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
    expect(facts.semanticSearch).toHaveBeenCalledWith(
      'catalog',
      expect.objectContaining({ limit: 15 }),
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

  it('resolves latest catalog facts in the text fallback without chain queries', async () => {
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
    ).toHaveLength(1);
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
});
