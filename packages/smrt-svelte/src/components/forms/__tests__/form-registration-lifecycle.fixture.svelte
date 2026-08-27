<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import Form from '../Form.svelte';
import TextInput from '../TextInput.svelte';
import CustomRegistrationField from './custom-registration-field.fixture.svelte';

let {
  interactionRegistry,
  firstName = 'first',
  showFirst = true,
  showReplacement = false,
  showCustomFirst = false,
  showCustomReplacement = false,
  legacyCustomCleanup = false,
  separateLegacyCleanupContext = false,
}: {
  interactionRegistry: ControlInteractionRegistry;
  firstName?: string;
  showFirst?: boolean;
  showReplacement?: boolean;
  showCustomFirst?: boolean;
  showCustomReplacement?: boolean;
  legacyCustomCleanup?: boolean;
  separateLegacyCleanupContext?: boolean;
} = $props();
</script>

<Form {interactionRegistry} formId="registration-lifecycle">
  {#if showFirst}
    <TextInput name={firstName} label="First field" />
  {/if}
  {#if showReplacement}
    <TextInput name="shared" label="Replacement field" />
  {/if}
  {#if showCustomFirst}
    <CustomRegistrationField name="custom-shared" label="Custom first" legacyCleanup={legacyCustomCleanup} {separateLegacyCleanupContext} />
  {/if}
  {#if showCustomReplacement}
    <CustomRegistrationField name="custom-shared" label="Custom replacement" legacyCleanup={legacyCustomCleanup} {separateLegacyCleanupContext} />
  {/if}
</Form>
