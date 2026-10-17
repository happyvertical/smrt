import { SmrtCollection } from '@happyvertical/smrt-core';
import { HistoricalCustomerFunds } from '../models/HistoricalCustomerFunds.js';
import { HistoricalCustomerFundsAllocation } from '../models/HistoricalCustomerFundsAllocation.js';
export class HistoricalCustomerFundsCollection extends SmrtCollection<HistoricalCustomerFunds> {
  static readonly _itemClass = HistoricalCustomerFunds;
}
export class HistoricalCustomerFundsAllocationCollection extends SmrtCollection<HistoricalCustomerFundsAllocation> {
  static readonly _itemClass = HistoricalCustomerFundsAllocation;
}
