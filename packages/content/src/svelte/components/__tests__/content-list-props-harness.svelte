<script lang="ts">
/**
 * Mounts `ContentList` with a REACTIVE `type` prop (#2452).
 *
 * The component's `type` lock distinguishes "there was never a lock" from "the
 * lock was just removed", and that distinction only exists across a prop
 * change. Every other ContentList test mounts static props, so the removal
 * branch had no coverage in either direction; this harness drives it.
 */
import type { ContentData } from '../../../mock-smrt-client.js';
import ContentList from '../ContentList.svelte';

interface Props {
  contents: ContentData[];
  type?: string;
  onEdit: (content: ContentData) => void;
  onDelete: (content: ContentData) => void;
  onAdd: () => void;
  /** Receives a setter for the reactive `type` prop, once, at initialization. */
  onReady: (setType: (next: string | undefined) => void) => void;
}

const props: Props = $props();
// svelte-ignore state_referenced_locally
let currentType = $state<string | undefined>(props.type);
// svelte-ignore state_referenced_locally
props.onReady((next) => {
  currentType = next;
});
</script>

<ContentList
  contents={props.contents}
  type={currentType}
  onEdit={props.onEdit}
  onDelete={props.onDelete}
  onAdd={props.onAdd}
/>
