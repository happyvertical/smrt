<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import FormGroup from '../FormGroup.svelte';
import Input from '../Input.svelte';

let { registry }: { registry: ControlInteractionRegistry } = $props();
let displayName = $state('Ada');
let apiToken = $state('token');
</script>

<Form formId="profile" interactionRegistry={registry} aria-label="Profile form">
  <FormGroup label="Display name">
    <Input name="display-name" bind:value={displayName} required minlength={3} />
  </FormGroup>
  <FormGroup label="API token" interaction={{ sensitivity: 'secret' }}>
    <Input name="api-token" type="password" bind:value={apiToken} />
  </FormGroup>
  <button type="reset">Reset</button>
</Form>
