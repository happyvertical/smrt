<script lang="ts">
import { SvelteSet } from 'svelte/reactivity';
import DataTable from '../src/components/data/DataTable.svelte';
import Alert from '../src/components/feedback/Alert.svelte';
import Modal from '../src/components/feedback/Modal.svelte';
import Checkbox from '../src/components/forms/Checkbox.svelte';
import Input from '../src/components/forms/Input.svelte';
import Radio from '../src/components/forms/Radio.svelte';
import RadioGroup from '../src/components/forms/RadioGroup.svelte';
import SegmentedControl from '../src/components/forms/SegmentedControl.svelte';
import Toggle from '../src/components/forms/Toggle.svelte';
import ToggleButton from '../src/components/forms/ToggleButton.svelte';
import Switch from '../src/components/forms/Switch.svelte';
import Tabs from '../src/components/nav/Tabs.svelte';
import Badge from '../src/components/ui/Badge.svelte';
import Button from '../src/components/ui/Button.svelte';
import Card from '../src/components/ui/Card.svelte';
import Chip from '../src/components/ui/Chip.svelte';
import ThemeProvider from '../src/themes/ThemeProvider.svelte';

let { inline = false, scheme = 'light' }: { inline?: boolean; scheme?: 'light' | 'dark' } = $props();
let open = $state(false);
let active = $state('one');
const selected = new SvelteSet<string | number>(['b']);
const tabs = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
];
const columns = [{ id: 'title', label: 'Title' }];
const data = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Bravo' },
];
</script>

<ThemeProvider preset="smrt" colorScheme={scheme} persist={false} inlineVariables={inline}>
  <main style="padding: 1rem; display: grid; gap: 1rem; max-inline-size: 40rem">
    <Card>Card</Card>
    <Button>Save</Button>
    <Input aria-label="Name" name="name" />
    <Switch label="Off switch" />
    <Switch label="On switch" checked />
    <Switch label="Disabled switch" disabled />
    <Toggle label="Toggle on" checked />
    <Toggle label="Toggle off" />
    <Checkbox label="Unchecked" />
    <Checkbox label="Checked" checked />
    <RadioGroup name="r" label="Radios" value="b">
      <Radio value="a" label="Radio A" />
      <Radio value="b" label="Radio B" />
    </RadioGroup>
    <Tabs {tabs} {active} onchange={(id) => (active = id)} aria-label="Sections" />
    <Chip label="Plain" selectable />
    <Chip label="Selected" selectable selected />
    <SegmentedControl label="Disabled segments" options={[{ value: 'a', label: 'Seg A' }, { value: 'b', label: 'Seg B' }]} value="a" disabled />
    <ToggleButton pressed disabled>Pressed disabled</ToggleButton>
    <Badge variant="success">Badge</Badge>
    <Alert variant="error" title="Alert title">Alert message</Alert>
    <DataTable {data} {columns} rowKey="id" {selected} selectable caption="Rows" />
    <Button onclick={() => (open = true)}>Open modal</Button>
  </main>
  {#if open}
    <Modal bind:open title="Modal title">Modal body</Modal>
  {/if}
</ThemeProvider>
