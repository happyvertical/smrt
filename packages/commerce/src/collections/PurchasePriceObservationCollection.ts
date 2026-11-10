import { SmrtCollection } from '@happyvertical/smrt-core';
import { PurchasePriceObservation } from '../models/PurchasePriceObservation.js';
export class PurchasePriceObservationCollection extends SmrtCollection<PurchasePriceObservation> {
  static readonly _itemClass = PurchasePriceObservation;
}
