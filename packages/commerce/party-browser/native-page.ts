import { render } from 'svelte/server';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';
import VendorForm from '../src/svelte/components/VendorForm.svelte';
import CustomActionsFormHarness from './CustomActionsFormHarness.svelte';

export function renderNativePage(): string {
  const body = render(CustomerForm, {
    props: {
      values: {
        identityKind: 'business',
        name: 'Native Client',
        creditLimit: '1250.00',
        shippingAddress: {
          street1: '100 Main Street',
          city: 'Vancouver',
          state: 'BC',
          postalCode: 'V6B 1A1',
          country: 'CA',
        },
        contacts: [{ id: 'contact-native', name: 'Native Contact' }],
      },
      transport: {
        action: '/party-submit',
        hiddenFields: { requestToken: 'native-request', expectedTenantId: 'tenant-native' },
        addContactIntent: 'add-native-contact',
      },
      fieldNames: { name: 'clientName' },
    },
  }).body;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Native party form</title></head><body>${body}</body></html>`;
}

export function renderNativeVendorPage(): string {
  const body = render(VendorForm, {
    props: {
      values: {
        identityKind: 'business',
        name: 'Native Vendor',
        leadTimeDays: '7oops',
        minimumOrder: '500.00',
        currency: 'CAD',
        contacts: [{ id: 'contact-native', name: 'Native Vendor Contact' }],
      },
      transport: {
        action: '/party-submit',
        hiddenFields: { requestToken: 'native-vendor-request' },
      },
    },
  }).body;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Native vendor form</title></head><body>${body}</body></html>`;
}

export function renderNativeCustomActionsPage(): string {
  const body = render(CustomActionsFormHarness, {
    props: { action: '/party-submit' },
  }).body;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Native custom action form</title></head><body>${body}</body></html>`;
}
