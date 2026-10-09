<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import CustomerSelect from '../components/CustomerSelect.svelte';
import VendorSelect from '../components/VendorSelect.svelte';
import { M } from '../i18n.js';
import type { CustomerDisplayData, VendorDisplayData } from '../party-types.js';

interface Props {
  /** Selects the in-memory customer or vendor selector demonstration. */
  kind: 'customer' | 'vendor';
}

let { kind }: Props = $props();
const { t } = useI18n();

const customers: CustomerDisplayData[] = [
  {
    id: 'customer-riverstone',
    profile: { name: 'Riverstone Newsroom' },
    status: 'active',
    customerType: 'wholesale',
  },
  {
    id: 'customer-harbour',
    profile: { name: 'Harbour Books' },
    status: 'active',
    customerType: 'retail',
  },
  {
    id: 'customer-maple',
    profile: { name: 'Maple Direct' },
    status: 'suspended',
    customerType: 'dtc',
  },
];
const vendors: VendorDisplayData[] = [
  {
    id: 'vendor-northstar',
    profile: { name: 'Northstar Supply' },
    status: 'active',
  },
  {
    id: 'vendor-cedar',
    profile: { name: 'Cedar Paper Co.' },
    status: 'active',
  },
  {
    id: 'vendor-delta',
    profile: { name: 'Delta Freight' },
    status: 'inactive',
  },
];

let customerId = $state('customer-riverstone');
let vendorId = $state('');
let added = 0;

const match = <T extends { profile: { name: string } }>(
  rows: T[],
  query: string,
) =>
  rows.filter((row) =>
    row.profile.name.toLowerCase().includes(query.toLowerCase()),
  );
</script>

<div class="preview">
  {#if kind === 'customer'}
    <CustomerSelect
      name="customerId"
      bind:value={customerId}
      search={async (query) => match(customers, query)}
      resolve={async (id) => customers.find((row) => row.id === id) ?? null}
      onCreate={async (query) => {
        added += 1;
        const made: CustomerDisplayData = {
          id: `customer-new-${added}`,
          profile: { name: query || `${t(M['commerce.customer.singular'])} ${added}` },
          status: 'active',
          customerType: 'dtc',
        };
        customers.push(made);
        return made;
      }}
    />
    <p>Posts <code>customerId={customerId || '(empty)'}</code></p>
  {:else}
    <VendorSelect
      name="vendorId"
      bind:value={vendorId}
      search={async (query) => match(vendors, query)}
      resolve={async (id) => vendors.find((row) => row.id === id) ?? null}
    />
    <p>Posts <code>vendorId={vendorId || '(empty)'}</code></p>
  {/if}
</div>

<style>
  .preview {
    display: grid;
    gap: var(--smrt-spacing-2, 8px);
    max-width: 28rem;
    color: var(--smrt-color-on-surface);
  }
  p {
    margin: 0;
  }
</style>
