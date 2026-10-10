import { SmrtCollection } from '@happyvertical/smrt-core';
import type { PreferenceScope } from '../kinds.js';
import {
  TENANT_SCOPE_KEY,
  UiPreferenceRecord,
} from '../models/UiPreferenceRecord.js';

/**
 * Reads of {@link UiPreferenceRecord}. Not decorated: the model has no
 * generated surface, so a decorated collection would only add a second
 * manifest schema for the same table.
 */
export class UiPreferenceRecordCollection extends SmrtCollection<UiPreferenceRecord> {
  static readonly _itemClass = UiPreferenceRecord;

  /**
   * The row of one tier, or `null`. The tenant predicate is explicit (not
   * only the interceptor's) because a super-admin bypass context does not
   * filter reads.
   */
  async findTier(
    tenantId: string,
    kind: string,
    surfaceId: string,
    scope: PreferenceScope,
    userId?: string,
  ): Promise<UiPreferenceRecord | null> {
    const scopeKey = scope === 'tenant' ? TENANT_SCOPE_KEY : userId;
    if (!scopeKey) return null;
    const rows = await this.list({
      where: { tenantId, kind, surfaceId, scopeType: scope, scopeKey },
      limit: 1,
    });
    return rows[0] ?? null;
  }
}
