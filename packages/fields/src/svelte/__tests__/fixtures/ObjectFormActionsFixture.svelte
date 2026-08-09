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
  resetAfterSuccessfulSubmit?: boolean;
}

let {
  fields,
  policy,
  onsubmit,
  usageReporter,
  resetAfterSuccessfulSubmit = false,
}: Props = $props();
let record = $state<Record<string, unknown>>({});

async function submit(event: SubmitEvent): Promise<boolean | undefined> {
  const result = await onsubmit(event);
  if (result === true && resetAfterSuccessfulSubmit) record = {};
  return result === true ? true : undefined;
}
</script>

<ObjectForm objectRef={policy.objectRef} {fields} {policy} bind:value={record} onsubmit={submit} {usageReporter}>
  {#snippet actions()}
    <button type="submit">Save product</button>
  {/snippet}
</ObjectForm>
