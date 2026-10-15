import { SmrtCollection } from '@happyvertical/smrt-core';
import { TaxCode } from '../models/TaxCode.js';

export class TaxCodeCollection extends SmrtCollection<TaxCode> {
  static readonly _itemClass = TaxCode;

  async findByCode(code: string): Promise<TaxCode | null> {
    return (await this.list({ where: { code }, limit: 1 }))[0] ?? null;
  }
}
