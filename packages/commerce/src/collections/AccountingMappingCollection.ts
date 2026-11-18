/**
 * AccountingMappingCollection - accounting mappings (#5137). Writes go through
 * the accounting-mapping commands; see `agents/accounting-mapping.md`.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  AccountingMapping,
  type AccountingMappingKind,
} from '../models/AccountingMapping.js';

/** Realm and environment a mapping set belongs to. */
export interface AccountingMappingScope {
  readonly tenantId: string;
  readonly provider: 'quickbooks';
  readonly realmId: string;
  readonly environment: 'sandbox' | 'production';
}

export class AccountingMappingCollection extends SmrtCollection<AccountingMapping> {
  static readonly _itemClass = AccountingMapping;

  /** @internal An unsaved mapping for the commands, which own every write. */
  async build(
    options: Parameters<SmrtCollection<AccountingMapping>['create']>[0],
  ): Promise<AccountingMapping> {
    return this.createUnsaved(options);
  }

  /** The mapping for one local key in a scope, or `null` (any status). */
  async findByKey(
    scope: AccountingMappingScope,
    kind: AccountingMappingKind,
    localId: string,
  ): Promise<AccountingMapping | null> {
    const rows = await this.list({
      where: { ...scope, kind, localId },
      limit: 2,
    });
    if (rows.length > 1) throw new Error('Duplicate accounting mapping');
    return rows[0] ?? null;
  }

  /** Active mappings in a scope, optionally of one kind. */
  async listActive(
    scope: AccountingMappingScope,
    kind?: AccountingMappingKind,
  ): Promise<AccountingMapping[]> {
    return this.list({
      where: { ...scope, status: 'active', ...(kind ? { kind } : {}) },
    });
  }
}
