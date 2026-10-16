/**
 * STAND-IN for the party DTOs of `@happyvertical/smrt-commerce/svelte`
 * (`packages/commerce/src/svelte/party-types.ts`, happyvertical/smrt#3602
 * builds `CustomerSelect` / `VendorSelect` on them). Copied verbatim, minus the
 * form and directory types the selectors do not use. When #3602 ships, import
 * these from the published package and delete this file.
 */

export type PartyIdentityKind = 'business' | 'person';

/** Public Profile-shaped identity data accepted by customer and vendor surfaces. */
export interface PartyProfileData {
  id?: string;
  name: string;
  email?: string;
  description?: string;
  identityKind?: PartyIdentityKind;
}

export interface PartyContactData {
  id?: string;
  name?: string;
  label?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface PartyAddressData {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/** Customer DTO for UI rendering. Money is always an integer count of currency minor units. */
export interface CustomerDisplayData {
  id: string;
  profileId?: string;
  profile: PartyProfileData;
  status: string;
  customerType?: string;
  /** Credit limit in integer minor units, never decimal major units. */
  creditLimitMinor?: number;
  paymentTerms?: string;
  taxExempt?: boolean;
  defaultShippingAddress?: PartyAddressData;
  defaultBillingAddress?: PartyAddressData;
  notes?: string;
  contacts?: PartyContactData[];
}

/** Vendor DTO for UI rendering. Money is always an integer count of currency minor units. */
export interface VendorDisplayData {
  id: string;
  profileId?: string;
  profile: PartyProfileData;
  status: string;
  leadTimeDays?: number;
  /** Minimum order in integer minor units, never decimal major units. */
  minimumOrderMinor?: number;
  paymentTerms?: string;
  currency?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  notes?: string;
  contacts?: PartyContactData[];
}
