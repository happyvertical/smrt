<script lang="ts">
import Combobox from '../Combobox.svelte';
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import Listbox from '../Listbox.svelte';
import MultiSelect from '../MultiSelect.svelte';
import TagsInput from '../TagsInput.svelte';

interface Props {
  registry: ControlInteractionRegistry;
  fieldsetDisabled?: boolean;
}
let { registry, fieldsetDisabled = false }: Props = $props();
const countries = [
  { value: 'ca', label: 'Canada' },
  { value: 'us', label: 'United States' },
  { value: 'mx', label: 'Mexico' },
];
let country = $state('');
let channels = $state<Array<string | number>>([]);
let tags = $state<string[]>([]);
let region = $state<string | number>('west');
</script>

<Form formId="profile" interactionRegistry={registry} aria-label="Profile">
  <fieldset disabled={fieldsetDisabled}>
  <Combobox name="country" label="Country" options={countries} required bind:value={country} />
  <MultiSelect name="channels" label="Channels" options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }]} bind:values={channels} />
  <TagsInput name="topics" label="Topics" maxTags={2} bind:values={tags} />
  <Listbox name="region" label="Region" options={[{ value: 'west', label: 'West' }, { value: 'east', label: 'East' }]} bind:value={region} />
  </fieldset>
</Form>
