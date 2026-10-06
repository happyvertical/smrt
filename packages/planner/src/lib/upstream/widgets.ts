/**
 * STAND-IN for happyvertical/smrt#3599 (`@field({ ui: { widget } })` in the
 * manifest) and the field hints happyvertical/smrt#3602 puts on commerce.
 *
 * Until the manifests carry `ui.widget`, this lists the hints for the fields
 * the recipes show; `overlay.ts` writes them onto the catalog's
 * `field.ui.widget` when it loads. When #3599 ships: regenerate the catalog,
 * delete this file and its call in `overlay.ts`.
 */
import type { CatalogFieldWidget } from '../catalog/types.ts';

const COMMERCE = '@happyvertical/smrt-commerce';

/** Widget by qualified model name, then field name (STI children inherit). */
export const FIELD_WIDGETS: Readonly<
  Record<string, Readonly<Record<string, CatalogFieldWidget>>>
> = {
  [`${COMMERCE}:Contract`]: {
    terms: 'textarea',
    notes: 'textarea',
    currency: 'currency',
  },
  [`${COMMERCE}:Customer`]: { notes: 'textarea' },
  [`${COMMERCE}:Vendor`]: {
    notes: 'textarea',
    currency: 'currency',
    defaultContactEmail: 'email',
    defaultContactPhone: 'phone',
  },
  '@happyvertical/smrt-profiles:Profile': {
    email: 'email',
    description: 'textarea',
  },
  '@happyvertical/smrt-products:Product': { description: 'textarea' },
};

/**
 * NOT part of #3599, whose widget list has no address entry: JSON fields that
 * hold an Address (`defaultShippingAddress` and the like), which the form
 * shows with `AddressInput`. Upstream the field's type is only `json`, so the
 * planner names them here; if the manifest ever types them, drop this.
 */
export const ADDRESS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [`${COMMERCE}:Customer`]: ['defaultShippingAddress', 'defaultBillingAddress'],
};
