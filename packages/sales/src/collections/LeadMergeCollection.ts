import { SmrtCollection } from '@happyvertical/smrt-core';
import { LeadMerge } from '../models/LeadMerge.js';

export class LeadMergeCollection extends SmrtCollection<LeadMerge> {
  static readonly _itemClass = LeadMerge;

  async findBySourceLeadId(sourceLeadId: string): Promise<LeadMerge | null> {
    const rows = await this.list({ where: { sourceLeadId } });
    return rows[0] ?? null;
  }

  async forTargetLead(targetLeadId: string): Promise<LeadMerge[]> {
    const rows = await this.list({ where: { targetLeadId } });
    return rows.sort(
      (left, right) => left.mergedAt.getTime() - right.mergedAt.getTime(),
    );
  }
}
