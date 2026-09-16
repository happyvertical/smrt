<script lang="ts">
import type {
  DataSurfaceDescriptor,
  DataSurfaceRegistry,
  DataTableController,
} from '@happyvertical/smrt-ui/data';
import {
  type ListDataSurfaceContext,
  mountListDataSurface,
} from '../list-data-surface.svelte.js';

let {
  registry,
  descriptor,
  controller,
  context,
  onRefresh,
  onStar,
}: {
  registry: DataSurfaceRegistry;
  descriptor: DataSurfaceDescriptor;
  controller: DataTableController;
  context: ListDataSurfaceContext;
  onRefresh?: () => boolean | Promise<boolean>;
  onStar?: (payload: unknown) => boolean;
} = $props();

let starredCount = $state(0);
let filterText = $state('');

$effect(() => {
  const handle = mountListDataSurface({
    registry,
    descriptor,
    controller,
    context,
    refresh: onRefresh,
    onControl: (controlId, payload) => {
      if (controlId === 'star') {
        starredCount += 1;
        return onStar ? onStar(payload) : true;
      }
      return false;
    },
  });
  const unsubscribe = controller.subscribe(() => {
    filterText = String(controller.getState().filters[0]?.value ?? '');
  });
  return () => {
    unsubscribe();
    handle.destroy();
  };
});
</script>

<ul data-testid="custom-list">
  <li data-testid="filter-text">{filterText}</li>
</ul>
<p data-testid="starred-count">{starredCount}</p>
