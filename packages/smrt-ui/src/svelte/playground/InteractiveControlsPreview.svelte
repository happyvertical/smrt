<script lang="ts">
import Checkbox from '../../components/forms/Checkbox.svelte';
import Combobox from '../../components/forms/Combobox.svelte';
import {
  type ControlCommand,
  createControlInteractionRegistry,
} from '../../components/forms/control-interaction.js';
import DatePicker from '../../components/forms/DatePicker.svelte';
import FilePicker from '../../components/forms/FilePicker.svelte';
import Form from '../../components/forms/Form.svelte';
import Listbox from '../../components/forms/Listbox.svelte';
import MultiSelect from '../../components/forms/MultiSelect.svelte';
import Radio from '../../components/forms/Radio.svelte';
import RadioGroup from '../../components/forms/RadioGroup.svelte';
import RangeSlider from '../../components/forms/RangeSlider.svelte';
import SegmentedControl from '../../components/forms/SegmentedControl.svelte';
import Slider from '../../components/forms/Slider.svelte';
import Switch from '../../components/forms/Switch.svelte';
import TagsInput from '../../components/forms/TagsInput.svelte';
import TimePicker from '../../components/forms/TimePicker.svelte';
import ToggleButton from '../../components/forms/ToggleButton.svelte';
import Button from '../../components/ui/Button.svelte';

const registry = createControlInteractionRegistry();
const countries = [
  { value: 'ca', label: 'Canada' },
  { value: 'us', label: 'United States' },
  { value: 'mx', label: 'Mexico' },
];
let accepted = $state(true);
let notifications = $state(true);
let pinned = $state(false);
let role = $state('editor');
let volume = $state(35);
let budget = $state({ min: 25, max: 75 });
let view = $state<string | number>('grid');
let country = $state('ca');
let channels = $state<Array<string | number>>(['email']);
let tags = $state(['svelte', 'agents']);
let region = $state<string | number>('west');
let status = $state('Controls are ready for direct use or agent guidance.');

async function command(command: ControlCommand, confirmed = false) {
  const result = await registry.execute(command, {
    source: 'agent',
    confirmed,
  });
  status = result.ok
    ? `${command.action} completed for ${command.identity.controlId}.`
    : (result.reason ?? 'Command denied.');
}

const identity = (controlId: string) => ({
  formId: 'foundation-demo',
  controlId,
});
</script>

<div class="workbench">
  <header>
    <div><p class="eyebrow">Addressable controls</p><h4>Interactive form foundation</h4><p>Every control exposes stable identity, capability, state, and consent-aware mutation hooks.</p></div>
    <div class="agent-actions">
      <Button size="sm" variant="secondary" onclick={() => command({ action: 'highlight', identity: identity('country') })}>Highlight country</Button>
      <Button size="sm" variant="secondary" onclick={() => command({ action: 'stage', identity: identity('volume'), value: 72 })}>Stage volume 72</Button>
      <Button size="sm" onclick={() => command({ action: 'apply', identity: identity('volume') }, true)}>Confirm staged value</Button>
    </div>
  </header>
  <p class="agent-status" aria-live="polite">Agent: {status}</p>

  <Form formId="foundation-demo" interactionRegistry={registry} aria-label="Foundation controls">
    <section><h5>Choice and state</h5><div class="grid compact">
      <Checkbox name="accepted" label="Accept terms" bind:checked={accepted} />
      <Switch name="notifications" label="Notifications" bind:checked={notifications} />
      <ToggleButton name="pinned" bind:pressed={pinned}>Pin workspace</ToggleButton>
      <RadioGroup name="role" label="Role" bind:value={role}><Radio value="editor" label="Editor" /><Radio value="viewer" label="Viewer" /></RadioGroup>
      <SegmentedControl name="view" label="View mode" options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }, { value: 'table', label: 'Table' }]} bind:value={view} />
      <Listbox name="region" label="Region" options={[{ value: 'west', label: 'West' }, { value: 'central', label: 'Central' }, { value: 'east', label: 'East' }]} bind:value={region} />
    </div></section>

    <section><h5>Ranges</h5><div class="grid">
      <Slider name="volume" label="Volume" unit="%" bind:value={volume} />
      <RangeSlider name="budget" label="Budget range" unit="%" bind:value={budget} />
    </div></section>

    <section><h5>Structured input</h5><div class="grid">
      <Combobox name="country" label="Country" options={countries} bind:value={country} />
      <MultiSelect name="channels" label="Channels" options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }, { value: 'push', label: 'Push' }]} bind:values={channels} />
      <TagsInput name="topics" label="Topics" bind:values={tags} />
      <DatePicker name="date" label="Publish date" />
      <TimePicker name="time" label="Publish time" />
      <FilePicker name="assets" label="Assets" accept="image/*" multiple />
    </div></section>
  </Form>
</div>

<style>
  .workbench { display: grid; gap: var(--smrt-spacing-5); color: var(--smrt-color-on-surface); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--smrt-spacing-5); padding-bottom: var(--smrt-spacing-4); border-bottom: 1px solid var(--smrt-color-outline-variant); }
  h4, h5, p { margin: 0; } h4 { font: var(--smrt-typography-headline-small-font); } h5 { margin-bottom: var(--smrt-spacing-3); font: var(--smrt-typography-title-medium-font); }
  header p:not(.eyebrow) { max-width: 40rem; color: var(--smrt-color-on-surface-variant); }
  .eyebrow { color: var(--smrt-color-primary); font: var(--smrt-typography-label-small-font); letter-spacing: .1em; text-transform: uppercase; }
  .agent-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--smrt-spacing-2); }
  .agent-status { padding: var(--smrt-spacing-3); border-inline-start: 3px solid var(--smrt-color-tertiary); background: var(--smrt-color-surface-container-low); color: var(--smrt-color-on-surface-variant); }
  :global(form) { display: grid; gap: var(--smrt-spacing-6); }
  section { min-width: 0; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-5); align-items: start; }
  .grid.compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (max-width: 900px) { header { flex-direction: column; } .agent-actions { justify-content: flex-start; } .grid, .grid.compact { grid-template-columns: 1fr; } }
</style>
