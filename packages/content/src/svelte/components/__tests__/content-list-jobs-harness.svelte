<script lang="ts">
import type { ContentData } from '../../../mock-smrt-client.js';
import type { ContentListJobBinding } from '../../content-list-runtime.js';
import ContentList from '../ContentList.svelte';

interface Props {
  contents: ContentData[];
  onReady: (setJobs: (next: ContentListJobBinding | undefined) => void) => void;
}

const props: Props = $props();
// svelte-ignore state_referenced_locally
let currentJobs = $state<ContentListJobBinding | undefined>(undefined);
// svelte-ignore state_referenced_locally
props.onReady((next) => {
  currentJobs = next;
});
</script>

<ContentList
  contents={props.contents}
  jobs={currentJobs}
  onEdit={() => undefined}
  onDelete={() => undefined}
  onAdd={() => undefined}
/>
