<script lang="ts">
import Combobox from '../src/components/forms/Combobox.svelte';
import Listbox from '../src/components/forms/Listbox.svelte';
import MultiSelect from '../src/components/forms/MultiSelect.svelte';
import type { ControlOption } from '../src/components/forms/control-interaction.js';

const countries = [
  { value: 'ca', label: 'Canada' },
  { value: 'us', label: 'United States' },
];
let warehouses = $state<ControlOption[]>([
  { value: 'archived', label: 'Archived warehouse', disabled: true },
  { value: 'local', label: 'Local warehouse' },
]);
let channelsOptions = $state<ControlOption[]>([
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'archived', label: 'Archived channel', disabled: true },
]);
let country = $state('ca');
let warehouse = $state<string | number>('archived');
let channels = $state<Array<string | number>>(['email', 'archived']);
let callbackLog = $state<string[]>([]);

function recordChange(control: string, value: string | number | Array<string | number>) {
  const formatted = Array.isArray(value) ? value.join(',') : String(value);
  callbackLog = [...callbackLog, `${control}:${formatted}`];
}

function toggleDisabledSelections() {
  warehouses = warehouses.map((option) =>
    option.value === 'archived'
      ? { ...option, disabled: !option.disabled }
      : option,
  );
  channelsOptions = channelsOptions.map((option) =>
    option.value === 'archived'
      ? { ...option, disabled: !option.disabled }
      : option,
  );
}
</script>

<form aria-label="Choice posting">
  <Combobox
    name="country"
    label="Country"
    options={countries}
    bind:value={country}
    onvaluechange={(value) => recordChange('country', value)}
  />
  <output data-bound="country">{country}</output>

  <Listbox
    name="warehouse"
    label="Warehouse"
    options={warehouses}
    bind:value={warehouse}
    onvaluechange={(value) => recordChange('warehouse', value)}
  />
  <output data-bound="warehouse">{warehouse}</output>

  <MultiSelect
    name="channels"
    label="Channels"
    options={channelsOptions}
    bind:values={channels}
    onvalueschange={(values) => recordChange('channels', values)}
  />
  <output data-bound="channels">{channels.join(',')}</output>
  <output data-callback-log>{callbackLog.join('|')}</output>

  <button type="button" onclick={toggleDisabledSelections}>
    Toggle archived options
  </button>
  <button type="reset">Reset choices</button>
</form>
