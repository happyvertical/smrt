<script lang="ts">
import { Form, FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.audit.js';
import RecordHistory from './RecordHistory.svelte';
import type {
  AuditEntryLabel,
  AuditFieldLabel,
  AuditHistoryEntry,
  AuditListFilter,
  AuditResourceHref,
  AuditValueFormatter,
} from './types.js';

interface Props {
  /** Authorized data only. For server paging use onfilter to reload the authorized page. */
  entries: AuditHistoryEntry[];
  /** Shows the loading state and disables filter submission while a page is loading. */
  loading?: boolean;
  /** Displays a history-loading error above the entries. */
  error?: string | null;
  /** Requests an authorized server page for the submitted filters instead of filtering locally. */
  onfilter?: (filter: AuditListFilter) => void;
  /** Shows the built-in person, record and date filters. */
  showFilters?: boolean;
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
  loading = false,
  error = null,
  onfilter,
  showFilters = true,
  resourceLabel,
  resourceHref,
  actionLabel,
  fieldLabel,
  formatValue,
}: Props = $props();
const { t } = useI18n();
let profileId = $state('');
let resourceId = $state('');
let from = $state('');
let to = $state('');
let filter = $state<AuditListFilter>({
  profileId: '',
  resourceId: '',
  from: '',
  to: '',
});
const visible = $derived(
  onfilter
    ? entries
    : entries.filter(
        (entry) =>
          (!filter.profileId || entry.profileId === filter.profileId) &&
          (!filter.resourceId || entry.resourceId === filter.resourceId) &&
          (!filter.from || entry.occurredAt.slice(0, 10) >= filter.from) &&
          (!filter.to || entry.occurredAt.slice(0, 10) <= filter.to),
      ),
);
function apply() {
  filter = {
    profileId: profileId.trim(),
    resourceId: resourceId.trim(),
    from,
    to,
  };
  onfilter?.({ ...filter });
}
</script>

<section aria-label={t(M['ui.audit.list'])}>
  {#if showFilters}
    <Form onsubmit={apply} class="smrt-audit-filters">
      <FormGroup label={t(M['ui.audit.person'])}><Input bind:value={profileId} /></FormGroup>
      <FormGroup label={t(M['ui.audit.record'])}><Input bind:value={resourceId} /></FormGroup>
      <FormGroup label={t(M['ui.audit.from'])}><Input type="date" bind:value={from} max={to || undefined} /></FormGroup>
      <FormGroup label={t(M['ui.audit.to'])}><Input type="date" bind:value={to} min={from || undefined} /></FormGroup>
      <Button type="submit" disabled={loading}>{t(M['ui.audit.filter'])}</Button>
    </Form>
  {/if}
  <RecordHistory
    entries={visible}
    {loading}
    {error}
    {resourceLabel}
    {resourceHref}
    {actionLabel}
    {fieldLabel}
    {formatValue}
  />
</section>

<style>
  .smrt-audit-filters { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); align-items: end; }
</style>
