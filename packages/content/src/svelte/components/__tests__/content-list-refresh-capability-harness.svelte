<script lang="ts">
import type { ContentData } from '../../../mock-smrt-client.js';
import type {
  ContentListQueryBinding,
  ContentListQuerySource,
} from '../../content-list-query.js';
import type { ContentListJobBinding } from '../../content-list-runtime.js';
import ContentList from '../ContentList.svelte';

interface Props {
  contents: ContentData[];
  jobs: ContentListJobBinding;
  onReady: (enableRefresh: () => void) => void;
  onRefresh: () => void;
}

const props: Props = $props();
let refreshEnabled = $state(false);
const binding: ContentListQueryBinding = {
  get rows() {
    return props.contents.map((content) => ({ ...content }));
  },
  get total() {
    return { kind: 'exact' as const, value: props.contents.length };
  },
  loading: false,
  refreshing: false,
  stale: false,
  error: null,
  async execute() {
    return { rows: props.contents, total: props.contents.length };
  },
  get refresh() {
    if (!refreshEnabled) return undefined;
    return async () => {
      props.onRefresh();
      return { rows: props.contents, total: props.contents.length };
    };
  },
  async retry() {
    return { rows: props.contents, total: props.contents.length };
  },
};
const query: ContentListQuerySource = { bind: () => binding };

// svelte-ignore state_referenced_locally
props.onReady(() => {
  refreshEnabled = true;
});
</script>

<ContentList
  query={query}
  jobs={props.jobs}
  onEdit={() => undefined}
  onDelete={() => undefined}
  onAdd={() => undefined}
/>
