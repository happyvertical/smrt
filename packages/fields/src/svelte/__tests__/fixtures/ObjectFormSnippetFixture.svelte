<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import ObjectForm from '../../components/ObjectForm.svelte';
import type {
  ObjectFormFieldDefinition,
  ObjectFormFieldSnippetProps,
} from '../../types.js';

interface Props {
  fields: Record<string, ObjectFormFieldDefinition>;
  policy: ResolvedObjectFieldPolicy;
}

let { fields, policy }: Props = $props();
let record = $state<Record<string, unknown>>({});
</script>

{#snippet customName(props: ObjectFormFieldSnippetProps)}
  <input
    aria-label="Custom product name"
    value={String(props.value ?? '')}
    disabled={props.disabled}
    oninput={(event) => props.setValue((event.currentTarget as HTMLInputElement).value)}
  />
{/snippet}

<ObjectForm
  objectRef={policy.objectRef}
  {fields}
  {policy}
  bind:value={record}
  renderers={{ name: customName }}
/>
<output data-testid="record">{JSON.stringify(record)}</output>
