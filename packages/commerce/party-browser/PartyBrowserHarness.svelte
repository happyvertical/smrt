<script lang="ts">
import CustomerDetail from '../src/svelte/components/CustomerDetail.svelte';
import CustomerDirectory from '../src/svelte/components/CustomerDirectory.svelte';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';
import VendorDetail from '../src/svelte/components/VendorDetail.svelte';
import VendorDirectory from '../src/svelte/components/VendorDirectory.svelte';
import VendorForm from '../src/svelte/components/VendorForm.svelte';
import PartyFormPreview from '../src/svelte/playground/PartyFormPreview.svelte';
import CustomActionsFormHarness from './CustomActionsFormHarness.svelte';

const customer = {
  id: 'customer-1',
  profile: { name: 'Riverstone Newsroom', email: 'accounts@riverstone.example', identityKind: 'business' as const },
  status: 'active',
  customerType: 'wholesale',
  creditLimitMinor: 125000,
  paymentTerms: 'Net 30',
  contacts: [{ id: 'contact-1', name: 'Avery Chen', email: 'avery@example.test' }],
};
const vendor = {
  id: 'vendor-1',
  profile: { name: 'Northstar Supply', identityKind: 'business' as const },
  status: 'active',
  leadTimeDays: 7,
  minimumOrderMinor: 50000,
  currency: 'CAD',
  contacts: [{ id: 'contact-2', name: 'Morgan Lee', phone: '+1 403 555 0117' }],
};
const extremeCustomer = {
  ...customer,
  id: 'customer-extreme',
  creditLimitMinor: Number.MAX_SAFE_INTEGER,
};
const negativeVendor = {
  ...vendor,
  id: 'vendor-negative',
  minimumOrderMinor: -1,
};
const invalidCurrencyCustomer = {
  ...customer,
  id: 'customer-invalid-currency',
  creditLimitMinor: 100,
};
const invalidExponentVendor = {
  ...vendor,
  id: 'vendor-invalid-exponent',
  minimumOrderMinor: 100,
};
</script>

<main>
  <section data-testid="customer-directory">
    <CustomerDirectory items={[{ data: customer, href: '#customer-detail' }]} total={26} pageSize={25} nextHref="#next" addHref="#new" canCreate labels={{ singular: 'Client', plural: 'Clients' }} />
  </section>
  <section data-testid="vendor-empty"><VendorDirectory items={[]} /></section>
  <section data-testid="vendor-error"><VendorDirectory errorMessage="Vendor service unavailable" /></section>
  <section id="customer-detail" data-testid="customer-detail"><CustomerDetail {customer} editHref="#forbidden" canEdit={false} /></section>
  <section data-testid="vendor-detail"><VendorDetail {vendor} editHref="#edit-vendor" canEdit /></section>
  <section data-testid="customer-money-extreme"><CustomerDetail customer={extremeCustomer} currency="CAD" locale="en" /></section>
  <section data-testid="vendor-money-negative"><VendorDetail vendor={negativeVendor} locale="en" /></section>
  <section data-testid="customer-money-invalid-currency"><CustomerDetail customer={invalidCurrencyCustomer} currency="invalid" /></section>
  <section data-testid="vendor-money-invalid-exponent"><VendorDetail vendor={invalidExponentVendor} minorUnitExponent={Number.POSITIVE_INFINITY} /></section>
  <section data-testid="customer-form">
    <CustomerForm
      values={{ identityKind: 'business', name: 'Retained Client', creditLimit: '1250.0oops', contacts: [{ id: 'contact-1', name: 'Avery' }] }}
      errors={{ form: 'Correct the highlighted values', fields: { creditLimit: 'Enter a currency amount' } }}
      transport={{ action: '/party-submit', hiddenFields: { requestToken: 'request-123', expectedTenantId: 'tenant-9' } }}
      fieldNames={{ name: 'clientName', creditLimit: 'credit_limit' }}
    />
  </section>
  <section data-testid="vendor-readonly">
    <VendorForm readOnly values={{ identityKind: 'business', name: 'Read only vendor', minimumOrder: '500.00', contacts: vendor.contacts }} />
  </section>
  <section data-testid="vendor-invalid">
    <VendorForm
      values={{ identityKind: 'business', name: 'Retained Vendor', leadTimeDays: '7oops', minimumOrder: '500.00', contacts: vendor.contacts }}
      transport={{ action: '/party-submit', hiddenFields: { requestToken: 'vendor-request' } }}
    />
  </section>
  <section data-testid="customer-playground">
    <PartyFormPreview kind="customer" />
  </section>
  <section data-testid="custom-actions-form">
    <CustomActionsFormHarness />
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; padding: 1rem; color: var(--smrt-color-on-surface, #1f2937); background: var(--smrt-color-surface, #fff); font-family: system-ui, sans-serif; }
  main { display: grid; gap: 3rem; max-inline-size: 70rem; margin-inline: auto; min-inline-size: 0; }
  section { min-inline-size: 0; }
</style>
