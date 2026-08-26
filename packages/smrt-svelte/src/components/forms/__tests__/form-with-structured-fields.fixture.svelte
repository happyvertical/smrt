<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import AddressInput from '../AddressInput.svelte';
import DateRangeInput from '../DateRangeInput.svelte';
import Form from '../Form.svelte';
import MeasurementInput from '../MeasurementInput.svelte';

let {
  onsubmit = undefined,
  webmcp = false,
  addressFields = ['street', 'city', 'province', 'postalCode', 'country'],
  structuredRequired = true,
  interactionRegistry = undefined,
  fieldsetDisabled = false,
  onmeasurementchange = undefined,
  ondateschange = undefined,
  onaddresschange = undefined,
  measurementStep = undefined,
  measurementUnits = undefined,
  minDate = undefined,
  maxDate = undefined,
  dateDisabled = false,
  measurementName = 'measurement',
  showCollidingSibling = false,
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  webmcp?: boolean;
  addressFields?: Array<
    'street' | 'city' | 'province' | 'postalCode' | 'country'
  >;
  structuredRequired?: boolean;
  interactionRegistry?: ControlInteractionRegistry;
  fieldsetDisabled?: boolean;
  onmeasurementchange?: (value: { value: number; unit: string } | null) => void;
  ondateschange?: (value: { startDate: string; endDate: string }) => void;
  onaddresschange?: (value: Partial<Record<string, string>>) => void;
  measurementStep?: number;
  measurementUnits?: Array<'ft' | 'in' | 'm' | 'cm' | 'mm' | 'yd'>;
  minDate?: string;
  maxDate?: string;
  dateDisabled?: boolean;
  measurementName?: string;
  showCollidingSibling?: boolean;
} = $props();
</script>

<Form {onsubmit} {webmcp} {interactionRegistry} formId="structured-fields">
	<fieldset disabled={fieldsetDisabled}>
	<MeasurementInput
		name={measurementName}
		label="Measurement"
		required={structuredRequired}
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
		required={structuredRequired}
		onchange={onaddresschange}
		/>
	</fieldset>
	{#if showCollidingSibling}<input name="{measurementName}_note" />{/if}
	<button type="submit">Submit</button>
</Form>
