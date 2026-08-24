<script lang="ts">
import AddressInput from '../AddressInput.svelte';
import DateRangeInput from '../DateRangeInput.svelte';
import Form from '../Form.svelte';
import MeasurementInput from '../MeasurementInput.svelte';

let {
  onsubmit = undefined,
  webmcp = false,
  addressFields = ['street', 'city', 'province', 'postalCode', 'country'],
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  webmcp?: boolean;
  addressFields?: Array<
    'street' | 'city' | 'province' | 'postalCode' | 'country'
  >;
} = $props();
</script>

<Form {onsubmit} {webmcp}>
	<MeasurementInput name="measurement" label="Measurement" required />
	<DateRangeInput name="dates" label="Dates" required />
	<AddressInput
		name="address"
		label="Address"
		fields={addressFields}
		required
	/>
	<button type="submit">Submit</button>
</Form>
