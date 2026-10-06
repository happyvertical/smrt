<script lang="ts">
import type { TimeEntryApprovalView } from '../../../types.js';
import TimeEntryApprovalQueue from '../../TimeEntryApprovalQueue.svelte';
import TimeEntryCard from '../../TimeEntryCard.svelte';
import TimeEntryList from '../../TimeEntryList.svelte';
import TimeSummary from '../../TimeSummary.svelte';
import type { TimeEntry } from '../../utils.js';

const entry: TimeEntry = {
  id: 'entry-1',
  date: '2026-10-05',
  hours: 1.0005,
  description: 'Exact work',
  status: 'submitted',
};
const approval: TimeEntryApprovalView = {
  ...entry,
  date: '2026-10-05',
  source: 'manual',
  participantKind: 'human',
};
const exact = () => '1.0005h';
</script>

<TimeEntryCard {entry} hoursFormatter={exact}>
  {#snippet details(row)}
    <span>Package walls · revision 4 · {row.id}</span>
  {/snippet}
</TimeEntryCard>
<TimeEntryList entries={[entry]} hoursFormatter={exact}>
  {#snippet details(row)}
    <span>List evidence · superseded · {row.id}</span>
  {/snippet}
</TimeEntryList>
<TimeSummary totalHours={entry.hours} totalAmount={0} hoursFormatter={exact} />
<TimeEntryApprovalQueue entries={[approval]} hoursFormatter={exact}>
  {#snippet details(row)}
    <span>Queue evidence · {row.source}</span>
  {/snippet}
  {#snippet actions(row)}
    <form method="POST">
      <input type="hidden" name="requestId" value="request-original" />
      <input type="hidden" name="expectedTenantId" value="tenant-1" />
      <input type="hidden" name="entryId" value={row.id} />
      <button name="decision" value="approved">Approve retained evidence</button>
      <button name="decision" value="correction">Request correction</button>
    </form>
  {/snippet}
</TimeEntryApprovalQueue>
