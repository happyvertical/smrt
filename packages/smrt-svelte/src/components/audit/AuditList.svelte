<script lang="ts">
import { Form, FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.audit.js';
import RecordHistory from './RecordHistory.svelte';
import type { AuditHistoryEntry, AuditListFilter } from './types.js';

interface Props {
  /** Authorized data only. For server paging use onfilter to reload the authorized page. */
  entries: AuditHistoryEntry[];
  /** Shows the loading state and disables filter submission while a page is loading. */
  loading?: boolean;
  /** Displays a history-loading error above the entries. */
  error?: string | null;
  /** Requests an authorized server page for the submitted filters instead of filtering locally. */
  onfilter?: (filter: AuditListFilter) => void;
}
let { entries, loading = false, error = null, onfilter }: Props = $props();
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
  <Form onsubmit={apply} class="smrt-audit-filters">
    <FormGroup label={t(M['ui.audit.person'])}><Input bind:value={profileId} /></FormGroup>
    <FormGroup label={t(M['ui.audit.record'])}><Input bind:value={resourceId} /></FormGroup>
    <FormGroup label={t(M['ui.audit.from'])}><Input type="date" bind:value={from} max={to || undefined} /></FormGroup>
    <FormGroup label={t(M['ui.audit.to'])}><Input type="date" bind:value={to} min={from || undefined} /></FormGroup>
    <Button type="submit" disabled={loading}>{t(M['ui.audit.filter'])}</Button>
  </Form>
  <RecordHistory entries={visible} {loading} {error} />
</section>

<style>
  .smrt-audit-filters { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); align-items: end; }
</style>
