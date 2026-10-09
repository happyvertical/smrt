<script lang="ts">
import type { ActivityListEntry } from './types.js';

interface Props {
  /** Already-authorized activity rows to display. */
  entries: ActivityListEntry[];
  /** Accessible name for the activity region. */
  label?: string;
  /** Message displayed when there are no entries. */
  emptyLabel?: string;
}
let {
  entries,
  label = 'Activity',
  emptyLabel = 'No activity.',
}: Props = $props();
</script>
<section aria-label={label} class="smrt-activity-list">
  {#if entries.length === 0}<p>{emptyLabel}</p>{:else}<ol>{#each entries as entry (entry.id)}<li>
    {#if entry.href}<a href={entry.href}>{entry.title}</a>{:else}<strong>{entry.title}</strong>{/if}
    {#if entry.detail}<p>{entry.detail}</p>{/if}<time datetime={entry.occurredAt}>{entry.occurredAt}</time>
  </li>{/each}</ol>{/if}
</section>
<style>ol { display:grid; padding:0; list-style:none; } li { padding-block:var(--smrt-spacing-3); border-block-end:1px solid var(--smrt-color-outline-variant); } p,time { color:var(--smrt-color-on-surface-variant); overflow-wrap:anywhere; }</style>
