import { SmrtCollection } from '@happyvertical/smrt-core';
import { TaxCode } from '../models/TaxCode.js';

export class TaxCodeCollection extends SmrtCollection<TaxCode> {
  static readonly _itemClass = TaxCode;

  /**
   * Find a code by its stable `code`. Pass `tenantId` whenever it is known:
   * without an active tenancy filter the lookup is otherwise unscoped.
   */
  async findByCode(code: string, tenantId?: string): Promise<TaxCode | null> {
    return (
      (
        await this.list({
          where: tenantId ? { code, tenantId } : { code },
          limit: 1,
        })
      )[0] ?? null
    );
  }
}
