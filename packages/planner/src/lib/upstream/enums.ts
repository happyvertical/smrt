/**
 * STAND-IN for happyvertical/smrt#3598 (the scanner emitting `enum: [...]` for
 * enum- and literal-union-typed fields).
 *
 * Until the published manifests carry `enum`, this file lists the allowed
 * values of the fields the recipes show, copied in declaration order from the
 * s-m-r-t source (`packages/commerce/src/types/index.ts`,
 * `packages/inventory/src/types.ts`). `overlay.ts` writes them onto the
 * catalog's `field.enum` when the catalog loads, so every consumer reads the
 * same field the manifest will fill. When #3598 ships: regenerate the catalog,
 * delete this file and its call in `overlay.ts`.
 */

/** `ContractStatus` (commerce `Contract.status`). */
export const CONTRACT_STATUS = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'completed',
  'cancelled',
] as const;

/** `ContractType` (commerce `Contract.contractType`). */
export const CONTRACT_TYPE = [
  'estimate',
  'order',
  'lease',
  'agreement',
  'purchase_order',
  'wholesale_order',
  'production_order',
  'cart',
  'license_sale',
] as const;

/** `CustomerStatus` and `VendorStatus` share their values. */
export const PARTY_STATUS = ['active', 'inactive', 'suspended'] as const;

/** `CustomerType`. */
export const CUSTOMER_TYPE = ['dtc', 'wholesale', 'retail'] as const;

/** `StockState` (inventory). */
export const STOCK_STATE = [
  'available',
  'allocated',
  'wip',
  'qc_hold',
  'damaged',
] as const;

/**
 * Allowed values by qualified model name, then field name. A model with no
 * entry of its own uses its parent's (STI children, see `overlay.ts`), as the
 * scanner would see the inherited field.
 */
export const ENUM_VALUES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  '@happyvertical/smrt-commerce:Contract': {
    status: CONTRACT_STATUS,
    contractType: CONTRACT_TYPE,
  },
  '@happyvertical/smrt-commerce:Customer': {
    status: PARTY_STATUS,
    customerType: CUSTOMER_TYPE,
  },
  '@happyvertical/smrt-commerce:Vendor': {
    status: PARTY_STATUS,
  },
  '@happyvertical/smrt-inventory:StockLevel': {
    state: STOCK_STATE,
  },
};
