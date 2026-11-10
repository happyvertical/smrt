/**
 * LotCorrectionCollection — read access to the append-only correction
 * trail. Writes go through {@link LotService}.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { LotCorrection } from '../models/LotCorrection.js';

export class LotCorrectionCollection extends SmrtCollection<LotCorrection> {
  static readonly _itemClass = LotCorrection;
}
