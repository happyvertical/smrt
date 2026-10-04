import type { Snippet } from 'svelte';

/** Identity categories used by the presentation adapter. They do not create or migrate Profile records. */
export type PartyIdentityKind = 'business' | 'person';

/** Public Profile-shaped identity data accepted by customer and vendor surfaces. */
export interface PartyProfileData {
  id?: string;
  name: string;
  email?: string;
  description?: string;
  identityKind?: PartyIdentityKind;
}

/** Consumer-supplied contact projection. Persistence and relationship semantics stay with the caller. */
export interface PartyContactData {
  id?: string;
  name?: string;
  label?: string;
  email?: string;
  phone?: string;
  address?: string;
}

/** A postal address matching Commerce's public Address shape. */
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

/** Server-returned errors and retained form values. Keys are semantic field keys, independent of HTML names. */
export interface PartyFormErrors {
  form?: string;
  fields?: Record<string, string | undefined>;
  contacts?: Array<Record<string, string | undefined> | undefined>;
}

/** Customer form values exactly as entered. Currency text remains a string until the caller parses it. */
export interface CustomerFormValues {
  profileId?: string;
  identityKind?: PartyIdentityKind | '';
  name?: string;
  email?: string;
  description?: string;
  status?: string;
  customerType?: string;
  /** User-entered major-unit currency text, for example `1250.00`. */
  creditLimit?: string;
  paymentTerms?: string;
  taxExempt?: boolean;
  notes?: string;
  shippingAddress?: PartyAddressData;
  billingAddress?: PartyAddressData;
  contacts?: PartyContactData[];
}

/** Vendor form values exactly as entered. Currency text remains a string until the caller parses it. */
export interface VendorFormValues {
  profileId?: string;
  identityKind?: PartyIdentityKind | '';
  name?: string;
  email?: string;
  description?: string;
  status?: string;
  leadTimeDays?: string;
  /** User-entered major-unit currency text, for example `500.00`. */
  minimumOrder?: string;
  paymentTerms?: string;
  currency?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  notes?: string;
  contacts?: PartyContactData[];
}

/** Caller-controlled native form transport. Hidden values commonly carry tenant and request tokens. */
export interface PartyFormTransport {
  action?: string;
  method?: 'get' | 'post';
  hiddenFields?: Record<string, string>;
  intentName?: string;
  saveIntent?: string;
  addContactIntent?: string;
  removeContactIntent?: (index: number) => string;
}

/** Adaptable common field names. Repeated contact names are submitted in DOM order. */
export interface PartyFieldNames {
  profileId: string;
  identityKind: string;
  name: string;
  email: string;
  description: string;
  contactId: string;
  contactName: string;
  contactLabel: string;
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
}

/** Customer-specific field names. */
export interface CustomerFieldNames extends PartyFieldNames {
  status: string;
  customerType: string;
  creditLimit: string;
  paymentTerms: string;
  taxExempt: string;
  notes: string;
  shippingStreet1: string;
  shippingStreet2: string;
  shippingCity: string;
  shippingState: string;
  shippingPostalCode: string;
  shippingCountry: string;
  billingStreet1: string;
  billingStreet2: string;
  billingCity: string;
  billingState: string;
  billingPostalCode: string;
  billingCountry: string;
}

/** Vendor-specific field names. */
export interface VendorFieldNames extends PartyFieldNames {
  status: string;
  leadTimeDays: string;
  minimumOrder: string;
  paymentTerms: string;
  currency: string;
  defaultContactEmail: string;
  defaultContactPhone: string;
  notes: string;
}

/** Labels applications can override, including replacing “Customer” with “Client”. */
export interface PartySurfaceLabels {
  singular?: string;
  plural?: string;
  add?: string;
  edit?: string;
  save?: string;
  cancel?: string;
  search?: string;
  empty?: string;
  loading?: string;
  previous?: string;
  next?: string;
}

/** Labels for the shared repeatable contact editor. */
export interface PartyContactLabels {
  heading?: string;
  empty?: string;
  contact?: string;
  name?: string;
  role?: string;
  email?: string;
  phone?: string;
  address?: string;
  add?: string;
  remove?: string;
}

/** Directory item shared by customer and vendor list components. */
export interface PartyDirectoryItem<T> {
  data: T;
  href?: string;
}

/** Optional consumer content appended to a directory row. */
export type PartyDirectoryExtension<T> = Snippet<[T]>;

/** Optional consumer content appended to a detail or form. */
export type PartyExtension<T> = Snippet<[T]>;

export const DEFAULT_PARTY_FIELD_NAMES: PartyFieldNames = {
  profileId: 'profileId',
  identityKind: 'identityKind',
  name: 'name',
  email: 'email',
  description: 'description',
  contactId: 'contactId',
  contactName: 'contactName',
  contactLabel: 'contactLabel',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  contactAddress: 'contactAddress',
};

export const DEFAULT_CUSTOMER_FIELD_NAMES: CustomerFieldNames = {
  ...DEFAULT_PARTY_FIELD_NAMES,
  status: 'status',
  customerType: 'customerType',
  creditLimit: 'creditLimit',
  paymentTerms: 'paymentTerms',
  taxExempt: 'taxExempt',
  notes: 'notes',
  shippingStreet1: 'shippingStreet1',
  shippingStreet2: 'shippingStreet2',
  shippingCity: 'shippingCity',
  shippingState: 'shippingState',
  shippingPostalCode: 'shippingPostalCode',
  shippingCountry: 'shippingCountry',
  billingStreet1: 'billingStreet1',
  billingStreet2: 'billingStreet2',
  billingCity: 'billingCity',
  billingState: 'billingState',
  billingPostalCode: 'billingPostalCode',
  billingCountry: 'billingCountry',
};

export const DEFAULT_VENDOR_FIELD_NAMES: VendorFieldNames = {
  ...DEFAULT_PARTY_FIELD_NAMES,
  status: 'status',
  leadTimeDays: 'leadTimeDays',
  minimumOrder: 'minimumOrder',
  paymentTerms: 'paymentTerms',
  currency: 'currency',
  defaultContactEmail: 'defaultContactEmail',
  defaultContactPhone: 'defaultContactPhone',
  notes: 'notes',
};

/** Format explicit minor units for display without changing the transport value. */
export function formatPartyMinorUnits(
  amountMinor: number,
  currency: string,
  minorUnitExponent = 2,
  locale = 'en',
): string {
  if (!Number.isSafeInteger(amountMinor))
    throw new RangeError('Party amountMinor must be a safe integer');
  if (!Number.isInteger(minorUnitExponent) || minorUnitExponent < 0)
    throw new RangeError(
      'Party minorUnitExponent must be a non-negative integer',
    );
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnitExponent,
    maximumFractionDigits: minorUnitExponent,
  });
  const negative = amountMinor < 0;
  const raw = BigInt(Math.abs(amountMinor))
    .toString()
    .padStart(minorUnitExponent + 1, '0');
  const majorUnits = minorUnitExponent
    ? `${negative ? '-' : ''}${raw.slice(0, -minorUnitExponent)}.${raw.slice(-minorUnitExponent)}`
    : `${negative ? '-' : ''}${raw}`;
  // Node 26's ECMA-402 implementation accepts a decimal string without
  // coercing it through Number, preserving all safe-integer minor units.
  return (formatter.format as unknown as (value: string) => string)(majorUnits);
}

/** Compact a postal address for read-only display. */
export function formatPartyAddress(address?: PartyAddressData): string {
  if (!address) return '';
  return [
    address.street1,
    address.street2,
    [address.city, address.state].filter(Boolean).join(', '),
    address.postalCode,
    address.country,
  ]
    .filter(Boolean)
    .join('\n');
}
