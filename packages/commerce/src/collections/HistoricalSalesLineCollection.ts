import { SmrtCollection } from '@happyvertical/smrt-core';
import { HistoricalSalesLine } from '../models/HistoricalSalesLine.js';
export class HistoricalSalesLineCollection extends SmrtCollection<HistoricalSalesLine> {
  static readonly _itemClass = HistoricalSalesLine;
}
