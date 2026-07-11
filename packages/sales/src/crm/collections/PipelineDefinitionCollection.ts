/**
 * PipelineDefinitionCollection — collection manager for PipelineDefinition,
 * including the idempotent default-pipeline seeder.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { PipelineDefinition } from '../models/PipelineDefinition.js';
import type { PipelineStage } from '../models/PipelineStage.js';
import {
  DEFAULT_PIPELINE_KEY,
  DEFAULT_PIPELINE_STAGES,
  type EnsureDefaultPipelineParams,
  type EnsureDefaultPipelineResult,
} from '../types.js';
import { PipelineStageCollection } from './PipelineStageCollection.js';

/** Narrow a possibly-unset SmrtObject id into a usable string. */
function requireId(value: string | null | undefined, what: string): string {
  if (!value) {
    throw new Error(`PipelineDefinitionCollection: ${what} has no id`);
  }
  return value;
}

export class PipelineDefinitionCollection extends SmrtCollection<PipelineDefinition> {
  static readonly _itemClass = PipelineDefinition;

  private stageCollectionPromise: Promise<PipelineStageCollection> | null =
    null;

  /** Sibling stage collection sharing this collection's DB connection. */
  private async getStageCollection(): Promise<PipelineStageCollection> {
    if (!this.stageCollectionPromise) {
      this.stageCollectionPromise = PipelineStageCollection.create({
        db: this.db,
      });
    }
    return this.stageCollectionPromise;
  }

  /**
   * Find one pipeline by its machine key (natural key within the tenant
   * scope — ambient tenancy auto-filters the lookup).
   */
  async findByKey(key: string): Promise<PipelineDefinition | null> {
    const results = await this.list({ where: { key }, limit: 1 });
    return results[0] ?? null;
  }

  /**
   * Find the pipeline flagged `isDefault` (informational designation).
   */
  async findDefault(): Promise<PipelineDefinition | null> {
    const results = await this.list({
      where: { isDefault: true },
      orderBy: 'created_at ASC',
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * A pipeline's stages in board order (`sortOrder` ascending).
   */
  async getStages(pipelineId: string): Promise<PipelineStage[]> {
    const stages = await this.getStageCollection();
    return await stages.findByPipeline(pipelineId);
  }

  /**
   * Idempotently find-or-create the seeded default pipeline (key
   * `'default'`, `isDefault: true`) and its 7 default stages:
   * `new(0.1) → qualified(0.25) → discovery(0.4) → proposal(0.6) →
   * negotiation(0.8) → closed_won(1.0, isWon) → closed_lost(0.0, isLost)`.
   *
   * Idempotency is per stage KEY: a second call creates nothing, and a
   * partially-seeded pipeline (e.g. an interrupted first run) is healed by
   * creating only the missing keys. Existing stages are never overwritten —
   * renames, re-weights, reorders, and custom stages added via normal
   * PipelineStage operations all survive re-runs.
   *
   * Tenancy: under an ambient `withTenant()` context the pipeline/stages
   * auto-scope to that tenant; pass `tenantId` to seed for a specific tenant
   * from a system/global context. Lookup is by natural key, so each tenant
   * gets exactly one seeded default pipeline.
   *
   * @returns The pipeline plus ALL of its stages ordered by `sortOrder`
   *   (including any custom stages added since seeding)
   */
  async ensureDefaultPipeline(
    params: EnsureDefaultPipelineParams = {},
  ): Promise<EnsureDefaultPipelineResult> {
    const tenantScope =
      params.tenantId !== undefined ? { tenantId: params.tenantId } : {};

    let pipeline = (
      await this.list({
        where: { key: DEFAULT_PIPELINE_KEY, ...tenantScope },
        limit: 1,
      })
    )[0];

    if (!pipeline) {
      pipeline = await this.create({
        ...tenantScope,
        key: DEFAULT_PIPELINE_KEY,
        name: 'Default Sales Pipeline',
        isDefault: true,
        status: 'active',
      });
    }

    const pipelineId = requireId(pipeline.id, 'default pipeline');
    const stagesCollection = await this.getStageCollection();
    const existing = await stagesCollection.findByPipeline(pipelineId);
    const existingKeys = new Set(existing.map((stage) => stage.key));

    // Stage tenancy follows the pipeline row (auto-populated under ambient
    // tenancy; explicit when the pipeline was seeded with a tenantId param).
    const stageTenantScope =
      pipeline.tenantId !== null
        ? { tenantId: pipeline.tenantId }
        : tenantScope;

    for (const [index, seed] of DEFAULT_PIPELINE_STAGES.entries()) {
      if (existingKeys.has(seed.key)) continue;
      await stagesCollection.create({
        ...stageTenantScope,
        pipelineId,
        key: seed.key,
        name: seed.name,
        // Steps of 10 leave headroom to slot custom stages between defaults.
        sortOrder: (index + 1) * 10,
        probability: seed.probability,
        isWon: seed.isWon ?? false,
        isLost: seed.isLost ?? false,
      });
    }

    const stages = await stagesCollection.findByPipeline(pipelineId);
    return { pipeline, stages };
  }
}

export default PipelineDefinitionCollection;
