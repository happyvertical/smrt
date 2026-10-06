<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.audit.js';
import type { AuditHistoryEntry } from './types.js';

interface Props {
  /** Authorized entries. This component never fetches or authorizes records. */
  entries: AuditHistoryEntry[];
  /** Optional resource identity for a per-record page. Both must be supplied together. */
  resourceType?: string;
  /** Limits entries to this record identifier when supplied with resourceType. */
  resourceId?: string;
  /** Announces that history is loading and suppresses the empty-state message. */
  loading?: boolean;
  /** Displays a history-loading error as an alert. */
  error?: string | null;
  /** Overrides the translated accessible label for the history section. */
  label?: string;
}
let {
  entries,
  resourceType,
  resourceId,
  loading = false,
  error = null,
  label,
}: Props = $props();
const { locale, t } = useI18n();
const visible = $derived(
  entries
    .filter(
      (entry) =>
        (!resourceType || entry.resourceType === resourceType) &&
        (!resourceId || entry.resourceId === resourceId),
    )
    .toSorted((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
);
function display(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString(locale)
    : value;
}
</script>

<section aria-label={label ?? t(M['ui.audit.history'])} aria-busy={loading} class="smrt-record-history">
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading}<p role="status">{t(M['ui.audit.loading'])}</p>{/if}
  {#if !loading && visible.length === 0}<p>{t(M['ui.audit.empty'])}</p>{/if}
  <ol>
    {#each visible as entry (entry.id)}
      <li>
        <p><strong>{entry.actorLabel ?? entry.profileId}</strong> · {entry.action} · {entry.resourceType} / {entry.resourceId}</p>
        <time datetime={entry.occurredAt}>{date(entry.occurredAt)}</time>
        {#if entry.onBehalfOfId}<p>{t(M['ui.audit.behalf'], { actor: entry.onBehalfOfId })}</p>{/if}
        {#if entry.reason}<p>{t(M['ui.audit.reason'], { reason: entry.reason })}</p>{/if}
        {#if entry.changes && Object.keys(entry.changes).length}
          <ul>
            {#each Object.entries(entry.changes) as [field, change] (field)}
              <li>{t(M['ui.audit.change'], { field, before: display(change.before), after: display(change.after) })}</li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .smrt-record-history ol { display: grid; gap: var(--smrt-spacing-4); padding-inline-start: var(--smrt-spacing-6); }
  .smrt-record-history p { margin-block: var(--smrt-spacing-1); overflow-wrap: anywhere; }
  .smrt-record-history time { color: var(--smrt-color-on-surface-variant); }
</style>
