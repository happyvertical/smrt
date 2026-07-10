import { SmrtCollection } from '@happyvertical/smrt-core';
import { PipelineStage } from '../models/PipelineStage.js';
import type { PipelineStageKey } from '../types.js';

function sortStages(stages: PipelineStage[]): PipelineStage[] {
  return [...stages].sort((left, right) => left.sortOrder - right.sortOrder);
}

export class PipelineStageCollection extends SmrtCollection<PipelineStage> {
  static readonly _itemClass = PipelineStage;

  async forPipeline(pipelineId: string): Promise<PipelineStage[]> {
    return sortStages(await this.list({ where: { pipelineId } }));
  }

  async findByKey(
    pipelineId: string,
    key: PipelineStageKey,
  ): Promise<PipelineStage | null> {
    const rows = await this.list({ where: { pipelineId, key } });
    return rows[0] ?? null;
  }

  async getNextStage(stage: PipelineStage): Promise<PipelineStage | null> {
    const stages = await this.forPipeline(stage.pipelineId);
    const currentIndex = stages.findIndex(
      (candidate) => candidate.id === stage.id,
    );
    if (currentIndex < 0 || currentIndex + 1 >= stages.length) {
      return null;
    }
    return stages[currentIndex + 1] ?? null;
  }

  async getPreviousStage(stage: PipelineStage): Promise<PipelineStage | null> {
    const stages = await this.forPipeline(stage.pipelineId);
    const currentIndex = stages.findIndex(
      (candidate) => candidate.id === stage.id,
    );
    if (currentIndex <= 0) {
      return null;
    }
    return stages[currentIndex - 1] ?? null;
  }
}
