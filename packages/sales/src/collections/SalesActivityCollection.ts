import { SmrtCollection } from '@happyvertical/smrt-core';
import { SalesActivity } from '../models/SalesActivity.js';

function byOccurredAt(rows: SalesActivity[]): SalesActivity[] {
  return [...rows].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  );
}

export class SalesActivityCollection extends SmrtCollection<SalesActivity> {
  static readonly _itemClass = SalesActivity;

  async forLead(leadId: string): Promise<SalesActivity[]> {
    return byOccurredAt(await this.list({ where: { leadId } }));
  }

  async forLeadIds(leadIds: string[]): Promise<SalesActivity[]> {
    if (leadIds.length === 0) {
      return [];
    }
    return byOccurredAt(await this.list({ where: { 'leadId in': leadIds } }));
  }

  async forOpportunity(opportunityId: string): Promise<SalesActivity[]> {
    return byOccurredAt(await this.list({ where: { opportunityId } }));
  }
}
