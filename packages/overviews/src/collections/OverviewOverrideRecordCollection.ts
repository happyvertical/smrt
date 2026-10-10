import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  OverviewOverrideRecord,
  type OverviewScope,
  TENANT_SCOPE_KEY,
} from '../models/OverviewOverrideRecord.js';

/**
 * Reads of {@link OverviewOverrideRecord}. Not decorated: the model has no
 * generated surface, so a decorated collection would only add a second
 * manifest schema for the same table.
 */
export class OverviewOverrideRecordCollection extends SmrtCollection<OverviewOverrideRecord> {
  static readonly _itemClass = OverviewOverrideRecord;

  /**
   * The row of one tier, or `null`. The tenant predicate is explicit (not
   * only the interceptor's) because a super-admin bypass context does not
   * filter reads.
   */
  async findTier(
    tenantId: string,
    overviewId: string,
    scope: OverviewScope,
    userId?: string,
  ): Promise<OverviewOverrideRecord | null> {
    const scopeKey = scope === 'tenant' ? TENANT_SCOPE_KEY : userId;
    if (!scopeKey) return null;
    const rows = await this.list({
      where: { tenantId, overviewId, scopeType: scope, scopeKey },
      limit: 1,
    });
    return rows[0] ?? null;
  }
}
