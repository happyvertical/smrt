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
  webmcp = false,
  textRequired = false,
  textDisabled = false,
  fieldsetDisabled = false,
  formSubject = undefined,
  ageRequired = false,
  ageMin = undefined,
  ageMax = undefined,
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  method?: 'GET' | 'POST';
  action?: string;
  textValue?: string;
  numberValue?: number | null;
  showAge?: boolean;
  webmcp?: boolean;
  textRequired?: boolean;
  textDisabled?: boolean;
  fieldsetDisabled?: boolean;
  formSubject?: { type: string; id: string; label?: string };
  ageRequired?: boolean;
  ageMin?: number;
  ageMax?: number;
} = $props();
</script>

<Form {onsubmit} {method} {action} {webmcp} subject={formSubject}>
	<fieldset disabled={fieldsetDisabled}>
	<TextInput
		name="fullname"
		label="Full name"
			required={textRequired}
			disabled={textDisabled}
		bind:value={textValue}
	/>
	{#if showAge}
		<NumberInput
			name="age"
			label="Age"
			required={ageRequired}
			min={ageMin}
			max={ageMax}
			bind:value={numberValue}
		/>
	{/if}
	</fieldset>
	<button type="submit">Submit</button>
</Form>
