<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import MultiSelect from '../MultiSelect.svelte';

interface Props {
  name?: string;
  unnamed?: boolean;
  values?: Array<string | number>;
  disabled?: boolean;
  fieldsetDisabled?: boolean;
  registry?: ControlInteractionRegistry;
}
let {
  name = 'roles',
  unnamed = false,
  values = $bindable([]),
  disabled = false,
  fieldsetDisabled = false,
  registry,
}: Props = $props();
</script>
<Form formId="roles-form" interactionRegistry={registry} aria-label="Roles form">
  <fieldset disabled={fieldsetDisabled}>
    <MultiSelect name={unnamed ? undefined : name} label="Roles" options={[{ value: 42, label: 'Operator' }, { value: 'admin', label: 'Administrator' }, { value: 'blocked', label: 'Disabled role', disabled: true }]} bind:values {disabled} interaction={{ id: 'roles' }} />
  </fieldset>
</Form>
