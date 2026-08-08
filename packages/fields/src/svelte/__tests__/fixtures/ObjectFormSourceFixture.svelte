<script lang="ts">
import ObjectForm from '../../components/ObjectForm.svelte';
import ObjectFormSourceProvider from '../../components/ObjectFormSourceProvider.svelte';
import type { ObjectFormSource } from '../../types.js';

interface Props {
  source: ObjectFormSource;
  objectRef: string;
  isNewRecord?: boolean;
  initialValue?: Record<string, unknown>;
}

let {
  source,
  objectRef,
  isNewRecord = true,
  initialValue = {},
}: Props = $props();
function initialRecord(): Record<string, unknown> {
  return initialValue;
}

let record = $state<Record<string, unknown>>(initialRecord());
</script>

<ObjectFormSourceProvider {source}>
  <ObjectForm {objectRef} {isNewRecord} bind:value={record} />
</ObjectFormSourceProvider>
<output data-testid="record">{JSON.stringify(record)}</output>
