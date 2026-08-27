<script lang="ts">
import DateRangeInput from '../DateRangeInput.svelte';
import Form from '../Form.svelte';
import NumberInput from '../NumberInput.svelte';
import TextInput from '../TextInput.svelte';

let {
  onagechange,
  ondateschange,
  ontextchange,
  showDateRange = false,
}: {
  onagechange?: (value: number | null) => void;
  ondateschange?: (value: { startDate: string; endDate: string }) => void;
  ontextchange?: (value: string) => void;
  showDateRange?: boolean;
} = $props();
</script>

<Form showFormListen sttAdapter="browser-speech">
  <NumberInput name="age" label="Age" onchange={onagechange} />
  {#if showDateRange}
    <DateRangeInput name="dates" label="Dates" onchange={ondateschange} />
  {/if}
  <TextInput name="fullname" label="Full name" onchange={ontextchange} />
</Form>
