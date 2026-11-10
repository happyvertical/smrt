import { SmrtCollection } from '@happyvertical/smrt-core';
import { PurchaseContract } from '../models/Contract.js';

/** Read supplier-side contracts across every purchase STI subtype. */
export class PurchaseContractCollection extends SmrtCollection<PurchaseContract> {
  static readonly _itemClass = PurchaseContract;

  async findByVendor(vendorId: string): Promise<PurchaseContract[]> {
    return this.list({
      where: { vendorId },
      orderBy: 'created_at DESC',
    });
  }
}
