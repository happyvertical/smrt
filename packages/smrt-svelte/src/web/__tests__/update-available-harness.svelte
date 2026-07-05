<script lang="ts">
/**
 * Test harness — invokes useUpdateAvailable() inside a component init scope so
 * its `$effect`s (the state subscription + the `updated` watcher) wire up
 * correctly, then hands the reactive view back to the test via `onReady`.
 */
import type { UpdateState } from '@happyvertical/smrt-web';
import {
  type UpdateAvailableView,
  useUpdateAvailable,
} from '../update-available.svelte.js';

interface Props {
  state: UpdateState;
  getUpdated: () => boolean;
  onReady: (view: UpdateAvailableView) => void;
}

const props: Props = $props();
// The harness intentionally snapshots the props during setup.
// svelte-ignore state_referenced_locally
const view = useUpdateAvailable({
  state: props.state,
  updated: () => props.getUpdated(),
});
// svelte-ignore state_referenced_locally
props.onReady(view);
</script>
