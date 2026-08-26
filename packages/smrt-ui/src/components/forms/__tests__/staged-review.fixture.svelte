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
  displayNameLabel = 'Display name',
  formOnInput,
  formId = 'profile',
}: {
  registry: ControlInteractionRegistry;
  subject?: ControlSubject;
  displayNameLabel?: string;
  formOnInput?: (event: Event) => void;
  formId?: string;
} = $props();
let displayName = $state('Ada');
let apiToken = $state('token');
let volume = $state(25);
let score = $state<string | number>(1);
let mutableSubject = $state<ControlSubject | undefined>();
$effect(() => {
  mutableSubject = subject ? { ...subject } : undefined;
});
function mutateSubject() {
  if (mutableSubject) mutableSubject.id = 'two';
}
</script>

<Form {formId} interactionRegistry={registry} aria-label="Profile form" oninput={formOnInput}>
  <FormGroup label={displayNameLabel}>
    <Input name="display-name" interaction={mutableSubject ? { subject: mutableSubject } : undefined} bind:value={displayName} required minlength={3} />
  </FormGroup>
  <FormGroup label="API token" interaction={{ sensitivity: 'secret' }}>
    <Input name="api-token" type="password" bind:value={apiToken} />
  </FormGroup>
  <Slider name="volume" label="Volume" bind:value={volume} />
  <Input name="score" aria-label="Score" type="number" bind:value={score} />
  <button type="reset">Reset</button>
  {#if mutableSubject}
    <button type="button" onclick={mutateSubject}>Mutate subject</button>
  {/if}
</Form>
