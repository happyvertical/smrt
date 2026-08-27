<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import RangeSlider from '../RangeSlider.svelte';
import Slider from '../Slider.svelte';

interface Props {
  registry: ControlInteractionRegistry;
}

let { registry }: Props = $props();
let value = $state(0.1);
let range = $state({ min: 0.1, max: 0.5 });
let tinyValue = $state(1e-16);
let microscopicValue = $state(1e-101);
let microscopicRange = $state({ min: 1e-101, max: 1.9e-101 });
</script>

<Form formId="decimal" interactionRegistry={registry} aria-label="Decimal controls">
  <Slider name="value" label="Value" min={0.1} max={1} step={0.2} bind:value />
  <RangeSlider name="range" label="Range" min={0.1} max={1} step={0.2} bind:value={range} />
  <Slider name="tiny" label="Tiny value" min={1e-16} max={9e-16} step={2e-16} bind:value={tinyValue} />
  <Slider name="microscopic" label="Microscopic value" min={1e-101} max={1.9e-101} step={3e-103} bind:value={microscopicValue} />
  <RangeSlider name="microscopic-range" label="Microscopic range" minLabel="Microscopic minimum" maxLabel="Microscopic maximum" min={1e-101} max={1.9e-101} step={3e-103} bind:value={microscopicRange} />
</Form>
