<script lang="ts">
/**
 * Integration harness — invokes activityFeed() inside a component-init scope so
 * the `$effect` it (and the underlying `liveCollection`) installs wires up to a
 * real component lifecycle, then hands the feed handle back to the test.
 */
import type { SmrtWebCollection } from '@happyvertical/smrt-web';
import {
  activityFeed,
  type ActivityFeedHandle,
  type ActivityFeedMap,
} from '../activity-feed.svelte.js';
import type { ShellState } from '../../components/workspace/index.js';

interface Props {
  collection: SmrtWebCollection<Record<string, unknown>>;
  shell: ShellState;
  map: ActivityFeedMap<Record<string, unknown>>;
  onReady: (handle: ActivityFeedHandle) => void;
}

const props: Props = $props();
// This harness intentionally snapshots its props during setup.
// svelte-ignore state_referenced_locally
const handle = activityFeed({
  collection: props.collection,
  shell: props.shell,
  map: props.map,
});
// svelte-ignore state_referenced_locally
props.onReady(handle);
</script>
