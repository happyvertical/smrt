import { SmrtCollection } from '@happyvertical/smrt-core';
import { SalesContract } from '../models/Contract.js';

/** Read customer-side contracts across every sales STI subtype. */
export class SalesContractCollection extends SmrtCollection<SalesContract> {
  static readonly _itemClass = SalesContract;

  async findByCustomer(customerId: string): Promise<SalesContract[]> {
    return this.list({
      where: { customerId },
      orderBy: 'created_at DESC',
    });
  }
}
