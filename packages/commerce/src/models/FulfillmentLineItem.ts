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
   * Save-time over-fulfillment guard (S5 audit #1390 follow-up, round 2):
   *  - `quantityFulfilled` must be a finite, positive number,
   *  - the referenced `ContractLineItem` must resolve **within the caller's
   *    tenant scope** AND belong to the same contract as the parent
   *    Fulfillment, and
   *  - the sum of all FulfillmentLineItems against that ContractLineItem
   *    (this row included) must not exceed the ordered `ContractLineItem.quantity`.
   *
   * Without this, a caller could ship 50 of 10 ordered — the direct parallel
   * to the PaymentAllocation over-allocation hole #1390 closed.
   *
   * Tenant isolation (round 2): the ContractLineItem is loaded through
   * `ContractLineItemCollection`, so it goes through the tenancy
   * auto-filtering interceptors. A cross-tenant `contractLineItemId` therefore
   * fails closed — it resolves to `null` and trips the existing "does not
   * exist" error rather than leaking a foreign-tenant ordered quantity. The
   * raw `this.db.get('contract_line_items', …)` it replaced bypassed those
   * filters. We additionally load the parent Fulfillment (also tenant-scoped)
   * and reject when the line item belongs to a *different* contract than the
   * Fulfillment is fulfilling, so a valid-but-unrelated line id can't be
   * used to fulfill against the wrong order.
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
      const { ContractLineItemCollection } = await import(
        '../collections/ContractLineItemCollection.js'
      );
      const lineItems = await (ContractLineItemCollection as any).create(
        this.options,
      );
      const orderedLineItem = await lineItems.get(this.contractLineItemId);
      if (!orderedLineItem) {
        throw new Error(
          `FulfillmentLineItem ${this.id ?? '<new>'}: referenced ContractLineItem ` +
            `'${this.contractLineItemId}' does not exist — refusing to fulfill ` +
            'against a missing line item (the over-fulfillment cap cannot be ' +
            'enforced otherwise).',
        );
      }

      // The line item must belong to the same contract the parent Fulfillment
      // is fulfilling. Otherwise a caller could point a Fulfillment for
      // contract A at a line item from contract B (over-fulfilling B's order
      // via A's shipment, and falsifying both contracts' fulfilled totals).
      if (this.fulfillmentId) {
        const { FulfillmentCollection } = await import(
          '../collections/FulfillmentCollection.js'
        );
        const fulfillments = await (FulfillmentCollection as any).create(
          this.options,
        );
        const fulfillment = await fulfillments.get(this.fulfillmentId);
        if (
          fulfillment &&
          orderedLineItem.contractId !== fulfillment.contractId
        ) {
          throw new Error(
            `FulfillmentLineItem ${this.id ?? '<new>'}: ContractLineItem ` +
              `'${this.contractLineItemId}' belongs to contract ` +
              `'${orderedLineItem.contractId}', but its Fulfillment ` +
              `'${this.fulfillmentId}' fulfills contract ` +
              `'${fulfillment.contractId}' — refusing to fulfill a line item ` +
              'from a different contract.',
          );
        }
      }

      const ordered = Number(orderedLineItem.quantity);

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
