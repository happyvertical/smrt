<script lang="ts">
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
		<p class="events-empty">No recent events.</p>
	{:else}
		<table class="events-table">
			<thead>
				<tr>
					<th>Event</th>
					<th>Page</th>
					<th>Client</th>
					<th>Time</th>
					<th>Status</th>
				</tr>
			</thead>
			<tbody>
				{#each displayEvents as event (event.id)}
					<tr>
						<td class="event-name">{event.eventName}</td>
						<td class="event-page">{event.pagePath ?? '-'}</td>
						<td class="event-client" title={event.clientId}>{event.clientId.slice(0, 8)}</td>
						<td class="event-time">{formatTimestamp(event.eventTimestamp)}</td>
						<td><span class="status-pill {statusClass(event.status)}">{event.status}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if events.length > maxRows}
			<p class="events-overflow">Showing {maxRows} of {events.length} events</p>
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
		font-size: 0.8125rem;
	}

	.events-table th {
		text-align: left;
		padding: 0.5rem 0.75rem;
		font-weight: 600;
		color: var(--color-text-secondary, #6b7280);
		border-bottom: 2px solid var(--color-border, #e5e7eb);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.events-table td {
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--color-border-light, #f3f4f6);
		color: var(--color-text-primary, #111827);
	}

	.events-table tbody tr:hover {
		background: var(--color-hover, #f9fafb);
	}

	.event-name {
		font-weight: 500;
	}

	.event-page {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-text-secondary, #6b7280);
	}

	.event-client {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		color: var(--color-text-secondary, #6b7280);
	}

	.event-time {
		white-space: nowrap;
		color: var(--color-text-secondary, #6b7280);
		font-size: 0.75rem;
	}

	.status-pill {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 500;
	}

	.status-sent {
		background: var(--color-success-bg, #dcfce7);
		color: var(--color-success-text, #166534);
	}

	.status-failed {
		background: var(--color-error-bg, #fee2e2);
		color: var(--color-error-text, #991b1b);
	}

	.status-pending {
		background: var(--color-warning-bg, #fef9c3);
		color: var(--color-warning-text, #854d0e);
	}

	.events-empty {
		text-align: center;
		padding: 2rem;
		color: var(--color-text-secondary, #6b7280);
	}

	.events-overflow {
		text-align: center;
		padding: 0.5rem;
		color: var(--color-text-tertiary, #9ca3af);
		font-size: 0.75rem;
	}
</style>
