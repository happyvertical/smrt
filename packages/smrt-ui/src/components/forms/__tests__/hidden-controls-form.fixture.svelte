<script lang="ts">
import Combobox from '../Combobox.svelte';
import Listbox from '../Listbox.svelte';
import MultiSelect from '../MultiSelect.svelte';

let {
  listbox = $bindable('a'),
  combobox = $bindable('a'),
  multi = $bindable<Array<string | number>>(['a']),
}: {
  listbox?: string | number;
  combobox?: string;
  multi?: Array<string | number>;
} = $props();

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
];
</script>

<!-- #3331's choice controls post through hidden inputs, not visible fields. -->
<form method="POST">
  <input name="title" aria-label="Title" />
  <Listbox name="listbox" label="Listbox" bind:value={listbox} {options} interaction={false} />
  <Combobox name="combobox" label="Combobox" bind:value={combobox} {options} interaction={false} />
  <MultiSelect name="multi" label="Multi" bind:values={multi} {options} interaction={false} />
  <button type="submit">Send</button>
</form>
