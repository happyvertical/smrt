/**
 * Pipeline configuration tests: the idempotent default-pipeline seeder
 * (7 ordered stages), healing of partially-seeded pipelines, natural-key
 * upserts, and stage reconfiguration through plain collection operations
 * (no Lead/Opportunity model changes required).
 *
 * Real in-memory SQLite via `getTestDatabase()` — no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import { PipelineStageCollection } from '../collections/PipelineStageCollection.js';
import { DEFAULT_PIPELINE_KEY, DEFAULT_PIPELINE_STAGES } from '../types.js';

describe('Pipeline definitions and stages', () => {
  let db: DatabaseInterface;
  let pipelines: PipelineDefinitionCollection;
  let stages: PipelineStageCollection;

  beforeEach(async () => {
    db = await getTestDatabase();
    pipelines = await PipelineDefinitionCollection.create({ db });
    stages = await PipelineStageCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('ensureDefaultPipeline', () => {
    it('creates the default pipeline with the 7 default stages in order', async () => {
      const { pipeline, stages: seeded } =
        await pipelines.ensureDefaultPipeline();

      expect(pipeline.key).toBe(DEFAULT_PIPELINE_KEY);
      expect(pipeline.isDefault).toBe(true);
      expect(pipeline.status).toBe('active');

      expect(seeded).toHaveLength(7);
      expect(seeded.map((stage) => stage.key)).toEqual([
        'new',
        'qualified',
        'discovery',
        'proposal',
        'negotiation',
        'closed_won',
        'closed_lost',
      ]);
      expect(seeded.map((stage) => stage.probability)).toEqual([
        0.1, 0.25, 0.4, 0.6, 0.8, 1.0, 0.0,
      ]);

      const closedWon = seeded[5];
      const closedLost = seeded[6];
      expect(closedWon.isWon).toBe(true);
      expect(closedWon.isLost).toBe(false);
      expect(closedLost.isLost).toBe(true);
      expect(closedLost.isWon).toBe(false);
      // Every non-terminal stage carries neither flag.
      for (const stage of seeded.slice(0, 5)) {
        expect(stage.isTerminal()).toBe(false);
      }
    });

    it('is idempotent — a second call creates nothing new', async () => {
      const first = await pipelines.ensureDefaultPipeline();
      const second = await pipelines.ensureDefaultPipeline();

      expect(second.pipeline.id).toBe(first.pipeline.id);
      expect(second.stages).toHaveLength(7);
      expect(second.stages.map((s) => s.id).sort()).toEqual(
        first.stages.map((s) => s.id).sort(),
      );
      expect(await pipelines.list({})).toHaveLength(1);
      expect(await stages.list({})).toHaveLength(7);
    });

    it('heals a partially-seeded pipeline without touching surviving stages', async () => {
      const { pipeline, stages: seeded } =
        await pipelines.ensureDefaultPipeline();
      const proposal = seeded.find((stage) => stage.key === 'proposal');
      if (!proposal?.id) throw new Error('expected seeded proposal stage');
      await stages.delete(proposal.id);

      // Reconfigure a surviving stage; healing must not clobber it.
      const discovery = seeded.find((stage) => stage.key === 'discovery');
      if (!discovery) throw new Error('expected seeded discovery stage');
      discovery.name = 'Deep Discovery';
      discovery.probability = 0.45;
      await discovery.save();

      const healed = await pipelines.ensureDefaultPipeline();
      expect(healed.pipeline.id).toBe(pipeline.id);
      expect(healed.stages).toHaveLength(7);
      expect(healed.stages.map((stage) => stage.key)).toContain('proposal');

      const healedDiscovery = healed.stages.find(
        (stage) => stage.key === 'discovery',
      );
      expect(healedDiscovery?.name).toBe('Deep Discovery');
      expect(healedDiscovery?.probability).toBe(0.45);
    });

    it('matches the exported DEFAULT_PIPELINE_STAGES seed', () => {
      expect(DEFAULT_PIPELINE_STAGES).toHaveLength(7);
      expect(DEFAULT_PIPELINE_STAGES[0]).toEqual({
        key: 'new',
        name: 'New',
        probability: 0.1,
      });
      expect(DEFAULT_PIPELINE_STAGES[5].isWon).toBe(true);
      expect(DEFAULT_PIPELINE_STAGES[6].isLost).toBe(true);
    });
  });

  describe('stage configurability (no model changes needed)', () => {
    it('supports custom pipelines with custom stages', async () => {
      const enterprise = await pipelines.create({
        key: 'enterprise',
        name: 'Enterprise motion',
      });
      const enterpriseId = enterprise.id ?? '';

      await stages.create({
        pipelineId: enterpriseId,
        key: 'security_review',
        name: 'Security Review',
        sortOrder: 10,
        probability: 0.3,
      });
      await stages.create({
        pipelineId: enterpriseId,
        key: 'signed',
        name: 'Signed',
        sortOrder: 20,
        probability: 1.0,
        isWon: true,
      });

      const listed = await pipelines.getStages(enterpriseId);
      expect(listed.map((stage) => stage.key)).toEqual([
        'security_review',
        'signed',
      ]);
      expect(await pipelines.findByKey('enterprise')).not.toBeNull();
    });

    it('supports inserting and reordering stages via plain updates', async () => {
      const { pipeline } = await pipelines.ensureDefaultPipeline();
      const pipelineId = pipeline.id ?? '';

      // Insert a custom stage between proposal (40) and negotiation (50).
      await stages.create({
        pipelineId,
        key: 'legal_review',
        name: 'Legal Review',
        sortOrder: 45,
        probability: 0.7,
      });

      let ordered = await pipelines.getStages(pipelineId);
      expect(ordered.map((stage) => stage.key)).toEqual([
        'new',
        'qualified',
        'discovery',
        'proposal',
        'legal_review',
        'negotiation',
        'closed_won',
        'closed_lost',
      ]);

      // Reorder: move legal_review ahead of proposal.
      const legal = await stages.findByKey(pipelineId, 'legal_review');
      if (!legal) throw new Error('expected legal_review stage');
      legal.sortOrder = 35;
      await legal.save();

      ordered = await pipelines.getStages(pipelineId);
      expect(ordered.map((stage) => stage.key)).toEqual([
        'new',
        'qualified',
        'discovery',
        'legal_review',
        'proposal',
        'negotiation',
        'closed_won',
        'closed_lost',
      ]);
    });

    it('upserts on the (pipeline_id, key) natural key instead of duplicating', async () => {
      const { pipeline } = await pipelines.ensureDefaultPipeline();
      const pipelineId = pipeline.id ?? '';

      await stages.create({
        pipelineId,
        key: 'legal_review',
        name: 'Legal Review',
        sortOrder: 45,
        probability: 0.7,
      });
      await stages.create({
        pipelineId,
        key: 'legal_review',
        name: 'Legal + Compliance Review',
        sortOrder: 45,
        probability: 0.72,
      });

      const matches = (await pipelines.getStages(pipelineId)).filter(
        (stage) => stage.key === 'legal_review',
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('Legal + Compliance Review');
      expect(matches[0].probability).toBe(0.72);
    });

    it('requires pipelineId and key on stages', async () => {
      await expect(
        stages.create({ key: 'orphan', name: 'No pipeline' }),
      ).rejects.toThrow();
      const { pipeline } = await pipelines.ensureDefaultPipeline();
      await expect(
        stages.create({ pipelineId: pipeline.id ?? '', name: 'No key' }),
      ).rejects.toThrow();
    });
  });
});
