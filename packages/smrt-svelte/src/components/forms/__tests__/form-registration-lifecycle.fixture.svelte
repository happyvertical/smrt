<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import Form from '../Form.svelte';
import TextInput from '../TextInput.svelte';

let {
  interactionRegistry,
  firstName = 'first',
  showFirst = true,
  showReplacement = false,
}: {
  interactionRegistry: ControlInteractionRegistry;
  firstName?: string;
  showFirst?: boolean;
  showReplacement?: boolean;
} = $props();
</script>

<Form {interactionRegistry} formId="registration-lifecycle">
  {#if showFirst}
    <TextInput name={firstName} label="First field" />
  {/if}
  {#if showReplacement}
    <TextInput name="shared" label="Replacement field" />
  {/if}
</Form>
