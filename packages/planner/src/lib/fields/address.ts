/**
 * Conversions between the Address JSON commerce stores (`PartyAddressData`:
 * `street1`, `street2`, `city`, `state`, `postalCode`, `country`) and the
 * `AddressValue` smrt-svelte `AddressInput` edits (`street`, `province`, ...).
 * `AddressInput` prefixes its US subdivisions with `US-` to keep them apart
 * from country codes; the stored `state` is the bare code.
 */
import type { PartyAddressData } from '../upstream/partyTypes.ts';

/** What `AddressInput` edits. */
export interface AddressFormValue {
  street?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A stored address (any JSON) as the input's value. */
export function toAddressInput(stored: unknown): AddressFormValue {
  const a: PartyAddressData =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as PartyAddressData)
      : {};
  const country = text(a.country);
  const state = text(a.state);
  return {
    ...(text(a.street1) ? { street: a.street1 } : {}),
    ...(text(a.city) ? { city: a.city } : {}),
    ...(state ? { province: country === 'US' ? `US-${state}` : state } : {}),
    ...(text(a.postalCode) ? { postalCode: a.postalCode } : {}),
    ...(country ? { country } : {}),
  };
}

/**
 * The input's value as the stored address. Keeps what the input does not
 * edit (`street2`, anything else already stored) and drops emptied parts.
 */
export function fromAddressInput(
  edited: AddressFormValue,
  previous: unknown,
): PartyAddressData {
  const kept: Record<string, unknown> =
    previous !== null &&
    typeof previous === 'object' &&
    !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {};
  for (const key of ['street1', 'city', 'state', 'postalCode', 'country']) {
    delete kept[key];
  }
  const state = text(edited.province);
  return {
    ...kept,
    ...(text(edited.street) ? { street1: edited.street } : {}),
    ...(text(edited.city) ? { city: edited.city } : {}),
    ...(state ? { state: state.replace(/^US-/, '') } : {}),
    ...(text(edited.postalCode) ? { postalCode: edited.postalCode } : {}),
    ...(text(edited.country) ? { country: edited.country } : {}),
  };
}
