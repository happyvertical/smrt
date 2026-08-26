<script lang="ts">
/** Test fixture (S11 #1416): a Form wrapping a TextInput + NumberInput so the
 *  Form's field-registration → value-collection → onsubmit contract can be
 *  exercised end-to-end (the submit handler reads each registered field's
 *  getValue()). */
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import CheckboxInput from '../CheckboxInput.svelte';
import DateTimeInput from '../DateTimeInput.svelte';
import Form from '../Form.svelte';
import MoneyInput from '../MoneyInput.svelte';
import NumberInput from '../NumberInput.svelte';
import PhoneInput from '../PhoneInput.svelte';
import SelectInput from '../SelectInput.svelte';
import TextareaInput from '../TextareaInput.svelte';
import TextInput from '../TextInput.svelte';

let {
  onsubmit = undefined,
  method = undefined,
  action = undefined,
  textValue = '',
  numberValue = null,
  showAge = true,
  showMoney = false,
  showClearFields = false,
  showScalarFields = false,
  checkboxValue = true,
  selectValue = 'second',
  dateValue = '',
  phoneValue = '',
  notesValue = '',
  notesAppendMode = false,
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
  showClearFields?: boolean;
  showScalarFields?: boolean;
  checkboxValue?: boolean;
  selectValue?: string;
  dateValue?: string;
  phoneValue?: string;
  notesValue?: string;
  notesAppendMode?: boolean;
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
	{#if showClearFields}
		<CheckboxInput name="enabled" label="Enabled" bind:checked={checkboxValue} />
		<SelectInput
			name="choice"
			label="Choice"
			options={[
				{ value: 'first', label: 'First' },
				{ value: 'second', label: 'Second' },
			]}
			bind:value={selectValue}
		/>
	{/if}
	{#if showScalarFields}
		<DateTimeInput name="appointment" label="Appointment" includeTime={false} bind:value={dateValue} />
		<PhoneInput name="phone" label="Phone" bind:value={phoneValue} />
		<TextareaInput name="notes" label="Notes" appendMode={notesAppendMode} bind:value={notesValue} />
	{/if}
	</fieldset>
	{#if mutableSubject}
		<button type="button" onclick={mutateSubject}>Mutate subject</button>
	{/if}
	<button type="submit">Submit</button>
</Form>
