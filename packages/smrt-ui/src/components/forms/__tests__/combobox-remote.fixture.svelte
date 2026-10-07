<script lang="ts">
import Combobox from '../Combobox.svelte';
import type { ControlOption } from '../control-interaction.js';

let {
  options = [],
  status = undefined,
  onquery = undefined,
}: {
  options?: ControlOption[];
  status?: string;
  onquery?: (query: string) => void;
} = $props();
let value = $state('');
</script>

<Combobox label="Customer" {options} {status} {onquery} filter={false} bind:value>
  {#snippet optionContent(option)}<b>{option.label}</b> detail-{option.value}{/snippet}
</Combobox>
