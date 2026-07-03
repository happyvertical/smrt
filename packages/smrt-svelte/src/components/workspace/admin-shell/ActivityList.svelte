<script lang="ts">
import ActivityItem from './ActivityItem.svelte';
import { useAdminShell } from './context.js';
import type { ShellActivityFilter } from './types.js';

interface Props {
  filter?: ShellActivityFilter;
  hideWhenEmpty?: boolean;
  emptyLabel?: string;
}

let {
  filter = {},
  hideWhenEmpty = false,
  emptyLabel = 'No activities',
}: Props = $props();
const shell = useAdminShell();
const activities = $derived(shell.listActivities(filter));
</script>

{#if activities.length > 0}
  <div class="smrt-activity-list">
    {#each activities as activity (activity.id)}
      <ActivityItem {activity} />
    {/each}
  </div>
{:else if !hideWhenEmpty}
  <p class="smrt-activity-list__empty">{emptyLabel}</p>
{/if}

<style>
  .smrt-activity-list {
    display: grid;
  }

  .smrt-activity-list__empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }
</style>
