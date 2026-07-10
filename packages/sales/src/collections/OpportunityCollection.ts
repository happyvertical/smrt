import { SmrtCollection } from '@happyvertical/smrt-core';
import { Opportunity } from '../models/Opportunity.js';

function byStageChangeThenValue(rows: Opportunity[]): Opportunity[] {
  return [...rows].sort((left, right) => {
    const leftTime = left.lastStageChangeAt?.getTime() ?? 0;
    const rightTime = right.lastStageChangeAt?.getTime() ?? 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.expectedValue - left.expectedValue;
  });
}

export class OpportunityCollection extends SmrtCollection<Opportunity> {
  static readonly _itemClass = Opportunity;

  async getByLeadId(leadId: string): Promise<Opportunity | null> {
    const rows = await this.list({ where: { leadId } });
    return rows[0] ?? null;
  }

  async byOwner(ownerId: string): Promise<Opportunity[]> {
    return this.list({ where: { ownerId } });
  }

  async byStage(stageId: string): Promise<Opportunity[]> {
    return byStageChangeThenValue(await this.list({ where: { stageId } }));
  }

  async byPipeline(pipelineId: string): Promise<Opportunity[]> {
    return byStageChangeThenValue(await this.list({ where: { pipelineId } }));
  }

  async open(): Promise<Opportunity[]> {
    return byStageChangeThenValue(
      await this.list({ where: { outcome: 'open' } }),
    );
  }
}
