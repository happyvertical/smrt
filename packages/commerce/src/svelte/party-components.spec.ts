import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CustomActionsFormHarness from '../../party-browser/CustomActionsFormHarness.svelte';
import PartyI18nHarness from '../../test-support/PartyI18nHarness.svelte';
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

function customerMoney(
  amountMinor: number,
  currency = 'CAD',
  minorUnitExponent = 2,
): string {
  return render(CustomerDetail, {
    props: {
      customer: { ...customer, creditLimitMinor: amountMinor },
      currency,
      minorUnitExponent,
      locale: 'en',
    },
  }).body;
}

function vendorMoney(
  amountMinor: number,
  currency = 'CAD',
  minorUnitExponent = 2,
): string {
  return render(VendorDetail, {
    props: {
      vendor: { ...vendor, minimumOrderMinor: amountMinor, currency },
      minorUnitExponent,
      locale: 'en',
    },
  }).body;
}

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

  it('does not invent an identity category when profile identity is missing or unknown', () => {
    const missingCustomerIdentity = render(CustomerDetail, {
      props: {
        customer: {
          ...customer,
          profile: { ...customer.profile, identityKind: undefined },
        },
      },
    }).body;
    const missingVendorIdentity = render(VendorDetail, {
      props: {
        vendor: {
          ...vendor,
          profile: { ...vendor.profile, identityKind: undefined },
        },
      },
    }).body;
    expect(missingCustomerIdentity).toMatch(
      /<dt[^>]*>Type<\/dt><dd[^>]*>Not recorded<\/dd>/,
    );
    expect(missingVendorIdentity).toMatch(
      /<dt[^>]*>Type<\/dt><dd[^>]*>Not recorded<\/dd>/,
    );

    const unknownCustomerIdentity = render(CustomerDetail, {
      props: {
        customer: {
          ...customer,
          profile: {
            ...customer.profile,
            identityKind: 'cooperative' as never,
          },
        },
      },
    }).body;
    const unknownVendorIdentity = render(VendorDetail, {
      props: {
        vendor: {
          ...vendor,
          profile: { ...vendor.profile, identityKind: 'collective' as never },
        },
      },
    }).body;
    expect(unknownCustomerIdentity).toMatch(
      /<dt[^>]*>Type<\/dt><dd[^>]*>cooperative<\/dd>/,
    );
    expect(unknownVendorIdentity).toMatch(
      /<dt[^>]*>Type<\/dt><dd[^>]*>collective<\/dd>/,
    );
  });

  it('keeps payment terms out of contact copy and avoids invented ranges without page size', () => {
    const customerWithoutEmail = {
      ...customer,
      profile: { ...customer.profile, email: undefined },
    };
    const customerHtml = render(CustomerDirectory, {
      props: {
        items: [{ data: customerWithoutEmail }],
        total: 26,
        page: 2,
      },
    }).body;
    expect(customerHtml).toMatch(/<p[^>]*>No contact details recorded<\/p>/);
    expect(customerHtml).toContain('Wholesale · Net 30');
    expect(customerHtml).toContain('Showing 1 of 26');
    expect(customerHtml).not.toContain('Showing 2–2 of 26');

    const vendorHtml = render(VendorDirectory, {
      props: {
        items: [{ data: vendor }],
        total: 26,
        page: 2,
      },
    }).body;
    expect(vendorHtml).toContain('Showing 1 of 26');
    expect(vendorHtml).not.toContain('Showing 2–2 of 26');
  });

  it('formats the safe-integer minor-unit limit exactly in both party details', () => {
    expect(customerMoney(Number.MAX_SAFE_INTEGER)).toContain(
      'CA$90,071,992,547,409.91',
    );
    expect(vendorMoney(Number.MAX_SAFE_INTEGER)).toContain(
      'CA$90,071,992,547,409.91',
    );
  });

  it.each([
    ['fractional amount', 1.5, 'CAD', 2],
    ['not-a-number amount', Number.NaN, 'CAD', 2],
    ['unsafe amount', Number.MAX_SAFE_INTEGER + 1, 'CAD', 2],
    ['invalid currency', 100, 'invalid', 2],
    ['fractional exponent', 100, 'CAD', 1.5],
    ['unsupported exponent', 100, 'CAD', 101],
    ['huge exponent', 100, 'CAD', Number.MAX_SAFE_INTEGER],
    ['infinite exponent', 100, 'CAD', Number.POSITIVE_INFINITY],
  ])('renders localized unavailable money for a %s in both party details', (_label, amountMinor, currency, minorUnitExponent) => {
    expect(customerMoney(amountMinor, currency, minorUnitExponent)).toContain(
      'Amount unavailable',
    );
    expect(vendorMoney(amountMinor, currency, minorUnitExponent)).toContain(
      'Amount unavailable',
    );
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
          shippingAddress: {
            city: 'Retained City',
            state: 'BC',
            country: 'CA',
          },
          billingAddress: {
            state: 'Île-de-France',
            country: 'FR',
          },
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
        countryOptions: [
          { value: 'CA', label: 'Canada only' },
          { value: 'FR', label: 'France only' },
        ],
      },
    }).body;
    expect(html).toContain('action="?/update"');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="Retained &amp; raw"');
    expect(html).toContain('name="credit_limit"');
    expect(html).toContain('value="1250.0oops"');
    expect(html).toContain('value="Retained City"');
    expect(html).toMatch(
      /<select[^>]+name="shippingCountry"[^>]*>[\s\S]*?<option value="CA" selected/,
    );
    expect(html).toMatch(
      /<select[^>]+name="shippingState"[^>]*>[\s\S]*?<option value="BC" selected/,
    );
    expect(html).toMatch(
      /<input[^>]+value="Île-de-France"[^>]+name="billingState"/,
    );
    expect(html).toMatch(
      /<select[^>]+name="billingCountry"[^>]*>[\s\S]*?<option value="FR" selected/,
    );
    expect(html).toContain('Canada only');
    expect(html).toContain('France only');
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
          leadTimeDays: '7oops',
          minimumOrder: '500.00',
          currency: 'ZZZ',
          contacts: [{ id: 'contact-2', name: 'Sam', phone: 'raw phone' }],
        },
        transport: {
          action: '/vendors/create',
          addContactIntent: 'add-row',
          removeContactIntent: (index: number) => `remove-row-${index}`,
        },
        currencyOptions: [{ value: 'CAD', label: 'Canadian dollar only' }],
      },
    }).body;
    expect(html).toContain('value="person" selected');
    expect(html).toContain('value="500.00"');
    expect(html).toMatch(
      /<select[^>]+name="currency"[^>]*>[\s\S]*?<option value="ZZZ" selected/,
    );
    expect(html).toContain('Canadian dollar only');
    expect(html).toMatch(/<input[^>]+value="7oops"[^>]+name="leadTimeDays"/);
    expect(html).toMatch(
      /<input[^>]+name="leadTimeDays"[^>]+inputmode="numeric"/,
    );
    expect(html).not.toContain('name="leadTimeDays" type="number"');
    expect(html).toContain('value="raw phone"');
    expect(html).toContain('name="intent" value="add-row"');
    expect(html).toContain('name="intent" value="remove-row-0"');
  });

  it('forwards caller-restricted region choices without changing native address names', () => {
    const html = render(CustomerForm, {
      props: {
        values: {
          shippingAddress: { country: 'CA', state: 'BC' },
        },
        provinceOptions: [
          { value: 'BC', label: 'British Columbia authorized' },
        ],
      },
    }).body;
    expect(html).toMatch(
      /<select[^>]+name="shippingState"[^>]*>[\s\S]*?<option value="BC" selected/,
    );
    expect(html).toContain('British Columbia authorized');
  });

  it('keeps read-only selector values successful for caller-owned submissions', () => {
    const html = render(VendorForm, {
      props: {
        readOnly: true,
        values: { identityKind: 'business', name: 'Vendor', currency: 'CAD' },
      },
    }).body;
    expect(html).toMatch(
      /<select(?=[^>]*name="currency")(?=[^>]*disabled)[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*type="hidden")(?=[^>]*name="currency")(?=[^>]*value="CAD")[^>]*>/,
    );
  });

  it('places the save intent before contact actions for native Enter submission', () => {
    const html = render(CustomerForm, {
      props: {
        values: {
          identityKind: 'business',
          name: 'Keyboard customer',
          contacts: [{ id: 'contact-1', name: 'Retained contact' }],
        },
        transport: { saveIntent: 'save-customer' },
      },
    }).body;
    expect(html.indexOf('value="save-customer"')).toBeLessThan(
      html.indexOf('value="addContact"'),
    );
    expect(html.indexOf('value="save-customer"')).toBeLessThan(
      html.indexOf('value="removeContact:0"'),
    );

    const customHtml = render(CustomActionsFormHarness).body;
    expect(customHtml.indexOf('value="custom-save"')).toBeLessThan(
      customHtml.indexOf('value="removeContact:0"'),
    );
  });

  it('resolves formerly hard-coded party copy from a non-English catalog', () => {
    const html = render(PartyI18nHarness).body;
    expect(html).toContain('Kunden suchen und verwalten.');
    expect(html).toContain('Kunde hinzufügen');
    expect(html).toContain('Kunden suchen');
    expect(html).toContain('Keine Kontaktdaten erfasst');
    expect(html).toContain('1 von 1 angezeigt');
    expect(html).toContain('Identität');
    expect(html).toContain('Art');
    expect(html).toContain('Zustand');
    expect(html).toContain('7 Tage Lieferzeit');
    expect(html).toContain('Betrag nicht verfügbar');
    expect(html).toContain('Notizen');
    expect(html).toContain('Name für Kunde');
  });
});
