<script lang="ts">
import SegmentedControl from '../SegmentedControl.svelte';

let {
  required = false,
  disabled = false,
  outerDisabled = false,
  initial = 'one',
  named = true,
  onvaluechange,
}: {
  required?: boolean;
  disabled?: boolean;
  outerDisabled?: boolean;
  initial?: string | number;
  named?: boolean;
  onvaluechange?: (value: string | number) => void;
} = $props();
let value = $state(initial);
</script>
<form>
  <fieldset disabled={outerDisabled}>
    <SegmentedControl name={named ? 'kind' : undefined} label="Kind" bind:value {onvaluechange} {required} {disabled}
      options={[{ value: 'one', label: 'One' }, { value: 'off', label: 'Disabled', disabled: true }, { value: 0, label: 'Zero' }]} density="touch" />
  </fieldset>
  <span data-bound-value data-bound-type={typeof value}>{String(value)}</span>
  <button type="reset">Reset</button>
</form>
