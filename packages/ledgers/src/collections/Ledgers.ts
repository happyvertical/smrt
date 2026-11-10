import { SmrtCollection } from '@happyvertical/smrt-core';
import { Ledger } from '../models/Ledger';

export class LedgerCollection extends SmrtCollection<Ledger> {
  static readonly _itemClass = Ledger;
}
