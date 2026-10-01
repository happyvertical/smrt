<script lang="ts">
import {
  type ControlInteractionRegistry,
  FormGroup,
  Input,
} from '@happyvertical/smrt-ui/forms';
import FormScope from '../FormScope.svelte';

let {
  interactionRegistry = undefined,
  showTown = true,
}: {
  interactionRegistry?: ControlInteractionRegistry;
  showTown?: boolean;
} = $props();
let name = $state('');
let town = $state('');
let secret = $state('');
</script>

<FormScope formId="new-site" purpose="Start a new town site" {interactionRegistry}>
  <div class="wizard">
    <FormGroup label="Site name" id="site-name"><Input name="name" bind:value={name} /></FormGroup>
    {#if showTown}
      <FormGroup label="Town" id="site-town"><Input name="town" bind:value={town} /></FormGroup>
    {/if}
    <FormGroup label="Access key" id="site-key"><Input name="key" type="password" bind:value={secret} /></FormGroup>
    <button type="button">Continue</button>
  </div>
</FormScope>
