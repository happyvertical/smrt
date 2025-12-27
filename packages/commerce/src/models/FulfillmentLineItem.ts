/**
 * FulfillmentLineItem model - tracks which contract items were fulfilled
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { ContractLineItem } from './ContractLineItem.js';
import { Fulfillment } from './Fulfillment.js';

/**
 * FulfillmentLineItem tracks which contract line items are included
 * in a specific fulfillment and how much was fulfilled.
 *
 * This allows partial fulfillment - e.g., shipping 5 of 10 items ordered.
 *
 * @example
 * ```typescript
 * const fulfillmentItem = await fulfillmentItems.create({
 *   fulfillmentId: fulfillment.id,
 *   contractLineItemId: lineItem.id,
 *   quantityFulfilled: 5  // of 10 ordered
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class FulfillmentLineItem extends SmrtObject {
  /**
   * Parent fulfillment
   */
  fulfillmentId = foreignKey(Fulfillment);

  /**
   * Contract line item being fulfilled
   */
  contractLineItemId = foreignKey(ContractLineItem);

  /**
   * Quantity fulfilled in this fulfillment
   */
  quantityFulfilled: number = 1.0;

  /**
   * Notes about this line item
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.fulfillmentId !== undefined)
      this.fulfillmentId = options.fulfillmentId;
    if (options.contractLineItemId !== undefined)
      this.contractLineItemId = options.contractLineItemId;
    if (options.quantityFulfilled !== undefined)
      this.quantityFulfilled = options.quantityFulfilled;
    if (options.notes !== undefined) this.notes = options.notes;
  }
}

export default FulfillmentLineItem;
