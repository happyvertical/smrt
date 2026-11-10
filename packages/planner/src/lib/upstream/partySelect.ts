/**
 * Shared by the `CustomerSelect` / `VendorSelect` stand-ins (see those files):
 * a party DTO as a picker option, "profile name plus status and type".
 */

import type { RelationOption } from '@happyvertical/smrt-svelte/forms';
import type { CustomerDisplayData, VendorDisplayData } from './partyTypes.ts';

export function customerOption(customer: CustomerDisplayData): RelationOption {
  const detail = [customer.status, customer.customerType]
    .filter(Boolean)
    .join(' · ');
  return {
    id: customer.id,
    label: customer.profile.name,
    ...(detail ? { detail } : {}),
  };
}

export function vendorOption(vendor: VendorDisplayData): RelationOption {
  return {
    id: vendor.id,
    label: vendor.profile.name,
    ...(vendor.status ? { detail: vendor.status } : {}),
  };
}
