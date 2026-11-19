import { SmrtCollection } from '@happyvertical/smrt-core';
import { Correspondent } from '../models/Correspondent.js';

export class CorrespondentCollection extends SmrtCollection<Correspondent> {
  static readonly _itemClass = Correspondent;
}
