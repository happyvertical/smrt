<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import CustomerForm from '../components/CustomerForm.svelte';
import VendorForm from '../components/VendorForm.svelte';
import { M } from '../i18n.js';
import type {
  CustomerFormValues,
  PartyAddressData,
  PartyContactData,
  PartyFormErrors,
  VendorFormValues,
} from '../party-types.js';

interface Props {
  /** Selects the in-memory customer or vendor form demonstration. */
  kind: 'customer' | 'vendor';
}

let { kind }: Props = $props();
const { t } = useI18n();
let errors = $state<PartyFormErrors>({});
let customerValues = $state<CustomerFormValues>({
  profileId: 'profile-riverstone',
  identityKind: 'business',
  name: 'Riverstone Newsroom',
  email: 'accounts@riverstone.example',
  status: 'active',
  customerType: 'wholesale',
  creditLimit: '2500.00',
  paymentTerms: 'Net 30',
  shippingAddress: {
    street1: '100 Main Street',
    city: 'Vancouver',
    state: 'BC',
    postalCode: 'V6B 1A1',
    country: 'CA',
  },
  contacts: [
    {
      id: 'contact-avery',
      name: 'Avery Chen',
      label: 'Accounts payable',
      email: 'avery@riverstone.example',
    },
  ],
});
let vendorValues = $state<VendorFormValues>({
  profileId: 'profile-northstar',
  identityKind: 'business',
  name: 'Northstar Supply',
  email: 'orders@northstar.example',
  status: 'active',
  leadTimeDays: '7',
  minimumOrder: '500.00',
  currency: 'CAD',
  paymentTerms: 'Net 45',
  contacts: [
    {
      id: 'contact-morgan',
      name: 'Morgan Lee',
      label: 'Order desk',
      email: 'morgan@northstar.example',
    },
  ],
});

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '');
}

function contacts(data: FormData): PartyContactData[] {
  const ids = data.getAll('contactId');
  const names = data.getAll('contactName');
  const labels = data.getAll('contactLabel');
  const emails = data.getAll('contactEmail');
  const phones = data.getAll('contactPhone');
  const addresses = data.getAll('contactAddress');
  return names.map((name, index) => ({
    id: String(ids[index] ?? ''),
    name: String(name),
    label: String(labels[index] ?? ''),
    email: String(emails[index] ?? ''),
    phone: String(phones[index] ?? ''),
    address: String(addresses[index] ?? ''),
  }));
}

function address(
  data: FormData,
  prefix: 'shipping' | 'billing',
): PartyAddressData {
  return {
    street1: field(data, `${prefix}Street1`),
    street2: field(data, `${prefix}Street2`),
    city: field(data, `${prefix}City`),
    state: field(data, `${prefix}State`),
    postalCode: field(data, `${prefix}PostalCode`),
    country: field(data, `${prefix}Country`),
  };
}

function retainedCustomer(data: FormData): CustomerFormValues {
  return {
    ...customerValues,
    identityKind: field(
      data,
      'identityKind',
    ) as CustomerFormValues['identityKind'],
    name: field(data, 'name'),
    email: field(data, 'email'),
    description: field(data, 'description'),
    status: field(data, 'status'),
    customerType: field(data, 'customerType'),
    creditLimit: field(data, 'creditLimit'),
    paymentTerms: field(data, 'paymentTerms'),
    taxExempt: data.has('taxExempt'),
    notes: field(data, 'notes'),
    shippingAddress: address(data, 'shipping'),
    billingAddress: address(data, 'billing'),
    contacts: contacts(data),
  };
}

function retainedVendor(data: FormData): VendorFormValues {
  return {
    ...vendorValues,
    identityKind: field(
      data,
      'identityKind',
    ) as VendorFormValues['identityKind'],
    name: field(data, 'name'),
    email: field(data, 'email'),
    description: field(data, 'description'),
    status: field(data, 'status'),
    leadTimeDays: field(data, 'leadTimeDays'),
    minimumOrder: field(data, 'minimumOrder'),
    currency: field(data, 'currency'),
    paymentTerms: field(data, 'paymentTerms'),
    defaultContactEmail: field(data, 'defaultContactEmail'),
    defaultContactPhone: field(data, 'defaultContactPhone'),
    notes: field(data, 'notes'),
    contacts: contacts(data),
  };
}

function applyIntent(intent: string): void {
  const current =
    kind === 'customer'
      ? (customerValues.contacts ?? [])
      : (vendorValues.contacts ?? []);
  if (intent === 'addContact') {
    const next = [...current, { id: `demo-contact-${current.length + 1}` }];
    if (kind === 'customer')
      customerValues = { ...customerValues, contacts: next };
    else vendorValues = { ...vendorValues, contacts: next };
    errors = { form: t(M['commerce.party.demo_contact_added']) };
    return;
  }
  if (intent.startsWith('removeContact:')) {
    const index = Number(intent.slice('removeContact:'.length));
    const next = current.filter((_, contactIndex) => contactIndex !== index);
    if (kind === 'customer')
      customerValues = { ...customerValues, contacts: next };
    else vendorValues = { ...vendorValues, contacts: next };
    errors = { form: t(M['commerce.party.demo_contact_removed']) };
    return;
  }
  errors = {
    form: t(M['commerce.party.demo_rejected']),
    fields: {
      [kind === 'customer' ? 'creditLimit' : 'minimumOrder']: t(
        M['commerce.party.demo_invalid_amount'],
      ),
    },
  };
}

function handleSubmit(event: SubmitEvent): void {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  if (kind === 'customer') customerValues = retainedCustomer(data);
  else vendorValues = retainedVendor(data);
  const submitter = event.submitter as HTMLButtonElement | null;
  applyIntent(submitter?.value ?? 'save');
}
</script>

<div class="party-form-preview" onsubmit={handleSubmit}>
  {#if kind === 'customer'}
    <CustomerForm
      mode="edit"
      values={customerValues}
      {errors}
      transport={{
        action: '?/customer-demo',
        hiddenFields: { requestId: 'demo-request' },
      }}
    />
  {:else}
    <VendorForm
      mode="edit"
      values={vendorValues}
      {errors}
      transport={{
        action: '?/vendor-demo',
        hiddenFields: { expectedTenantId: 'tenant-demo' },
      }}
    />
  {/if}
</div>
