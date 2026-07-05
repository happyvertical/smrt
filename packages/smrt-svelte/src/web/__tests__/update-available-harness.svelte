<script lang="ts">
/**
 * Test harness — invokes useUpdateAvailable() inside a component init scope so
 * its `$effect`s (the state subscription + the `updated` watcher) wire up
 * correctly, then hands the reactive view back to the test via `onReady`.
 *
 * The bundle-signal source (`updated`) is a genuinely REACTIVE `$state` owned by
 * this harness, mutated by the test through the `setUpdated` control handed back
 * via `onReady`. This mirrors production, where the caller passes
 * `() => updated.current` over SvelteKit's reactive `updated` store — a plain
 * closure variable would not be tracked by the rune's `$effect`.
 */
import type { UpdateState } from '@happyvertical/smrt-web';
import {
  type UpdateAvailableView,
  useUpdateAvailable,
} from '../update-available.svelte.js';

interface Props {
  state: UpdateState;
  initialUpdated?: boolean;
  onReady: (view: UpdateAvailableView, setUpdated: (v: boolean) => void) => void;
}

const props: Props = $props();

// A reactive bundle-updated source the test drives via setUpdated. Seeds from
// the prop once at init (intentional snapshot).
// svelte-ignore state_referenced_locally
let updated = $state(props.initialUpdated ?? false);

// The harness intentionally snapshots the props during setup.
// svelte-ignore state_referenced_locally
const view = useUpdateAvailable({
  state: props.state,
  updated: () => updated,
});

// svelte-ignore state_referenced_locally
props.onReady(view, (v: boolean) => {
  updated = v;
});
</script>
