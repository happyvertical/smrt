<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import AddressInput from '../AddressInput.svelte';
import DateRangeInput from '../DateRangeInput.svelte';
import Form from '../Form.svelte';
import MeasurementInput from '../MeasurementInput.svelte';
import TextInput from '../TextInput.svelte';

let {
  onsubmit = undefined,
  webmcp = false,
  addressFields = ['street', 'city', 'province', 'postalCode', 'country'],
  addressCountries = undefined,
  addressProvinces = undefined,
  structuredRequired = true,
  interactionRegistry = undefined,
  fieldsetDisabled = false,
  onmeasurementchange = undefined,
  ondateschange = undefined,
  onaddresschange = undefined,
  measurementStep = undefined,
  measurementUnits = undefined,
  measurementLabel = 'Measurement',
  measurementMin = undefined,
  measurementMax = undefined,
  minDate = undefined,
  maxDate = undefined,
  dateDisabled = false,
  measurementName = 'measurement',
  showCollidingSibling = false,
  showExactNameCollisions = false,
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  webmcp?: boolean;
  addressFields?: Array<
    'street' | 'city' | 'province' | 'postalCode' | 'country'
  >;
  addressCountries?: Array<{ value: string; label: string }>;
  addressProvinces?: Array<{ value: string; label: string }>;
  structuredRequired?: boolean;
  interactionRegistry?: ControlInteractionRegistry;
  fieldsetDisabled?: boolean;
  onmeasurementchange?: (value: { value: number; unit: string } | null) => void;
  ondateschange?: (value: { startDate: string; endDate: string }) => void;
  onaddresschange?: (value: Partial<Record<string, string>>) => void;
  measurementStep?: number;
  measurementUnits?: Array<'ft' | 'in' | 'm' | 'cm' | 'mm' | 'yd'>;
  measurementLabel?: string;
  measurementMin?: number;
  measurementMax?: number;
  minDate?: string;
  maxDate?: string;
  dateDisabled?: boolean;
  measurementName?: string;
  showCollidingSibling?: boolean;
  showExactNameCollisions?: boolean;
} = $props();
</script>

<Form {onsubmit} {webmcp} {interactionRegistry} formId="structured-fields">
	<fieldset disabled={fieldsetDisabled}>
	<MeasurementInput
		name={measurementName}
		label={measurementLabel}
		required={structuredRequired}
		min={measurementMin}
		max={measurementMax}
		step={measurementStep}
		units={measurementUnits}
		onchange={onmeasurementchange}
	/>
	<DateRangeInput
		name="dates"
		label="Dates"
		required={structuredRequired}
		{minDate}
		{maxDate}
		disabled={dateDisabled}
		onchange={ondateschange}
	/>
	<AddressInput
		name="address"
		label="Address"
		fields={addressFields}
		countries={addressCountries}
		provinces={addressProvinces}
		required={structuredRequired}
		onchange={onaddresschange}
		/>
	</fieldset>
	{#if showExactNameCollisions}
		<TextInput name="address[city]" label="Exact address city" />
		<TextInput name="{measurementName}_unit" label="Exact measurement unit" />
	{/if}
	{#if showCollidingSibling}<input name="{measurementName}_note" />{/if}
	<button type="submit">Submit</button>
</Form>
