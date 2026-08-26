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
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  webmcp?: boolean;
  addressFields?: Array<
    'street' | 'city' | 'province' | 'postalCode' | 'country'
  >;
  structuredRequired?: boolean;
  interactionRegistry?: ControlInteractionRegistry;
} = $props();
</script>

<Form {onsubmit} {webmcp} {interactionRegistry} formId="structured-fields">
	<MeasurementInput
		name="measurement"
		label="Measurement"
		required={structuredRequired}
	/>
	<DateRangeInput
		name="dates"
		label="Dates"
		required={structuredRequired}
	/>
	<AddressInput
		name="address"
		label="Address"
		fields={addressFields}
		required={structuredRequired}
	/>
	<button type="submit">Submit</button>
</Form>
