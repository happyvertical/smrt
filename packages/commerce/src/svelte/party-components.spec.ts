import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { COMMERCE_UI_SLOTS } from '../ui.js';
import CustomerDetail from './components/CustomerDetail.svelte';
import CustomerDirectory from './components/CustomerDirectory.svelte';
import CustomerForm from './components/CustomerForm.svelte';
import VendorDetail from './components/VendorDetail.svelte';
import VendorDirectory from './components/VendorDirectory.svelte';
import VendorForm from './components/VendorForm.svelte';
import type { CustomerDisplayData, VendorDisplayData } from './party-types.js';

const customer: CustomerDisplayData = {
  id: 'customer-1',
  profileId: 'profile-1',
  profile: {
    id: 'profile-1',
    name: 'Riverstone Newsroom',
    email: 'accounts@riverstone.example',
    identityKind: 'business',
  },
  status: 'active',
  customerType: 'wholesale',
  creditLimitMinor: 125000,
  paymentTerms: 'Net 30',
  contacts: [
    { id: 'contact-1', name: 'Avery Chen', email: 'avery@example.test' },
  ],
};

const vendor: VendorDisplayData = {
  id: 'vendor-1',
  profileId: 'profile-2',
  profile: {
    id: 'profile-2',
    name: 'Northstar Supply',
    identityKind: 'business',
  },
  status: 'active',
  leadTimeDays: 7,
  minimumOrderMinor: 50000,
  paymentTerms: 'Net 45',
  currency: 'CAD',
  contacts: [{ id: 'contact-2', name: 'Morgan Lee', phone: '+1 403 555 0117' }],
};

describe('customer and vendor SSR surfaces', () => {
  it('publishes the party UI slots and registers every public surface', async () => {
    ModuleUIRegistry.clear();
    await import('./index.js');
    for (const slot of [
      'customer-directory',
      'customer-detail',
      'customer-form',
      'vendor-directory',
      'vendor-detail',
      'vendor-form',
      'party-contact-fields',
    ]) {
      expect(COMMERCE_UI_SLOTS[slot]?.propsInterface).toBeTruthy();
      expect(ModuleUIRegistry.has('@happyvertical/smrt-commerce', slot)).toBe(
        true,
      );
    }
  });

  it('renders populated, empty, loading, and error directory states with caller-owned navigation', () => {
    const populated = render(CustomerDirectory, {
      props: {
        items: [{ data: customer, href: '/clients/customer-1' }],
        total: 26,
        page: 1,
        pageSize: 25,
        nextHref: '/clients?page=2',
        addHref: '/clients/new',
        canCreate: true,
        labels: { singular: 'Client', plural: 'Clients' },
      },
    }).body;
    expect(populated).toContain('Riverstone Newsroom');
    expect(populated).toContain('href="/clients/customer-1"');
    expect(populated).toContain('href="/clients?page=2"');
    expect(populated).toContain('Add Client');

    expect(render(VendorDirectory, { props: { items: [] } }).body).toContain(
      'No vendors found',
    );
    expect(
      render(VendorDirectory, { props: { loading: true } }).body,
    ).toContain('Loading vendors');
    expect(
      render(VendorDirectory, {
        props: { errorMessage: 'Service unavailable' },
      }).body,
    ).toContain('Service unavailable');
  });

  it('renders customer and vendor details with contacts and presentation-only capabilities', () => {
    const customerHtml = render(CustomerDetail, {
      props: {
        customer,
        currency: 'CAD',
        editHref: '/clients/customer-1/edit',
        canEdit: false,
      },
    }).body;
    expect(customerHtml).toContain('Riverstone Newsroom');
    expect(customerHtml).toContain('$1,250.00');
    expect(customerHtml).toContain('Avery Chen');
    expect(customerHtml).not.toContain('/clients/customer-1/edit');

    const vendorHtml = render(VendorDetail, {
      props: { vendor, editHref: '/vendors/vendor-1/edit', canEdit: true },
    }).body;
    expect(vendorHtml).toContain('Northstar Supply');
    expect(vendorHtml).toContain('$500.00');
    expect(vendorHtml).toContain('Morgan Lee');
    expect(vendorHtml).toContain('href="/vendors/vendor-1/edit"');
  });

  it('keeps customer error values, hidden tokens, custom names, and native submitter intent', () => {
    const html = render(CustomerForm, {
      props: {
        mode: 'edit',
        values: {
          profileId: 'profile-1',
          identityKind: 'business',
          name: 'Retained & raw',
          creditLimit: '1250.0oops',
          shippingAddress: { city: 'Retained City' },
          contacts: [
            { id: 'contact-1', name: 'Retained contact', email: 'bad@email' },
          ],
        },
        errors: {
          form: 'Correct the highlighted values',
          fields: {
            creditLimit: 'Enter a currency amount',
            shippingCity: 'Choose a supported city',
          },
          contacts: [{ email: 'Enter a valid email' }],
        },
        transport: {
          action: '?/update',
          hiddenFields: {
            requestToken: 'request-123',
            tenantToken: 'tenant-9',
          },
          intentName: '_action',
          saveIntent: 'commitCustomer',
          addContactIntent: 'appendContact',
        },
        fieldNames: { creditLimit: 'credit_limit' },
      },
    }).body;
    expect(html).toContain('action="?/update"');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="Retained &amp; raw"');
    expect(html).toContain('name="credit_limit"');
    expect(html).toContain('value="1250.0oops"');
    expect(html).toContain('value="Retained City"');
    expect(html).toContain('Choose a supported city');
    expect(html).toMatch(
      /<input[^>]+value="request-123"[^>]+name="requestToken"/,
    );
    expect(html).toMatch(/<input[^>]+value="tenant-9"[^>]+name="tenantToken"/);
    expect(html).toContain('name="_action" value="appendContact"');
    expect(html).toContain('name="_action" value="commitCustomer"');
    expect(html).toContain('Enter a valid email');
  });

  it('keeps vendor create values and provides no-JavaScript add/remove submitters', () => {
    const html = render(VendorForm, {
      props: {
        values: {
          identityKind: 'person',
          name: 'Sam Supplier',
          minimumOrder: '500.00',
          contacts: [{ id: 'contact-2', name: 'Sam', phone: 'raw phone' }],
        },
        transport: {
          action: '/vendors/create',
          addContactIntent: 'add-row',
          removeContactIntent: (index: number) => `remove-row-${index}`,
        },
      },
    }).body;
    expect(html).toContain('value="person" selected');
    expect(html).toContain('value="500.00"');
    expect(html).toContain('value="raw phone"');
    expect(html).toContain('name="intent" value="add-row"');
    expect(html).toContain('name="intent" value="remove-row-0"');
  });
});
