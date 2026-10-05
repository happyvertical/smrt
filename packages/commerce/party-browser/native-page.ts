import { render } from 'svelte/server';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';
import CustomerDirectory from '../src/svelte/components/CustomerDirectory.svelte';
import VendorForm from '../src/svelte/components/VendorForm.svelte';
import VendorDirectory from '../src/svelte/components/VendorDirectory.svelte';
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

export function renderNativeDirectoriesPage(): string {
  const customer = render(CustomerDirectory, {
    props: {
      searchAction: '/directory-search',
      query: 'Initial client',
      status: 'active',
      queryName: 'term',
      statusName: 'state',
      hiddenFields: {
        page: '1',
        pageSize: '10',
        sort: 'name',
        direction: 'desc',
        term: 'ignored query',
        state: 'suspended',
      },
      labels: { singular: 'Client', plural: 'Clients' },
    },
  }).body;
  const vendor = render(VendorDirectory, {
    props: {
      searchAction: '/directory-search',
      query: 'Initial vendor',
      status: 'inactive',
      hiddenFields: {
        pageSize: '25',
        direction: 'asc',
        q: 'ignored query',
        status: 'suspended',
      },
    },
  }).body;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Native party directories</title></head><body><section id="customer-directory">${customer}</section><section id="vendor-directory">${vendor}</section></body></html>`;
}
