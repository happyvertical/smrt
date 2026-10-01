<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import FormGroup from '../FormGroup.svelte';
import Input from '../Input.svelte';
import PlacePicker from './place-picker.fixture.svelte';

interface Props {
  registry: ControlInteractionRegistry;
}
let { registry }: Props = $props();
let name = $state('');
let place = $state<{
  name: string;
  latitude: number;
  longitude: number;
} | null>(null);
</script>

<Form formId="new-site" interactionRegistry={registry} aria-label="New site">
  <FormGroup label="Site name" id="site-name">
    <Input name="name" bind:value={name} />
  </FormGroup>
  <PlacePicker bind:value={place} />
  <FormGroup label="Password" id="site-password">
    <Input name="password" type="password" value="" />
  </FormGroup>
</Form>
<p data-testid="place">{place ? place.name : 'none'}</p>
