<script lang="ts">
/** Test fixture (S11 #1416): a Form wrapping a TextInput + NumberInput so the
 *  Form's field-registration → value-collection → onsubmit contract can be
 *  exercised end-to-end (the submit handler reads each registered field's
 *  getValue()). */
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import Form from '../Form.svelte';
import MoneyInput from '../MoneyInput.svelte';
import NumberInput from '../NumberInput.svelte';
import TextInput from '../TextInput.svelte';

let {
  onsubmit = undefined,
  method = undefined,
  action = undefined,
  textValue = '',
  numberValue = null,
  showAge = true,
  showMoney = false,
  moneyMin = undefined,
  moneyMax = undefined,
  webmcp = false,
  textRequired = false,
  textDisabled = false,
  fieldsetDisabled = false,
  formSubject = undefined,
  ageRequired = false,
  ageLabel = 'Age',
  ageMin = undefined,
  ageMax = undefined,
  ageStep = undefined,
  interactionRegistry = undefined,
  onnumberchange = undefined,
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  method?: 'GET' | 'POST';
  action?: string;
  textValue?: string;
  numberValue?: number | null;
  showAge?: boolean;
  showMoney?: boolean;
  moneyMin?: number;
  moneyMax?: number;
  webmcp?: boolean;
  textRequired?: boolean;
  textDisabled?: boolean;
  fieldsetDisabled?: boolean;
  formSubject?: { type: string; id: string; label?: string };
  ageRequired?: boolean;
  ageLabel?: string;
  ageMin?: number;
  ageMax?: number;
  ageStep?: number;
  interactionRegistry?: ControlInteractionRegistry;
  onnumberchange?: (value: number | null) => void;
} = $props();
let lastSubject: { type: string; id: string; label?: string } | undefined;
let mutableSubject = $state<
  { type: string; id: string; label?: string } | undefined
>(undefined);
$effect(() => {
  const nextSubject = formSubject;
  if (nextSubject !== lastSubject) {
    lastSubject = nextSubject;
    mutableSubject = nextSubject ? { ...nextSubject } : undefined;
  }
});
function mutateSubject() {
  if (mutableSubject) mutableSubject.id = 'person-mutated';
}
</script>

<Form {onsubmit} {method} {action} {webmcp} {interactionRegistry} subject={mutableSubject}>
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
				label={ageLabel}
			required={ageRequired}
			min={ageMin}
			max={ageMax}
			step={ageStep}
			onchange={onnumberchange}
			bind:value={numberValue}
		/>
	{/if}
	{#if showMoney}
			<MoneyInput name="budget" label="Budget" min={moneyMin} max={moneyMax} />
	{/if}
	</fieldset>
	{#if mutableSubject}
		<button type="button" onclick={mutateSubject}>Mutate subject</button>
	{/if}
	<button type="submit">Submit</button>
</Form>
