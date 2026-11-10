<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';

const { t } = useI18n();

interface EventRow {
  id: string;
  eventName: string;
  clientId: string;
  pagePath?: string;
  eventTimestamp: string;
  status: string;
}

interface Props {
  /** Array of event records to display in the table. */
  events: EventRow[];
  /** Maximum number of events to show; excess events are truncated. */
  maxRows?: number;
}

const { events, maxRows = 20 }: Props = $props();

const displayEvents = $derived(events.slice(0, maxRows));

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function statusClass(status: string): string {
  if (status === 'sent') return 'smrt-events-table__status-sent';
  if (status === 'failed') return 'smrt-events-table__status-failed';
  return 'smrt-events-table__status-pending';
}
</script>

<div class="smrt-events-table__root" data-smrt-component="EventsTable">
	{#if displayEvents.length === 0}
		<p class="smrt-events-table__empty" data-smrt-part="empty">{t(M['analytics.events_table.empty'])}</p>
	{:else}
		<table class="smrt-events-table__table" data-smrt-part="table">
			<caption class="smrt-events-table__caption" data-smrt-part="caption">{t(M['analytics.events_table.caption'])}</caption>
			<thead data-smrt-part="header">
				<tr>
					<th scope="col">Event</th>
					<th scope="col">Page</th>
					<th scope="col">Client</th>
					<th scope="col">Time</th>
					<th scope="col">Status</th>
				</tr>
			</thead>
			<tbody data-smrt-part="body">
				{#each displayEvents as event (event.id)}
					<tr data-smrt-part="row">
						<td class="smrt-events-table__event-name" data-smrt-part="cell">{event.eventName}</td>
						<td class="smrt-events-table__event-page" data-smrt-part="cell">{event.pagePath ?? '-'}</td>
						<td class="smrt-events-table__event-client" title={event.clientId} data-smrt-part="cell">{(event.clientId ?? '').slice(0, 8)}</td>
						<td class="smrt-events-table__event-time" data-smrt-part="cell">{formatTimestamp(event.eventTimestamp)}</td>
						<td><span class="smrt-events-table__status-pill {statusClass(event.status)}" data-smrt-part="badge">{event.status}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if events.length > maxRows}
			<p class="smrt-events-table__overflow" data-smrt-part="footer">{t(M['analytics.events_table.showing'], { maxRows, total: events.length })}</p>
		{/if}
	{/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-events-table__root {
    overflow-x: auto;
  }
  .smrt-events-table__table {
    width: 100%;
  }
  /* Visually hidden but available to assistive tech (table accessible name). */
  .smrt-events-table__caption {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .smrt-events-table__table th {
    padding: 0.5rem 0.75rem;
  }
  .smrt-events-table__table td {
    padding: 0.5rem 0.75rem;
  }
  .smrt-events-table__event-page {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-events-table__event-time {
    white-space: nowrap;
  }
  .smrt-events-table__status-pill {
    display: inline-block;
    padding: 0.125rem 0.5rem;
  }
  .smrt-events-table__empty {
    padding: 2rem;
  }
  .smrt-events-table__overflow {
    padding: 0.5rem;
  }
}

@layer smrt.theme {
  .smrt-events-table__table {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  /* Visually hidden but available to assistive tech (table accessible name). */
  .smrt-events-table__caption {
    border: 0;
  }
  .smrt-events-table__table th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant);
    border-bottom: 2px solid var(--smrt-color-outline-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }
  .smrt-events-table__table td {
    border-bottom: var(--smrt-hairline);
    color: var(--smrt-color-on-surface);
  }
  .smrt-events-table__table tbody tr:hover {
    background: var(--smrt-color-surface-container);
  }
  .smrt-events-table__event-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-events-table__event-page {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-events-table__event-client {
    font-family: var(--smrt-font-family-mono, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-events-table__event-time {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-events-table__status-pill {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-events-table__status-sent {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-events-table__status-failed {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-events-table__status-pending {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-events-table__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-events-table__overflow {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
}

</style>
