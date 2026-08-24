<script lang="ts">
import AddressInput from '../AddressInput.svelte';
import DateRangeInput from '../DateRangeInput.svelte';
import Form from '../Form.svelte';
import MeasurementInput from '../MeasurementInput.svelte';

let {
  onsubmit = undefined,
  webmcp = false,
}: {
  onsubmit?: (data: Record<string, unknown>) => void;
  webmcp?: boolean;
} = $props();
</script>

<Form {onsubmit} {webmcp}>
	<MeasurementInput name="measurement" label="Measurement" required />
	<DateRangeInput name="dates" label="Dates" required />
	<AddressInput name="address" label="Address" required />
	<button type="submit">Submit</button>
</Form>
