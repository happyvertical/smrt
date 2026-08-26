<script lang="ts">
import type {
  ControlInteractionRegistry,
  ControlSubject,
} from '../control-interaction.js';
import Form from '../Form.svelte';
import FormGroup from '../FormGroup.svelte';
import Input from '../Input.svelte';

let {
  registry,
  subject,
}: { registry: ControlInteractionRegistry; subject?: ControlSubject } =
  $props();
let displayName = $state('Ada');
let apiToken = $state('token');
</script>

<Form formId="profile" interactionRegistry={registry} aria-label="Profile form">
  <FormGroup label="Display name">
    <Input name="display-name" interaction={subject ? { subject } : undefined} bind:value={displayName} required minlength={3} />
  </FormGroup>
  <FormGroup label="API token" interaction={{ sensitivity: 'secret' }}>
    <Input name="api-token" type="password" bind:value={apiToken} />
  </FormGroup>
  <button type="reset">Reset</button>
</Form>
