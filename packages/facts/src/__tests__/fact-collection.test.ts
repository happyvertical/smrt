/**
 * FactCollection tests - getEntityBriefing
 *
 * Tests for the entity briefing feature which aggregates
 * facts related to a specific entity via FactSubject links.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
