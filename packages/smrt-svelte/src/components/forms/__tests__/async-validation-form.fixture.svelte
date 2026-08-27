<script lang="ts">
import Form from '../Form.svelte';
import AsyncInvalidField from './async-invalid-field.fixture.svelte';

let {
  onsubmit,
  validate,
  webmcp = true,
}: {
  onsubmit: (data: Record<string, unknown>) => void | Promise<void>;
  validate: () => boolean | Promise<boolean>;
  webmcp?: boolean;
} = $props();
</script>

<Form {onsubmit} {webmcp}>
  <AsyncInvalidField {validate} />
  <button type="submit">Submit</button>
</Form>
