/**
 * Cross-model behavior tests: `LeadCollection.qualify()` (lead → opportunity
 * at the pipeline's first stage, idempotently, with audit activities) and
 * `OpportunityCollection.moveToStage()` (validated stage progression,
 * probability adoption, terminal outcomes, and stage_change audit rows).
 *
 * Real in-memory SQLite via `getTestDatabase()` — no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import { PipelineStageCollection } from '../collections/PipelineStageCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import type { PipelineStage } from '../models/PipelineStage.js';

describe('qualify() and moveToStage()', () => {
  let db: DatabaseInterface;
  let leads: LeadCollection;
  let opportunities: OpportunityCollection;
  let pipelines: PipelineDefinitionCollection;
  let stages: PipelineStageCollection;
  let activities: SalesActivityCollection;

  beforeEach(async () => {
    db = await getTestDatabase();
    leads = await LeadCollection.create({ db });
    opportunities = await OpportunityCollection.create({ db });
    pipelines = await PipelineDefinitionCollection.create({ db });
    stages = await PipelineStageCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  const stageByKey = (list: PipelineStage[], key: string): PipelineStage => {
    const stage = list.find((candidate) => candidate.key === key);
    if (!stage) throw new Error(`expected stage '${key}'`);
    return stage;
  };

  describe('LeadCollection.qualify()', () => {
    it('qualifies the lead and creates an opportunity at the first default stage', async () => {
      const lead = await leads.create({
        name: 'Acme retrofit',
        sourceKind: 'campaign',
        sourceId: 'spring-2026',
        ownerRepId: '',
      });

      const opportunity = await leads.qualify({
        leadId: lead.id ?? '',
        expectedValueCents: 250_000_00,
        currency: 'CAD',
      });

      const reloadedLead = await leads.get({ id: lead.id });
      expect(reloadedLead?.status).toBe('qualified');
      expect(reloadedLead?.qualifiedAt).toBeInstanceOf(Date);

      expect(opportunity.name).toBe('Acme retrofit'); // defaults to lead name
      expect(opportunity.leadId).toBe(lead.id);
      expect(opportunity.status).toBe('open');
      expect(opportunity.expectedValueCents).toBe(250_000_00);
      expect(opportunity.currency).toBe('CAD');
      // Copied acquisition source for reporting.
      expect(opportunity.sourceKind).toBe('campaign');
      expect(opportunity.sourceId).toBe('spring-2026');

      // Landed on the default pipeline's first stage with its probability.
      const { pipeline, stages: seeded } =
        await pipelines.ensureDefaultPipeline();
      expect(opportunity.pipelineId).toBe(pipeline.id);
      expect(opportunity.stageId).toBe(stageByKey(seeded, 'new').id);
      expect(opportunity.probability).toBe(0.1);

      // Audit activities on BOTH subjects.
      const leadTrail = await activities.findBySubject('lead', lead.id ?? '');
      expect(
        leadTrail.filter((row) => row.activityKind === 'qualification'),
      ).toHaveLength(1);
      const oppTrail = await activities.findBySubject(
        'opportunity',
        opportunity.id ?? '',
      );
      expect(
        oppTrail.filter((row) => row.activityKind === 'qualification'),
      ).toHaveLength(1);
      const detail = oppTrail[0].getMetadata();
      expect(detail.leadId).toBe(lead.id);
    });

    it('is idempotent — a second call returns the existing opportunity without new rows', async () => {
      const lead = await leads.create({ name: 'Idempotent qualify' });

      const first = await leads.qualify({ leadId: lead.id ?? '' });
      const second = await leads.qualify({ leadId: lead.id ?? '' });

      expect(second.id).toBe(first.id);
      expect(await opportunities.findByLead(lead.id ?? '')).toHaveLength(1);
      const trail = await activities.findBySubject('lead', lead.id ?? '');
      expect(
        trail.filter((row) => row.activityKind === 'qualification'),
      ).toHaveLength(1);
    });

    it('honors explicit params (name, owner, pipeline, close date)', async () => {
      const custom = await pipelines.create({
        key: 'enterprise',
        name: 'Enterprise motion',
      });
      const entry = await stages.create({
        pipelineId: custom.id ?? '',
        key: 'security_review',
        name: 'Security Review',
        sortOrder: 10,
        probability: 0.33,
      });
      const closeAt = new Date('2026-12-01T00:00:00.000Z');
      const lead = await leads.create({ name: 'Custom params' });

      const opportunity = await leads.qualify({
        leadId: lead.id ?? '',
        opportunityName: 'Enterprise mega-deal',
        pipelineId: custom.id ?? '',
        ownerRepId: '',
        expectedCloseAt: closeAt,
      });

      expect(opportunity.name).toBe('Enterprise mega-deal');
      expect(opportunity.pipelineId).toBe(custom.id);
      expect(opportunity.stageId).toBe(entry.id);
      expect(opportunity.probability).toBe(0.33);
      expect(opportunity.expectedCloseAt?.getTime()).toBe(closeAt.getTime());
    });

    it('rejects qualifying a disqualified lead (illegal transition)', async () => {
      const lead = await leads.create({ name: 'Disqualified' });
      lead.status = 'disqualified';
      await lead.save();

      await expect(leads.qualify({ leadId: lead.id ?? '' })).rejects.toThrow(
        /illegal status transition/i,
      );
      // Nothing was created for the failed qualification.
      expect(await opportunities.findByLead(lead.id ?? '')).toHaveLength(0);
    });

    it('rejects an unknown lead and an unknown pipeline', async () => {
      await expect(
        leads.qualify({ leadId: 'aaaaaaaa-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(/not found/i);

      const lead = await leads.create({ name: 'Unknown pipeline' });
      await expect(
        leads.qualify({
          leadId: lead.id ?? '',
          pipelineId: 'bbbbbbbb-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('OpportunityCollection.moveToStage()', () => {
    it('progresses through stages, adopting each stage probability', async () => {
      const lead = await leads.create({ name: 'Progression' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
      const { stages: seeded } = await pipelines.ensureDefaultPipeline();

      const discovery = stageByKey(seeded, 'discovery');
      const moved = await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: discovery.id ?? '',
      });
      expect(moved.stageId).toBe(discovery.id);
      expect(moved.probability).toBe(0.4);
      expect(moved.status).toBe('open');

      const negotiation = stageByKey(seeded, 'negotiation');
      const moved2 = await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: negotiation.id ?? '',
        probabilityOverride: 0.85,
      });
      expect(moved2.stageId).toBe(negotiation.id);
      expect(moved2.probability).toBe(0.85); // override beats stage default

      // stage_change audit rows carry from/to detail.
      const trail = await activities.findBySubject(
        'opportunity',
        opportunity.id ?? '',
      );
      const changes = trail.filter(
        (row) => row.activityKind === 'stage_change',
      );
      expect(changes).toHaveLength(2);
      const firstDetail = changes[0].getMetadata();
      expect(firstDetail.toStageId).toBe(discovery.id);
      expect(firstDetail.toStageKey).toBe('discovery');
      expect(firstDetail.fromStatus).toBe('open');
      expect(firstDetail.toStatus).toBe('open');
      const secondDetail = changes[1].getMetadata();
      expect(secondDetail.fromStageId).toBe(discovery.id);
      expect(secondDetail.probability).toBe(0.85);
    });

    it('closed_won sets status won + wonAt and probability 1.0', async () => {
      const lead = await leads.create({ name: 'Winner' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
      const { stages: seeded } = await pipelines.ensureDefaultPipeline();

      const won = await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: stageByKey(seeded, 'closed_won').id ?? '',
      });

      expect(won.status).toBe('won');
      expect(won.wonAt).toBeInstanceOf(Date);
      expect(won.lostAt).toBeNull();
      expect(won.probability).toBe(1.0);

      const reloaded = await opportunities.get({ id: opportunity.id });
      expect(reloaded?.status).toBe('won');
      const trail = await activities.findBySubject(
        'opportunity',
        opportunity.id ?? '',
      );
      const change = trail.find((row) => row.activityKind === 'stage_change');
      expect(change?.getMetadata().toStatus).toBe('won');
    });

    it('closed_lost sets status lost + lostAt + outcomeReason', async () => {
      const lead = await leads.create({ name: 'Loser' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
      const { stages: seeded } = await pipelines.ensureDefaultPipeline();

      const lost = await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: stageByKey(seeded, 'closed_lost').id ?? '',
        outcomeReason: 'budget cut',
      });

      expect(lost.status).toBe('lost');
      expect(lost.lostAt).toBeInstanceOf(Date);
      expect(lost.wonAt).toBeNull();
      expect(lost.outcomeReason).toBe('budget cut');
      expect(lost.probability).toBe(0.0);
    });

    it('rejects a stage from another pipeline', async () => {
      const lead = await leads.create({ name: 'Wrong pipeline' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });

      const other = await pipelines.create({ key: 'other', name: 'Other' });
      const foreignStage = await stages.create({
        pipelineId: other.id ?? '',
        key: 'foreign',
        name: 'Foreign',
        sortOrder: 10,
        probability: 0.5,
      });

      await expect(
        opportunities.moveToStage({
          opportunityId: opportunity.id ?? '',
          stageId: foreignStage.id ?? '',
        }),
      ).rejects.toThrow(/belongs to pipeline/i);
    });

    it('rejects moves after a terminal status', async () => {
      const lead = await leads.create({ name: 'Post terminal' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
      const { stages: seeded } = await pipelines.ensureDefaultPipeline();

      await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: stageByKey(seeded, 'closed_won').id ?? '',
      });

      await expect(
        opportunities.moveToStage({
          opportunityId: opportunity.id ?? '',
          stageId: stageByKey(seeded, 'discovery').id ?? '',
        }),
      ).rejects.toThrow(/terminal/i);
    });

    it('rejects unknown opportunities and unknown stages', async () => {
      await expect(
        opportunities.moveToStage({
          opportunityId: 'cccccccc-0000-0000-0000-000000000000',
          stageId: 'dddddddd-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/not found/i);

      const lead = await leads.create({ name: 'Unknown stage' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
      await expect(
        opportunities.moveToStage({
          opportunityId: opportunity.id ?? '',
          stageId: 'dddddddd-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('guards raw status forcing on opportunities (won is terminal)', async () => {
      const lead = await leads.create({ name: 'Raw forcing' });
      const opportunity = await leads.qualify({ leadId: lead.id ?? '' });
      const { stages: seeded } = await pipelines.ensureDefaultPipeline();
      await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: stageByKey(seeded, 'closed_won').id ?? '',
      });

      const loaded = await opportunities.get({ id: opportunity.id });
      if (!loaded) throw new Error('expected opportunity to load');
      loaded.status = 'open';
      await expect(loaded.save()).rejects.toThrow(/illegal status transition/i);

      // The create-onto-existing-id path is guarded too.
      await expect(
        opportunities.create({
          id: opportunity.id,
          name: loaded.name,
          status: 'open',
        }),
      ).rejects.toThrow(/illegal status transition/i);
    });
  });
});
