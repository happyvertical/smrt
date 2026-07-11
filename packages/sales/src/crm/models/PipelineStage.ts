/**
 * PipelineStage — one ordered step of a PipelineDefinition.
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { PipelineStageOptions } from '../types.js';

/**
 * PipelineStage is a configurable step within a pipeline. Stages carry the
 * default win `probability` an opportunity adopts on entry and the terminal
 * flags (`isWon`/`isLost`) that close an opportunity when it moves in
 * (see `OpportunityCollection.moveToStage()`).
 *
 * Natural key `(pipeline_id, key)` (`conflictColumns`) — re-seeding a stage
 * key within a pipeline upserts. Stages are plain rows: rename, re-weight,
 * insert, or reorder (via `sortOrder`) with normal collection operations —
 * no Lead/Opportunity model change is ever needed.
 *
 * @example
 * ```typescript
 * const stages = await PipelineStageCollection.create({ db });
 * await stages.create({
 *   pipelineId: pipeline.id,
 *   key: 'legal_review',
 *   name: 'Legal Review',
 *   sortOrder: 45, // between seeded proposal (40) and negotiation (50)
 *   probability: 0.7,
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
  conflictColumns: ['pipeline_id', 'key'],
})
export class PipelineStage extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global stages.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Owning pipeline. Required. */
  @foreignKey('PipelineDefinition', { required: true })
  pipelineId: string = '';

  /**
   * Stable machine key, unique within the pipeline (natural key with
   * `pipelineId`). Required — e.g. `'proposal'`, `'closed_won'`.
   */
  @field({ required: true })
  key: string = '';

  /** Human-readable stage name shown on board columns. */
  name: string = '';

  /** Ordering within the pipeline (ascending). Seeded in steps of 10. */
  sortOrder: number = 0;

  /**
   * Default win probability (`0`–`1`, DECIMAL) adopted by an opportunity
   * entering this stage unless the move overrides it.
   */
  probability: number = 0.0;

  /** Terminal flag: moving an opportunity here closes it as `won`. */
  isWon: boolean = false;

  /** Terminal flag: moving an opportunity here closes it as `lost`. */
  isLost: boolean = false;

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: PipelineStageOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.pipelineId !== undefined) this.pipelineId = options.pipelineId;
    if (options.key !== undefined) this.key = options.key;
    if (options.name !== undefined) this.name = options.name;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.probability !== undefined)
      this.probability = options.probability;
    if (options.isWon !== undefined) this.isWon = options.isWon;
    if (options.isLost !== undefined) this.isLost = options.isLost;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether entering this stage closes the opportunity (won or lost). */
  isTerminal(): boolean {
    return this.isWon || this.isLost;
  }

  /** Parse the metadata JSON string; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the metadata object. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }
}

export default PipelineStage;
