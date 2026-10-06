<script lang="ts">
/** RelationInput inside the rich Form, to prove registry + native posting. */
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import Form from '../Form.svelte';
import RelationInput from '../RelationInput.svelte';
import type { RelationOption } from '../types.js';

let {
  search,
  interactionRegistry = undefined,
  value = $bindable('c2'),
  resolve = undefined,
}: {
  search: (query: string) => Promise<RelationOption[]>;
  interactionRegistry?: ControlInteractionRegistry;
  value?: string;
  resolve?: (id: string) => Promise<{ id: string; label: string } | null>;
} = $props();
</script>

<Form formId="order" aria-label="Order" {interactionRegistry}>
  <RelationInput
    name="customerId"
    label="Customer"
    {search}
    {resolve}
    bind:value
    debounceMs={5}
  />
  <button type="submit">Save</button>
</Form>
