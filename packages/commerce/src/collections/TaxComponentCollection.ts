import { SmrtCollection } from '@happyvertical/smrt-core';
import { TaxComponent } from '../models/TaxComponent.js';

export class TaxComponentCollection extends SmrtCollection<TaxComponent> {
  static readonly _itemClass = TaxComponent;
}
