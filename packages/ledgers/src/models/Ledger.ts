import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { LedgerOptions } from '../types';

/**
 * A named accounting scope. Exact ledgers store one currency's minor units and
 * reject fractional entries; legacy journals without a ledger retain the
 * tolerant balance rule for backwards compatibility.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { skipApiCheck: true },
})
export class Ledger extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ description: 'The accounting scope name.' })
  name = '';

  /** ISO 4217 currency for this ledger's entries. */
  @field({ description: 'ISO 4217 currency used by this ledger.' })
  currency = 'USD';

  @field({
    description:
      'tolerant accepts decimal units; exact requires integer minor units.',
  })
  balanceMode: 'tolerant' | 'exact-integer' = 'tolerant';

  constructor(options: LedgerOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.balanceMode !== undefined)
      this.balanceMode = options.balanceMode;
  }

  async delete(): Promise<void> {
    throw new Error('Ledgers cannot be deleted');
  }

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    // A fresh accounting identity must never adopt another row by natural key.
    // Core enforces this with INSERT uniqueness, including concurrent callers.
    this.requireInsertOnSave({ preserveDerivedSlug: true });
    if (!['tolerant', 'exact-integer'].includes(this.balanceMode))
      throw new Error('Unknown ledger balance mode');
    if (this.id) {
      const stored = await this.db.get(this.tableName, { id: this.id });
      if (
        stored &&
        (stored.currency !== this.currency ||
          stored.balance_mode !== this.balanceMode ||
          stored.tenant_id !== this.tenantId)
      )
        throw new Error(
          'Ledger currency, balance mode and owner are immutable',
        );
    }
    if (!this.name.trim()) throw new Error('Ledger name is required');
    if (!/^[A-Z]{3}$/.test(this.currency))
      throw new Error('Ledger currency must be an uppercase ISO 4217 code');
  }
}
