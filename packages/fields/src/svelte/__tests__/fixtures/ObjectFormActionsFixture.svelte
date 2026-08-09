<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import ObjectForm, {
  type ObjectFormProps,
} from '../../components/ObjectForm.svelte';
import type { ObjectFormFieldDefinition } from '../../types.js';
import type { FieldUsageReporter } from '../../usage-capture.js';

interface Props {
  fields: Record<string, ObjectFormFieldDefinition>;
  policy: ResolvedObjectFieldPolicy;
  onsubmit: NonNullable<ObjectFormProps['onsubmit']>;
  usageReporter?: FieldUsageReporter;
}

let { fields, policy, onsubmit, usageReporter }: Props = $props();
let record = $state<Record<string, unknown>>({});
</script>

<ObjectForm objectRef={policy.objectRef} {fields} {policy} bind:value={record} {onsubmit} {usageReporter}>
  {#snippet actions()}
    <button type="submit">Save product</button>
  {/snippet}
</ObjectForm>
