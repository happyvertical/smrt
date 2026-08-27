<script lang="ts">
import { getFormContext } from '../../../state/form-context.js';
import CustomRegistrationField from './custom-registration-field.fixture.svelte';

let {
  showFirst,
  showReplacement,
  legacyCleanup,
}: {
  showFirst: boolean;
  showReplacement: boolean;
  legacyCleanup: boolean;
} = $props();

// Compound fields often read the context for their own coordination before
// mounting nested custom fields. Their descendants must still own cleanup.
const formId = getFormContext().formId;
</script>

<div data-compound-form={formId}>
  {#if showFirst}
    <CustomRegistrationField name="custom-shared" label="Custom first" {legacyCleanup} />
  {/if}
  {#if showReplacement}
    <CustomRegistrationField name="custom-shared" label="Custom replacement" {legacyCleanup} />
  {/if}
</div>
