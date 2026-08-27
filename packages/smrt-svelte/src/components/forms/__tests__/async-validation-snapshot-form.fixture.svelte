<script lang="ts">
import Form from '../Form.svelte';
import TextInput from '../TextInput.svelte';
import AsyncInvalidField from './async-invalid-field.fixture.svelte';

let {
  onsubmit,
  validate,
}: {
  onsubmit: (data: Record<string, unknown>) => void | Promise<void>;
  validate: () => boolean | Promise<boolean>;
} = $props();

let laterValue = $state('before');
</script>

<Form {onsubmit} webmcp>
  <AsyncInvalidField {validate} />
  <TextInput name="later" label="Later value" bind:value={laterValue} />
  <button type="submit">Submit</button>
</Form>
