<!--
  STAND-IN for `CustomerSelect` of `@happyvertical/smrt-commerce/svelte`
  (happyvertical/smrt#3602). Presentation-only: data comes from the caller's
  `search(query)` and `resolve(id)`, which return the commerce party DTO
  (`CustomerDisplayData`, whose `profile.name` is the label). Shows the
  profile name plus status and type, with an optional "New customer" action.
  Registered in `selects.ts` as the selector for
  `@happyvertical/smrt-commerce:Customer`. When #3602 ships, import the
  published component and delete this file.
-->
<script lang="ts">
import { RelationInput } from '@happyvertical/smrt-svelte/forms';
import { customerOption } from './partySelect.ts';
import type { CustomerDisplayData } from './partyTypes.ts';

interface CustomerSelectProps {
  value?: string;
  name: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  search: (query: string) => Promise<CustomerDisplayData[]>;
  resolve: (id: string) => Promise<CustomerDisplayData | null>;
  onCreate?: () => void;
  createLabel?: string;
  onchange?: (id: string) => void;
}

let {
  value = $bindable(''),
  name,
  label = 'Customer',
  required = false,
  disabled = false,
  error,
  search,
  resolve,
  onCreate,
  createLabel = 'New customer',
  onchange,
}: CustomerSelectProps = $props();
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
  search={async (query) => (await search(query)).map(customerOption)}
  resolve={async (id) => {
    const found = await resolve(id);
    return found ? { id: found.id, label: found.profile.name } : null;
  }}
/>
