<script lang="ts">
import Checkbox from '../Checkbox.svelte';
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import Radio from '../Radio.svelte';
import RadioGroup from '../RadioGroup.svelte';
import RangeSlider from '../RangeSlider.svelte';
import SegmentedControl from '../SegmentedControl.svelte';
import Slider from '../Slider.svelte';
import Switch from '../Switch.svelte';

interface Props {
  registry: ControlInteractionRegistry;
}
let { registry }: Props = $props();
let accepted = $state(false);
let notifications = $state(false);
let role = $state('editor');
let volume = $state(30);
let range = $state({ min: 20, max: 80 });
let view = $state<string | number>('grid');
</script>

<Form formId="settings" interactionRegistry={registry} aria-label="Settings">
  <Checkbox name="accepted" label="Accept terms" bind:checked={accepted} />
  <Switch name="notifications" label="Notifications" bind:checked={notifications} />
  <RadioGroup name="role" label="Role" bind:value={role}>
    <Radio value="editor" label="Editor" />
    <Radio value="viewer" label="Viewer" />
  </RadioGroup>
  <Slider name="volume" label="Volume" bind:value={volume} />
  <RangeSlider name="price" label="Price" bind:value={range} />
  <SegmentedControl
    name="view"
    label="View"
    options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
    bind:value={view}
  />
</Form>
