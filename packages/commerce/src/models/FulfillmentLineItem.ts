/**
 * FulfillmentLineItem model - tracks which contract items were fulfilled
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Sub-unit rounding tolerance for the over-fulfillment cap, matching the rest
 * of the package's EPSILON convention. Quantities are decimal, so a tiny
 * float-summation overshoot must not trip the guard.
 */
const FULFILLMENT_QUANTITY_EPSILON = 0.01;

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
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class FulfillmentLineItem extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global fulfillment line items
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent fulfillment
   */
  @foreignKey('Fulfillment')
  fulfillmentId: string = '';

  /**
   * Contract line item being fulfilled
   */
  @foreignKey('ContractLineItem')
  contractLineItemId: string = '';

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
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.fulfillmentId !== undefined)
      this.fulfillmentId = options.fulfillmentId;
    if (options.contractLineItemId !== undefined)
      this.contractLineItemId = options.contractLineItemId;
    if (options.quantityFulfilled !== undefined)
      this.quantityFulfilled = options.quantityFulfilled;
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Save-time over-fulfillment guard (S5 audit #1390 follow-up):
   *  - `quantityFulfilled` must be a finite, positive number, and
   *  - the sum of all FulfillmentLineItems against the referenced
   *    ContractLineItem (this row included) must not exceed the ordered
   *    `ContractLineItem.quantity`.
   *
   * Without this, a caller could ship 50 of 10 ordered — the direct parallel
   * to the PaymentAllocation over-allocation hole #1390 closed. The cap is
   * enforced against the persisted ContractLineItem row; a `contractLineItemId`
   * that doesn't resolve to a real line item is a hard error (the cap can't be
   * enforced otherwise, and the field carries a `@foreignKey` requirement).
   */
  override async save(): Promise<this> {
    if (
      !Number.isFinite(this.quantityFulfilled) ||
      this.quantityFulfilled <= 0
    ) {
      throw new Error(
        `FulfillmentLineItem ${this.id ?? '<new>'}: quantityFulfilled must be a ` +
          `positive number (got ${this.quantityFulfilled}).`,
      );
    }

    if (this.contractLineItemId) {
      const orderedRow = await this.db.get('contract_line_items', {
        id: this.contractLineItemId,
      });
      if (!orderedRow) {
        throw new Error(
          `FulfillmentLineItem ${this.id ?? '<new>'}: referenced ContractLineItem ` +
            `'${this.contractLineItemId}' does not exist — refusing to fulfill ` +
            'against a missing line item (the over-fulfillment cap cannot be ' +
            'enforced otherwise).',
        );
      }
      const ordered = Number(orderedRow.quantity);

      const { FulfillmentLineItemCollection } = await import(
        '../collections/FulfillmentLineItemCollection.js'
      );
      const siblings = await (FulfillmentLineItemCollection as any).create(
        this.options,
      );
      const existing = await siblings.findByContractLineItem(
        this.contractLineItemId,
      );
      const otherFulfilled = existing.reduce(
        (sum: number, item: FulfillmentLineItem) =>
          item.id === this.id ? sum : sum + item.quantityFulfilled,
        0,
      );

      if (
        Number.isFinite(ordered) &&
        otherFulfilled + this.quantityFulfilled - ordered >
          FULFILLMENT_QUANTITY_EPSILON
      ) {
        throw new Error(
          `FulfillmentLineItem ${this.id ?? '<new>'}: fulfilling ` +
            `${this.quantityFulfilled} would over-fulfill contract line ` +
            `'${this.contractLineItemId}' — already fulfilled ${otherFulfilled} ` +
            `of ${ordered} ordered.`,
        );
      }
    }

    return super.save() as Promise<this>;
  }
}

export default FulfillmentLineItem;
