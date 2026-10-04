<script lang="ts">
import { untrack } from 'svelte';
import type { SmrtAppStateManager } from '../state/app-state.svelte.js';
import { getAppStateContext } from '../state/context.js';

interface Props {
  capture: (state: SmrtAppStateManager) => void;
}
const { capture }: Props = $props();
const appState = getAppStateContext();
untrack(() => capture(appState));
</script>
<output aria-label="App mode">{appState.state.mode}</output>
