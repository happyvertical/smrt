<script lang="ts">
/** Test fixture (L1 #1420): an Input wrapped in a FormGroup, to exercise the
 *  FormGroup → base-input accessibility auto-wiring. */
import FormGroup from '../FormGroup.svelte';
import Input from '../Input.svelte';

let {
  error = undefined,
  hint = undefined,
  required = false,
}: { error?: string; hint?: string; required?: boolean } = $props();
</script>

<FormGroup label="Email" {error} {hint} {required}>
	<Input type="email" name="email" />
</FormGroup>
