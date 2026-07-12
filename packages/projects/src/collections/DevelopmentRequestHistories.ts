import { SmrtCollection } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { DevelopmentRequestHistory } from '../models/DevelopmentRequestHistory';

export class DevelopmentRequestHistoryCollection extends SmrtCollection<DevelopmentRequestHistory> {
  static readonly _itemClass = DevelopmentRequestHistory;

  async listForRequest(
    tenantId: string,
    requestId: string,
  ): Promise<DevelopmentRequestHistory[]> {
    return withTenant({ tenantId }, () =>
      this.list({
        where: { tenantId, requestId },
        orderBy: 'createdAt ASC',
      }),
    );
  }
}
