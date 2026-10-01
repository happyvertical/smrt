<script lang="ts">
import Provider from '../Provider.svelte';
import type { AppMode } from '../state/app-state.js';
import type { SmrtAppStateManager } from '../state/app-state.svelte.js';
import Probe from './provider-mode-probe.svelte';

interface Props {
  mode?: AppMode;
  autoEnableSmrt?: boolean;
  capture: (state: SmrtAppStateManager) => void;
}
const { mode, autoEnableSmrt, capture }: Props = $props();
</script>
<Provider {mode} {autoEnableSmrt}><Probe {capture} /></Provider>
