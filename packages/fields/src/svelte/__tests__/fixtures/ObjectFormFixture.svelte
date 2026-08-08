<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import ObjectForm from '../../components/ObjectForm.svelte';
import type { ObjectFormFieldDefinition } from '../../types.js';

interface Props {
  fields: Record<string, ObjectFormFieldDefinition>;
  policy: ResolvedObjectFieldPolicy;
}

let { fields, policy }: Props = $props();
let record = $state<Record<string, unknown>>({});
</script>

<ObjectForm objectRef={policy.objectRef} {fields} {policy} bind:value={record} />
<button type="button" onclick={() => (record = {})}>Start another record</button>
<output data-testid="record">{JSON.stringify(record)}</output>
