<script lang="ts">
import Combobox from '../Combobox.svelte';
import type { ControlOption } from '../control-interaction.js';

let {
  options = [],
  value = $bindable(''),
  valueLabel = undefined,
  required = false,
}: {
  options?: ControlOption[];
  value?: string;
  valueLabel?: string;
  required?: boolean;
} = $props();
</script>

<Combobox label="Town" name="town" {options} {valueLabel} {required} bind:value />
<p data-testid="value">{value}</p>
