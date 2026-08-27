<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import SegmentedControl from '../SegmentedControl.svelte';

let {
  registry,
  onchange,
  modeState,
}: {
  registry: ControlInteractionRegistry;
  onchange?: (event: Event) => void;
  modeState?: {
    get?: () => string;
    set?: (next: string) => void;
  };
} = $props();

let mode = $state<'draft' | 'review' | 'published'>('draft');

$effect(() => {
  if (!modeState) return;
  modeState.get = () => mode;
  modeState.set = (next) => {
    mode = next as typeof mode;
  };
});
</script>

<Form formId="profile" interactionRegistry={registry} {onchange}>
  <SegmentedControl
    name="mode"
    label="Mode"
    bind:value={mode}
    options={[
      { value: 'draft', label: 'Draft' },
      { value: 'review', label: 'Review' },
      { value: 'published', label: 'Published' },
    ]}
  />
</Form>
