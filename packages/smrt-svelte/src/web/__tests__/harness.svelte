<script lang="ts">
/**
 * Test harness — invokes liveCollection() inside a component init scope so the
 * `$effect` that `useLiveQuery` installs wires up correctly, then hands the
 * returned reactive view back to the test via the `onReady` callback prop.
 */
import type { SmrtWebCollection } from '@happyvertical/smrt-web';
import {
  type LiveCollection,
  liveCollection,
} from '../live-collection.svelte.js';

interface Props {
  handle: SmrtWebCollection<Record<string, unknown>>;
  onReady: (view: LiveCollection<Record<string, unknown>>) => void;
}

const props: Props = $props();
// This harness intentionally snapshots the handle during setup.
// svelte-ignore state_referenced_locally
const view = liveCollection(props.handle);
// This harness intentionally snapshots the callback during setup.
// svelte-ignore state_referenced_locally
props.onReady(view);
</script>
