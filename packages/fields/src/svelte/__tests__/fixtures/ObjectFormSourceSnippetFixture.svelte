<script lang="ts">
import { Input } from '@happyvertical/smrt-ui/forms';
import ObjectForm from '../../components/ObjectForm.svelte';
import ObjectFormSourceProvider from '../../components/ObjectFormSourceProvider.svelte';
import type {
  ObjectFormFieldSnippetProps,
  ObjectFormSource,
} from '../../types.js';

interface Props {
  source: ObjectFormSource;
  objectRef: string;
}

let { source, objectRef }: Props = $props();
let record = $state<Record<string, unknown>>({});
</script>

{#snippet customName(props: ObjectFormFieldSnippetProps)}
  <Input
    id="custom-name"
    name="name"
    value={String(props.value ?? '')}
    aria-label="Custom generated name"
    disabled={props.disabled}
    oninput={(event) => props.setValue((event.currentTarget as HTMLInputElement).value.toUpperCase())}
  />
{/snippet}

<ObjectFormSourceProvider {source}>
  <ObjectForm {objectRef} bind:value={record} renderers={{ name: customName }} />
</ObjectFormSourceProvider>
<output data-testid="record">{JSON.stringify(record)}</output>
