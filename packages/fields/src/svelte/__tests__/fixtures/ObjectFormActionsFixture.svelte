<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import ObjectForm from '../../components/ObjectForm.svelte';
import type { ObjectFormFieldDefinition } from '../../types.js';

interface Props {
  fields: Record<string, ObjectFormFieldDefinition>;
  policy: ResolvedObjectFieldPolicy;
  onsubmit: (event: SubmitEvent) => void;
}

let { fields, policy, onsubmit }: Props = $props();
let record = $state<Record<string, unknown>>({});
</script>

<ObjectForm objectRef={policy.objectRef} {fields} {policy} bind:value={record} {onsubmit}>
  {#snippet actions()}
    <button type="submit">Save product</button>
  {/snippet}
</ObjectForm>
