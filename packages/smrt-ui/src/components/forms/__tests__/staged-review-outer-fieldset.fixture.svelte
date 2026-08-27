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

<fieldset>
  <fieldset>
    <Form formId="profile" interactionRegistry={registry} aria-label="Profile form">
      <FormGroup label="Display name">
        <Input name="display-name" bind:value={displayName} required minlength={3} />
      </FormGroup>
    </Form>
  </fieldset>
</fieldset>
