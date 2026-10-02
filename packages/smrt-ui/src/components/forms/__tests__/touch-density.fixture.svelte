<script lang="ts">
import ThemeProvider from '../../../themes/ThemeProvider.svelte';
import DataTable from '../../data/DataTable.svelte';
import FilterChips from '../../nav/FilterChips.svelte';
import Button from '../../ui/Button.svelte';
import Checkbox from '../Checkbox.svelte';
import Input from '../Input.svelte';
import Radio from '../Radio.svelte';
import RadioGroup from '../RadioGroup.svelte';
import SegmentedControl from '../SegmentedControl.svelte';
import Select from '../Select.svelte';
import Switch from '../Switch.svelte';
import Textarea from '../Textarea.svelte';

let {
  density = 'touch',
  target = '48px',
}: { density?: 'comfortable' | 'touch'; target?: string } = $props();
</script>
<ThemeProvider {density} overrides={{ '--smrt-touch-target-min': target }} persist={false} inlineVariables>
  <Input aria-label="Name" name="name" size={12} />
  <Select aria-label="Choice"><option value="one">One</option></Select>
  <Textarea aria-label="Notes" />
  <Checkbox label="Approve" />
  <Switch label="Enable" />
  <RadioGroup name="radio" label="Radio"><Radio value="one" label="Option one" /></RadioGroup>
  <Button size="sm">Save</Button>
  <Button href="/details" size="sm">Details</Button>
  <FilterChips size="sm" options={[{ value: 'one', label: 'One' }, { value: 'off', label: 'Disabled', disabled: true }]} selected="one" />
  <SegmentedControl label="Segments" options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} />
  <DataTable data={[{ id: 'one', title: 'Item' }]} columns={[{ id: 'title', label: 'Title', sortable: true }]} sortable rowKey="id" />
  <Input aria-label="Local touch" density="touch" />
  <Input aria-label="Local comfortable" density="comfortable" />
</ThemeProvider>
