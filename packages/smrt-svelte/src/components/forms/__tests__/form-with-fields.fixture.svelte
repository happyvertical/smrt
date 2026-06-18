<script lang="ts">
/** Test fixture (S11 #1416): a Form wrapping a TextInput + NumberInput so the
 *  Form's field-registration → value-collection → onsubmit contract can be
 *  exercised end-to-end (the submit handler reads each registered field's
 *  getValue()). */
import Form from '../Form.svelte';
import NumberInput from '../NumberInput.svelte';
import TextInput from '../TextInput.svelte';

let {
  onsubmit = undefined,
  method = undefined,
  action = undefined,
  textValue = '',
  numberValue = null,
  showAge = true,
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  method?: 'GET' | 'POST';
  action?: string;
  textValue?: string;
  numberValue?: number | null;
  showAge?: boolean;
} = $props();
</script>

<Form {onsubmit} {method} {action}>
	<TextInput name="fullname" label="Full name" bind:value={textValue} />
	{#if showAge}
		<NumberInput name="age" label="Age" bind:value={numberValue} />
	{/if}
	<button type="submit">Submit</button>
</Form>
