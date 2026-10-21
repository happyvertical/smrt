/**
 * LotDocumentCollection — read access to documents attached to lots.
 * Writes go through {@link LotService}.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { LotDocument } from '../models/LotDocument.js';

export class LotDocumentCollection extends SmrtCollection<LotDocument> {
  static readonly _itemClass = LotDocument;
}
