<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import FormGroup from '../FormGroup.svelte';
import Input from '../Input.svelte';

let {
  registry,
}: {
  registry: ControlInteractionRegistry;
} = $props();
let displayName = $state('Ada');
</script>

<Form formId="profile" interactionRegistry={registry} aria-label="Profile form">
  <fieldset>
    <FormGroup label="Display name">
      <Input name="display-name" bind:value={displayName} required minlength={3} />
    </FormGroup>
  </fieldset>
</Form>
