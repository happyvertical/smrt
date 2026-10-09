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
function hasUrlControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
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
  if (
    !href ||
    href.startsWith('//') ||
    href.includes('\\') ||
    hasUrlControlCharacter(href)
  )
    return null;
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
  <ol role="list">
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
          <ul role="list">
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
  .smrt-record-history > ol {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .smrt-record-history > ol > li {
    min-inline-size: 0;
    padding-block: var(--smrt-spacing-3);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
    overflow-wrap: anywhere;
  }

  .smrt-record-history > ol > li:first-child { padding-block-start: 0; }
  .smrt-record-history > ol > li:last-child {
    padding-block-end: 0;
    border-block-end: 0;
  }

  .smrt-record-history p { margin-block: var(--smrt-spacing-1); }
  .smrt-record-history time {
    display: block;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-medium-font);
  }

  .smrt-record-history a {
    color: var(--smrt-color-on-surface);
    text-decoration-color: var(--smrt-color-primary);
    text-decoration-thickness: .08em;
    text-underline-offset: .18em;
  }

  .smrt-record-history a:hover { text-decoration-thickness: .14em; }
  .smrt-record-history a:focus-visible {
    border-radius: var(--smrt-radius-extra-small, .25rem);
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }

  .smrt-record-history ul {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin-block: var(--smrt-spacing-2) 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-inline-start: 2px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-small, .375rem);
    background: var(--smrt-color-surface-container-low);
    list-style: none;
  }
</style>
