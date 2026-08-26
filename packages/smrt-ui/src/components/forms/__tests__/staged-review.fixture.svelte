<script lang="ts">
import type {
  ControlInteractionRegistry,
  ControlSubject,
} from '../control-interaction.js';
import Form from '../Form.svelte';
import FormGroup from '../FormGroup.svelte';
import Input from '../Input.svelte';
import Slider from '../Slider.svelte';

let {
  registry,
  subject,
}: { registry: ControlInteractionRegistry; subject?: ControlSubject } =
  $props();
let displayName = $state('Ada');
let apiToken = $state('token');
let volume = $state(25);
let score = $state<string | number>(1);
</script>

<Form formId="profile" interactionRegistry={registry} aria-label="Profile form">
  <FormGroup label="Display name">
    <Input name="display-name" interaction={subject ? { subject } : undefined} bind:value={displayName} required minlength={3} />
  </FormGroup>
  <FormGroup label="API token" interaction={{ sensitivity: 'secret' }}>
    <Input name="api-token" type="password" bind:value={apiToken} />
  </FormGroup>
  <Slider name="volume" label="Volume" bind:value={volume} />
  <Input name="score" aria-label="Score" type="number" bind:value={score} />
  <button type="reset">Reset</button>
</Form>
