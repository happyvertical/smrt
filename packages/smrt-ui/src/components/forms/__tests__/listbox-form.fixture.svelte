<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import Listbox from '../Listbox.svelte';

interface Props {
  name?: string;
  unnamed?: boolean;
  value?: string | number;
  disabled?: boolean;
  fieldsetDisabled?: boolean;
  registry?: ControlInteractionRegistry;
}
let {
  name = 'vendor',
  unnamed = false,
  value = $bindable(),
  disabled = false,
  fieldsetDisabled = false,
  registry,
}: Props = $props();
</script>
<Form formId="vendor-form" interactionRegistry={registry} aria-label="Vendor form">
  <fieldset disabled={fieldsetDisabled}>
    <Listbox name={unnamed ? undefined : name} label="Vendor" options={[{ value: 42, label: 'Plate supplier' }, { value: 'steel', label: 'Steel supplier' }, { value: 'blocked', label: 'Disabled supplier', disabled: true }]} bind:value {disabled} interaction={{ id: 'vendor' }} />
  </fieldset>
</Form>
