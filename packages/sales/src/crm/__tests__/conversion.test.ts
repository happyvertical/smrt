/**
 * OpportunityConversion tests: `recordConversion()` is idempotent on the
 * `(opportunityId, targetKind, targetId)` natural key, requires a WON
 * opportunity, and never creates downstream records itself (it only links).
 *
 * Real in-memory SQLite via `getTestDatabase()` — no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
import { OpportunityConversionCollection } from '../collections/OpportunityConversionCollection.js';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import type { Opportunity } from '../models/Opportunity.js';

describe('OpportunityConversionCollection.recordConversion()', () => {
  let db: DatabaseInterface;
  let leads: LeadCollection;
  let opportunities: OpportunityCollection;
  let pipelines: PipelineDefinitionCollection;
  let conversions: OpportunityConversionCollection;

  beforeEach(async () => {
    db = await getTestDatabase();
    leads = await LeadCollection.create({ db });
    opportunities = await OpportunityCollection.create({ db });
    pipelines = await PipelineDefinitionCollection.create({ db });
    conversions = await OpportunityConversionCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  /** Qualify a lead and close the resulting opportunity as won. */
  const wonOpportunity = async (name: string): Promise<Opportunity> => {
    const lead = await leads.create({ name });
    const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
    const { stages } = await pipelines.ensureDefaultPipeline();
    const closedWon = stages.find((stage) => stage.key === 'closed_won');
    if (!closedWon) throw new Error('expected closed_won stage');
    return await opportunities.moveToStage({
      opportunityId: opportunity.id ?? '',
      stageId: closedWon.id ?? '',
    });
  };

  it('records a conversion for a won opportunity', async () => {
    const opportunity = await wonOpportunity('Converts');

    const { conversion, created } = await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'contract',
      targetId: 'contract-123',
      note: 'annual services agreement',
    });

    expect(created).toBe(true);
    expect(conversion.opportunityId).toBe(opportunity.id);
    expect(conversion.targetKind).toBe('contract');
    expect(conversion.targetId).toBe('contract-123');
    expect(conversion.note).toBe('annual services agreement');
  });

  it('is idempotent — repeats return created:false and the same row', async () => {
    const opportunity = await wonOpportunity('Idempotent');

    const first = await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'subscription',
      targetId: 'sub-9',
    });
    const second = await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'subscription',
      targetId: 'sub-9',
      note: 'retry with a note — ignored, link already exists',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.conversion.id).toBe(first.conversion.id);
    expect(second.conversion.note).toBe(''); // existing row returned untouched
    expect(
      await conversions.findByOpportunity(opportunity.id ?? ''),
    ).toHaveLength(1);
  });

  it('refuses a raw create onto an existing conversion link (codex P2)', async () => {
    const opportunity = await wonOpportunity('Guarded');
    const first = await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'client',
      targetId: 'client-77',
      note: 'original link',
    });

    // A generated-surface create carrying the same natural key would
    // upsert over the append-only link — refused.
    await expect(
      conversions.create({
        opportunityId: opportunity.id ?? '',
        targetKind: 'client',
        targetId: 'client-77',
        note: 'rewritten note',
      }),
    ).rejects.toThrow(/append-only/);
    expect((await conversions.get({ id: first.conversion.id }))?.note).toBe(
      'original link',
    );
  });

  it('allows several links per opportunity with distinct targets', async () => {
    const opportunity = await wonOpportunity('Multi target');

    await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'client',
      targetId: 'client-1',
    });
    await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'project',
      targetId: 'project-1',
    });
    await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'project',
      targetId: 'project-2',
    });

    const links = await conversions.findByOpportunity(opportunity.id ?? '');
    expect(links).toHaveLength(3);
    expect(links.map((link) => `${link.targetKind}:${link.targetId}`)).toEqual([
      'client:client-1',
      'project:project-1',
      'project:project-2',
    ]);
  });

  it('rejects conversions for open opportunities', async () => {
    const lead = await leads.create({ name: 'Still open' });
    const opportunity = await leads.qualify({ leadId: lead.id ?? '' });

    await expect(
      conversions.recordConversion({
        opportunityId: opportunity.id ?? '',
        targetKind: 'client',
        targetId: 'client-x',
      }),
    ).rejects.toThrow(/won/i);
    expect(
      await conversions.findByOpportunity(opportunity.id ?? ''),
    ).toHaveLength(0);
  });

  it('rejects conversions for lost opportunities', async () => {
    const lead = await leads.create({ name: 'Lost deal' });
    const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
    const { stages } = await pipelines.ensureDefaultPipeline();
    const closedLost = stages.find((stage) => stage.key === 'closed_lost');
    if (!closedLost) throw new Error('expected closed_lost stage');
    await opportunities.moveToStage({
      opportunityId: opportunity.id ?? '',
      stageId: closedLost.id ?? '',
      outcomeReason: 'went with competitor',
    });

    await expect(
      conversions.recordConversion({
        opportunityId: opportunity.id ?? '',
        targetKind: 'client',
        targetId: 'client-x',
      }),
    ).rejects.toThrow(/won/i);
  });

  it('rejects conversions for unknown opportunities', async () => {
    await expect(
      conversions.recordConversion({
        opportunityId: '99999999-0000-0000-0000-000000000000',
        targetKind: 'client',
        targetId: 'client-x',
      }),
    ).rejects.toThrow(/not found/i);
  });
});
