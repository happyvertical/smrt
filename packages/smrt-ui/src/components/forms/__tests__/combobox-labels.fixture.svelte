<script lang="ts">
import Combobox from '../Combobox.svelte';
import type { ControlOption } from '../control-interaction.js';

let {
  options = [],
  value = $bindable(''),
  valueLabel = undefined,
}: {
  options?: ControlOption[];
  value?: string;
  valueLabel?: string;
} = $props();
</script>

<Combobox label="Town" name="town" {options} {valueLabel} bind:value />
<p data-testid="value">{value}</p>
