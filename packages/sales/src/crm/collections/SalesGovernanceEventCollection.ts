/** Read immutable operation outcomes and history in the current tenant. */
import { SmrtCollection } from '@happyvertical/smrt-core';
import { SalesGovernanceEvent } from '../models/SalesGovernanceEvent.js';

export class SalesGovernanceEventCollection extends SmrtCollection<SalesGovernanceEvent> {
  static readonly _itemClass = SalesGovernanceEvent;
}
