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
import Textarea from '../Textarea.svelte';
import ToggleButton from '../ToggleButton.svelte';

interface Props {
  registry: ControlInteractionRegistry;
  validInitial?: boolean;
}
let { registry, validInitial = false }: Props = $props();
let accepted = $state(false);
let notifications = $state(false);
let role = $state('editor');
let volume = $state(30);
let range = $state({ min: 20, max: 80 });
let view = $state<string | number>('grid');
let notes = $state('valid notes');
let pinned = $state(false);
$effect(() => {
  accepted = validInitial;
  notifications = validInitial;
});
</script>

<Form formId="settings" interactionRegistry={registry} aria-label="Settings">
  <Checkbox name="accepted" label="Accept terms" required bind:checked={accepted} />
  <Switch name="notifications" label="Notifications" required bind:checked={notifications} />
  <RadioGroup name="role" label="Role" bind:value={role}>
    <Radio value="editor" label="Editor" />
    <Radio value="viewer" label="Viewer" />
  </RadioGroup>
  <Slider name="volume" label="Volume" step={5} bind:value={volume} />
  <RangeSlider name="price" label="Price" step={5} bind:value={range} />
  <SegmentedControl
    name="view"
    label="View"
    options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
    bind:value={view}
  />
  <Textarea name="notes" aria-label="Notes" required minlength={3} bind:value={notes} />
  <ToggleButton name="pinned" aria-label="Pinned" bind:pressed={pinned}>Pinned</ToggleButton>
</Form>
