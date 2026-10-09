<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.audit.js';
import type {
  AuditEntryLabel,
  AuditFieldLabel,
  AuditHistoryEntry,
  AuditResourceHref,
  AuditValueFormatter,
} from './types.js';

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
  /** Resolves friendly resource text for each authorized entry. */
  resourceLabel?: AuditEntryLabel;
  /** Resolves an already-authorized local or HTTP(S) destination for each entry. */
  resourceHref?: AuditResourceHref;
  /** Resolves friendly action text for each authorized entry. */
  actionLabel?: AuditEntryLabel;
  /** Resolves friendly field text for each authorized entry change. */
  fieldLabel?: AuditFieldLabel;
  /** Formats before/after values as escaped text. */
  formatValue?: AuditValueFormatter;
}
let {
  entries,
  resourceType,
  resourceId,
  loading = false,
  error = null,
  label,
  resourceLabel,
  resourceHref,
  actionLabel,
  fieldLabel,
  formatValue,
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
function defaultDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}
function entryLabel(
  resolver: AuditEntryLabel | undefined,
  entry: AuditHistoryEntry,
  fallback: string,
): string {
  if (!resolver) return fallback;
  try {
    const resolved = resolver(entry);
    return typeof resolved === 'string' && resolved.trim()
      ? resolved
      : fallback;
  } catch {
    return fallback;
  }
}
function changedFieldLabel(field: string, entry: AuditHistoryEntry): string {
  if (!fieldLabel) return field;
  try {
    const resolved = fieldLabel(field, entry);
    return typeof resolved === 'string' && resolved.trim() ? resolved : field;
  } catch {
    return field;
  }
}
function display(
  value: unknown,
  entry: AuditHistoryEntry,
  field: string,
  side: 'before' | 'after',
): string {
  if (formatValue) {
    try {
      const resolved = formatValue(value, { entry, field, side });
      if (typeof resolved === 'string') return resolved;
    } catch {
      // Presentation callbacks cannot make an authorized history list fail.
    }
  }
  return defaultDisplay(value);
}
function safeResourceHref(entry: AuditHistoryEntry): string | null {
  if (!resourceHref) return null;
  let resolved: unknown;
  try {
    resolved = resourceHref(entry);
  } catch {
    return null;
  }
  if (typeof resolved !== 'string') return null;
  const href = resolved.trim();
  if (!href || href.startsWith('//') || href.includes('\\')) return null;
  try {
    const url = new URL(href, 'https://smrt.invalid');
    return url.protocol === 'http:' || url.protocol === 'https:' ? href : null;
  } catch {
    return null;
  }
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
      {@const resolvedResourceLabel = entryLabel(resourceLabel, entry, `${entry.resourceType} / ${entry.resourceId}`)}
      {@const resolvedResourceHref = safeResourceHref(entry)}
      <li>
        <p>
          <strong>{entry.actorLabel ?? entry.profileId}</strong>
          · {entryLabel(actionLabel, entry, entry.action)} ·
          {#if resolvedResourceHref}<a href={resolvedResourceHref}>{resolvedResourceLabel}</a>{:else}{resolvedResourceLabel}{/if}
        </p>
        <time datetime={entry.occurredAt}>{date(entry.occurredAt)}</time>
        {#if entry.onBehalfOfId}<p>{t(M['ui.audit.behalf'], { actor: entry.onBehalfOfId })}</p>{/if}
        {#if entry.reason}<p>{t(M['ui.audit.reason'], { reason: entry.reason })}</p>{/if}
        {#if entry.changes && Object.keys(entry.changes).length}
          <ul>
            {#each Object.entries(entry.changes) as [field, change] (field)}
              <li>{t(M['ui.audit.change'], {
                field: changedFieldLabel(field, entry),
                before: display(change.before, entry, field, 'before'),
                after: display(change.after, entry, field, 'after'),
              })}</li>
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
