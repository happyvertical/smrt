import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { OBSERVED_PURCHASE_WRITE } from '../observed-purchase-price-internal.js';

/** Original purchase evidence with explicitly unavailable monetary aggregates. */
@TenantScoped({ mode: 'required' })
@smrt({ api: false, cli: false, mcp: false })
export class PurchasePriceObservation extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text' }) sourceIdentity = '';
  @field({ type: 'text' }) vendorId = '';
  @field({ type: 'text' }) snapshotJson = '';
  @field({ type: 'text' }) completionJson = '';
  constructor(
    options: SmrtObjectOptions & Partial<PurchasePriceObservation> = {},
  ) {
    super(options);
    for (const key of [
      'tenantId',
      'sourceIdentity',
      'vendorId',
      'snapshotJson',
      'completionJson',
    ] as const)
      if (options[key] !== undefined) this[key] = options[key];
  }
  override async save(_options?: SmrtSaveOptions): Promise<this> {
    throw new Error(
      'Purchase price observations require their owning commands',
    );
  }
  async saveObserved(
    capability: typeof OBSERVED_PURCHASE_WRITE,
    options?: SmrtSaveOptions,
  ): Promise<this> {
    if (capability !== OBSERVED_PURCHASE_WRITE)
      throw new Error(
        'Purchase price observations require their owning commands',
      );
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Original purchase price evidence cannot be deleted');
  }
}
