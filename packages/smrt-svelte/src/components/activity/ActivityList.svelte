<script lang="ts">
import WorkspaceActivityList from '../workspace/admin-shell/ActivityList.svelte';
import { tryUseAdminShell } from '../workspace/admin-shell/context.js';
import { safeActivityHref } from './safe-href.js';
import type { ActivityListEntry } from './types.js';

interface Props {
  /** Already-authorized activity rows to display. */
  entries: ActivityListEntry[];
  /** Message displayed by the shell list when no activities match. */
  emptyLabel?: string;
}
let { entries, emptyLabel = 'No activity.' }: Props = $props();
const shell = tryUseAdminShell();
const prefix = `audit-feed:${crypto.randomUUID()}:`;
$effect(() => {
  if (!shell) return;
  const ids = new Set(entries.map((entry) => `${prefix}${entry.id}`));
  for (const entry of entries)
    shell.upsertActivity({
      id: `${prefix}${entry.id}`,
      label: entry.title,
      message: entry.detail,
      detailHref: safeActivityHref(entry.href),
      kind: prefix,
      scope: 'system',
      status: 'completed',
      createdAt: entry.occurredAt,
    });
  return () => {
    for (const id of ids) shell.removeActivity(id);
  };
});
</script>
{#if shell}<WorkspaceActivityList filter={{ kind: prefix }} {emptyLabel} />{:else}<p>{emptyLabel}</p>{/if}
