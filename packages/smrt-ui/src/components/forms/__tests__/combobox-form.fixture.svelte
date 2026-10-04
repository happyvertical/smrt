<script lang="ts">
import Combobox from '../Combobox.svelte';
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';

interface Props {
  name?: string;
  unnamed?: boolean;
  value?: string;
  disabled?: boolean;
  fieldsetDisabled?: boolean;
  allowCustom?: boolean;
  registry?: ControlInteractionRegistry;
}
let {
  name = 'sku',
  unnamed = false,
  value = $bindable(''),
  disabled = false,
  fieldsetDisabled = false,
  allowCustom = false,
  registry,
}: Props = $props();
</script>
<Form formId="order" interactionRegistry={registry} aria-label="Order">
  <fieldset disabled={fieldsetDisabled}>
    <Combobox name={unnamed ? undefined : name} label="SKU" options={[{value: '42', label: 'Plate 1/4 A36'}, {value: '43', label: 'Disabled plate', disabled: true}]} bind:value {disabled} {allowCustom} interaction={{id: 'sku'}} />
  </fieldset>
</Form>
