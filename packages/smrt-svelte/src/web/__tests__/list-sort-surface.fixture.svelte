<script lang="ts">
import type {
  DataSurfaceRegistry,
  ListSort,
} from '@happyvertical/smrt-ui/data';
import { useListSurface } from '../list-surface.svelte.js';

let {
  registry,
  rows,
  sort = $bindable({ columnId: 'published', direction: 'desc' }),
  deny = false,
}: {
  registry: DataSurfaceRegistry;
  rows: Array<{ id: string; title: string; published: string }>;
  sort?: ListSort;
  deny?: boolean;
} = $props();

useListSurface(
  () => ({
    surfaceId: 'stories-ui',
    label: 'Stories',
    description: 'Stories on this page',
    columns: [
      { id: 'id', label: 'ID', rowKey: true },
      { id: 'title', label: 'Title', sortable: true },
      { id: 'published', label: 'Published', sortable: true },
    ],
    rows,
    sort,
    onSort: (next) => {
      if (deny) return false;
      sort = next;
    },
  }),
  registry,
);
</script>

<p data-testid="sort">{sort.columnId}:{sort.direction}</p>
