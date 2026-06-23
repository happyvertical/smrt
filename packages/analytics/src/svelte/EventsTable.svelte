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
  events: EventRow[];
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
  if (status === 'sent') return 'status-sent';
  if (status === 'failed') return 'status-failed';
  return 'status-pending';
}
</script>

<div class="events-table-wrapper">
	{#if displayEvents.length === 0}
		<p class="events-empty">{t(M['analytics.events_table.empty'])}</p>
	{:else}
		<table class="events-table">
			<caption class="events-caption">{t(M['analytics.events_table.caption'])}</caption>
			<thead>
				<tr>
					<th scope="col">Event</th>
					<th scope="col">Page</th>
					<th scope="col">Client</th>
					<th scope="col">Time</th>
					<th scope="col">Status</th>
				</tr>
			</thead>
			<tbody>
				{#each displayEvents as event (event.id)}
					<tr>
						<td class="event-name">{event.eventName}</td>
						<td class="event-page">{event.pagePath ?? '-'}</td>
						<td class="event-client" title={event.clientId}>{(event.clientId ?? '').slice(0, 8)}</td>
						<td class="event-time">{formatTimestamp(event.eventTimestamp)}</td>
						<td><span class="status-pill {statusClass(event.status)}">{event.status}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if events.length > maxRows}
			<p class="events-overflow">{t(M['analytics.events_table.showing'], { maxRows, total: events.length })}</p>
		{/if}
	{/if}
</div>

<style>
	.events-table-wrapper {
		overflow-x: auto;
	}

	.events-table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
	}

	/* Visually hidden but available to assistive tech (table accessible name). */
	.events-caption {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.events-table th {
		text-align: left;
		padding: 0.5rem 0.75rem;
		font-weight: var(--smrt-typography-weight-semibold, 600);
		color: var(--smrt-color-on-surface-variant);
		border-bottom: 2px solid var(--smrt-color-outline-variant);
		font-size: var(--smrt-typography-label-medium-size, 0.75rem);
		text-transform: uppercase;
		letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
	}

	.events-table td {
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--smrt-color-outline-variant);
		color: var(--smrt-color-on-surface);
	}

	.events-table tbody tr:hover {
		background: var(--smrt-color-surface-container);
	}

	.event-name {
		font-weight: var(--smrt-typography-weight-medium, 500);
	}

	.event-page {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--smrt-color-on-surface-variant);
	}

	.event-client {
		font-family: var(--smrt-font-family-mono, monospace);
		font-size: var(--smrt-typography-body-small-size, 0.75rem);
		color: var(--smrt-color-on-surface-variant);
	}

	.event-time {
		white-space: nowrap;
		color: var(--smrt-color-on-surface-variant);
		font-size: var(--smrt-typography-label-medium-size, 0.75rem);
	}

	.status-pill {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border-radius: var(--smrt-radius-full, 9999px);
		font-size: var(--smrt-typography-label-small-size, 0.6875rem);
		font-weight: var(--smrt-typography-weight-medium, 500);
	}

	.status-sent {
		background: var(--smrt-color-success-container);
		color: var(--smrt-color-on-success-container);
	}

	.status-failed {
		background: var(--smrt-color-error-container);
		color: var(--smrt-color-on-error-container);
	}

	.status-pending {
		background: var(--smrt-color-warning-container);
		color: var(--smrt-color-on-warning-container);
	}

	.events-empty {
		text-align: center;
		padding: 2rem;
		color: var(--smrt-color-on-surface-variant);
	}

	.events-overflow {
		text-align: center;
		padding: 0.5rem;
		color: var(--smrt-color-on-surface-variant);
		font-size: var(--smrt-typography-body-small-size, 0.75rem);
	}
</style>
