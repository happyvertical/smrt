/**
 * PipelineStageCollection — collection manager for PipelineStage.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { PipelineStage } from '../models/PipelineStage.js';

export class PipelineStageCollection extends SmrtCollection<PipelineStage> {
  static readonly _itemClass = PipelineStage;

  /**
   * List a pipeline's stages in board order.
   *
   * @param pipelineId - Owning PipelineDefinition id
   * @returns Stages ordered by `sortOrder` ascending
   */
  async findByPipeline(pipelineId: string): Promise<PipelineStage[]> {
    return await this.list({
      where: { pipelineId },
      orderBy: 'sort_order ASC',
    });
  }

  /**
   * Find one stage by its natural key within a pipeline.
   *
   * @param pipelineId - Owning PipelineDefinition id
   * @param key - Stage machine key (e.g. `'proposal'`)
   * @returns The stage, or null when the key does not exist in the pipeline
   */
  async findByKey(
    pipelineId: string,
    key: string,
  ): Promise<PipelineStage | null> {
    const results = await this.list({
      where: { pipelineId, key },
      limit: 1,
    });
    return results[0] ?? null;
  }
}

export default PipelineStageCollection;
