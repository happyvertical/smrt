<!--
  STAND-IN for `VendorSelect` of `@happyvertical/smrt-commerce/svelte`
  (happyvertical/smrt#3602). Presentation-only: data comes from the caller's
  `search(query)` and `resolve(id)`, which return the commerce party DTO
  (`VendorDisplayData`, whose `profile.name` is the label). Shows the
  profile name plus status, with an optional "New vendor" action.
  Registered in `selects.ts` as the selector for
  `@happyvertical/smrt-commerce:Vendor`. When #3602 ships, import the
  published component and delete this file.
-->
<script lang="ts">
import { vendorOption } from './partySelect.ts';
import type { VendorDisplayData } from './partyTypes.ts';
import RelationInput from './RelationInput.svelte';

interface VendorSelectProps {
  value?: string;
  name: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  search: (query: string) => Promise<VendorDisplayData[]>;
  resolve: (id: string) => Promise<VendorDisplayData | null>;
  onCreate?: () => void;
  createLabel?: string;
  onchange?: (id: string) => void;
}

let {
  value = $bindable(''),
  name,
  label = 'Vendor',
  required = false,
  disabled = false,
  error,
  search,
  resolve,
  onCreate,
  createLabel = 'New vendor',
  onchange,
}: VendorSelectProps = $props();
</script>

<RelationInput
  bind:value
  {name}
  {label}
  {required}
  {disabled}
  {error}
  {onCreate}
  {createLabel}
  {onchange}
  search={async (query) => (await search(query)).map(vendorOption)}
  resolve={async (id) => {
    const found = await resolve(id);
    return found ? { id: found.id, label: found.profile.name } : null;
  }}
/>
