<script lang="ts">
/**
 * LeadList — CRM lead worklist (#1924).
 *
 * Presentational table of leads with owner assignment (rep picker), a qualify
 * action, status badges, and the open next action per lead. Merged leads show
 * a merged-into indicator instead of actions. All data arrives via props and
 * all actions are delegated to callbacks.
 */
import { Select } from '@happyvertical/smrt-ui/forms';
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { formatDate } from '../format.js';
import type {
  LeadInboxFilter,
  LeadInboxSort,
  LeadListItemView,
  SalesRepOptionView,
} from '../types.js';
import { canQualifyLead, isOverdue, leadStatusBadgeVariant } from '../types.js';

export interface Props {
  /** Leads to display. */
  leads?: LeadListItemView[];
  /** Assignable sales representatives for the owner picker. */
  reps?: SalesRepOptionView[];
  /** Disable actions while a mutation is in flight. */
  busy?: boolean;
  /** BCP 47 locale for date formatting. */
  locale?: string;
  /** Assign (or reassign) a lead to a representative. */
  onAssign?: (leadId: string, repId: string) => void;
  /** Qualify a lead into an opportunity. */
  onQualify?: (leadId: string) => void;
  /** Controlled inbox filter. */
  statusFilter?: LeadInboxFilter;
  /** Counts supplied by the host for the inbox tabs. */
  statusCounts?: Partial<Record<LeadInboxFilter, number>>;
  /** Change the controlled inbox filter. */
  onStatusFilterChange?: (filter: LeadInboxFilter) => void;
  /** Controlled order for the host query. */
  sort?: LeadInboxSort;
  /** Change inbox order. */
  onSortChange?: (sort: LeadInboxSort) => void;
  /** Current one-based page. */
  page?: number;
  /** Number of rows per page. */
  pageSize?: number;
  /** Total matching rows, for page controls. */
  total?: number;
  /** Change to a one-based page. */
  onPageChange?: (page: number) => void;
  /** Highlight this selected lead. */
  selectedLeadId?: string;
  /** Open a selected lead. */
  onSelect?: (leadId: string) => void;
  /** Optional navigation target for each lead row. */
  hrefForLead?: (leadId: string) => string;
  /** Start working on a new lead. */
  onStartWorking?: (leadId: string) => void;
  /** Disqualify a lead; host supplies the reason workflow. */
  onDisqualify?: (leadId: string) => void;
}

let {
  leads = [],
  reps = [],
  busy = false,
  locale,
  onAssign,
  onQualify,
  statusFilter = 'all',
  statusCounts = {},
  onStatusFilterChange,
  sort = 'created',
  onSortChange,
  page = 1,
  pageSize = 25,
  total = leads.length,
  onPageChange,
  selectedLeadId,
  onSelect,
  hrefForLead,
  onStartWorking,
  onDisqualify,
}: Props = $props();

const filters: { value: LeadInboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'working', label: 'Working' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'disqualified', label: 'Disqualified' },
  { value: 'merged', label: 'Merged' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'overdue', label: 'Overdue' },
];

const pageCount = $derived(
  Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
);

function handleAssign(leadId: string, event: Event) {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (value) onAssign?.(leadId, value);
}
</script>

<div class="smrt-lead-list__root" data-smrt-component="LeadList">
  <nav class="smrt-lead-list__toolbar" data-smrt-part="actions" aria-label="Lead inbox filters">
    <div class="smrt-lead-list__filters" data-smrt-part="filters" role="group" aria-label="Filter leads">
      {#each filters as filter (filter.value)}
        <Button
          variant="ghost"
          size="sm"
          class={statusFilter === filter.value ? 'filter-tab active' : 'filter-tab'}
          aria-pressed={statusFilter === filter.value}
          onclick={() => onStatusFilterChange?.(filter.value)}
        >
          {filter.label}<span class="smrt-lead-list__count" data-smrt-part="count">{statusCounts[filter.value] ?? 0}</span>
        </Button>
      {/each}
    </div>
    <label class="smrt-lead-list__sort" data-smrt-part="field">Sort
      <Select value={sort} disabled={!onSortChange} onchange={(event) => onSortChange?.((event.currentTarget as HTMLSelectElement).value as LeadInboxSort)}>
        <option value="created">Recently received</option>
        <option value="next_action">Next action due</option>
        <option value="name">Name</option>
      </Select>
    </label>
  </nav>
  {#if leads.length === 0}
    <p class="smrt-lead-list__empty" data-smrt-part="empty">No leads yet.</p>
  {:else}
    <table>
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">Lead</th>
          <th scope="col">Contact</th>
          <th scope="col">Source</th>
          <th scope="col">Owner</th>
          <th scope="col">Status</th>
          <th scope="col">Next action</th>
          <th scope="col"><span class="smrt-lead-list__visually-hidden" data-smrt-part="label">Actions</span></th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each leads as lead (lead.id)}
          {@const merged = lead.status === 'merged'}
          <tr class:smrt-lead-list__merged={merged} class:smrt-lead-list__selected={selectedLeadId === lead.id} data-smrt-part="row">
            <td>
              {#if hrefForLead}
                <a class="smrt-lead-list__name" href={hrefForLead(lead.id)} onclick={() => onSelect?.(lead.id)} aria-current={selectedLeadId === lead.id ? 'page' : undefined} data-smrt-part="action">{lead.name}</a>
              {:else if onSelect}
                <Button
                  class="lead-name select-lead"
                  variant="ghost"
                  size="sm"
                  aria-pressed={selectedLeadId === lead.id}
                  onclick={() => onSelect?.(lead.id)}
                >
                  {lead.name}
                </Button>
              {:else}
                <span class="smrt-lead-list__name" data-smrt-part="title">{lead.name}</span>
              {/if}
              {#if lead.organizationName}
                <span class="smrt-lead-list__secondary" data-smrt-part="meta">{lead.organizationName}</span>
              {/if}
              {#if lead.receivedLabel || lead.createdAt}
                <span class="smrt-lead-list__secondary" data-smrt-part="meta">{lead.receivedLabel ?? `Received ${formatDate(lead.createdAt, locale)}`}</span>
              {/if}
              {#if merged && lead.mergedIntoId}
                <span class="smrt-lead-list__merged-note" data-smrt-part="meta">
                  merged into <code>{lead.mergedIntoId.slice(0, 8)}</code>
                </span>
              {/if}
            </td>
            <td>
              {#if lead.contactName}
                <span class="smrt-lead-list__secondary" data-smrt-part="meta">{lead.contactName}</span>
              {/if}
              {#if lead.email}
                <span class="smrt-lead-list__secondary" data-smrt-part="meta">{lead.email}</span>
              {/if}
              {#if lead.phone}
                <span class="smrt-lead-list__secondary" data-smrt-part="meta">{lead.phone}</span>
              {/if}
            </td>
            <td>{lead.sourceLabel ?? '—'}</td>
            <td>
              {#if onAssign && !merged}
                <Select
                  value={lead.ownerRepId ?? ''}
                  disabled={busy}
                  aria-label={`Assign owner for ${lead.name}`}
                  onchange={(event) => handleAssign(lead.id, event)}
                >
                  <option value="" disabled>Unassigned</option>
                  {#each reps as rep (rep.id)}
                    <option value={rep.id}>{rep.name}</option>
                  {/each}
                </Select>
              {:else}
                {lead.ownerName ?? '—'}
              {/if}
            </td>
            <td>
              <Badge variant={leadStatusBadgeVariant(lead.status)} size="sm">
                {lead.status}
              </Badge>
            </td>
            <td>
              {#if lead.nextAction}
                <span class="smrt-lead-list__next-action" class:smrt-lead-list__overdue={isOverdue(lead.nextAction.dueAt)} data-smrt-part="description">
                  {lead.nextAction.summary}
                </span>
                {#if lead.nextAction.dueAt}
                  <span class="smrt-lead-list__secondary" data-smrt-part="meta">
                    due {formatDate(lead.nextAction.dueAt, locale)}
                  </span>
                {/if}
              {:else}
                —
              {/if}
            </td>
            <td class="smrt-lead-list__actions" data-smrt-part="actions">
              {#if onQualify && canQualifyLead(lead.status)}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onclick={() => onQualify?.(lead.id)}
                >
                  Qualify
                </Button>
              {/if}
              {#if onStartWorking && lead.status === 'new'}
                <Button variant="secondary" size="sm" disabled={busy} onclick={() => onStartWorking?.(lead.id)}>Start</Button>
              {/if}
              {#if onDisqualify && (lead.status === 'new' || lead.status === 'working')}
                <Button variant="danger" size="sm" disabled={busy} onclick={() => onDisqualify?.(lead.id)}>Disqualify</Button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if total > pageSize || page > 1}
    <div class="smrt-lead-list__pagination" data-smrt-part="footer" aria-label="Lead list pagination">
      <Button variant="secondary" size="sm" disabled={busy || page <= 1} onclick={() => onPageChange?.(page - 1)}>Previous</Button>
      <span>Page {page} of {pageCount} · {total} leads</span>
      <Button variant="secondary" size="sm" disabled={busy || page >= pageCount} onclick={() => onPageChange?.(page + 1)}>Next</Button>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-lead-list__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-lead-list__empty {
    margin: 0;
  }
  .smrt-lead-list__toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    margin-bottom: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-lead-list__filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-lead-list__filters :global(.filter-tab) {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    cursor: pointer;
  }
  .smrt-lead-list__count {
    margin-left: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-lead-list__sort {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-lead-list__pagination {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding-top: var(--smrt-spacing-3, 0.75rem);
  }
  table {
    width: 100%;
  }
  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    white-space: nowrap;
  }
  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-lead-list__name {
    display: block;
  }
  :global(.select-lead) {
    padding: 0;
    cursor: pointer;
  }
  .smrt-lead-list__secondary {
    display: block;
  }
  .smrt-lead-list__merged-note {
    display: block;
  }
  .smrt-lead-list__next-action {
    display: block;
  }
  .smrt-lead-list__actions {
    white-space: nowrap;
  }
  .smrt-lead-list__visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-lead-list__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-lead-list__filters :global(.filter-tab) {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-sm, 0.25rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-lead-list__filters :global(.filter-tab.active) {
    background: var(--smrt-color-primary-container);
    border-color: var(--smrt-color-primary);
  }
  .smrt-lead-list__count {
    color: var(--smrt-color-on-surface-variant);
  }
  table {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container);
    border-bottom: var(--smrt-hairline);
  }
  td {
    border-bottom: var(--smrt-hairline);
    vertical-align: top;
  }
  tr.smrt-lead-list__merged td {
    opacity: 0.65;
  }
  .smrt-lead-list__name {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  a.smrt-lead-list__name {
    color: inherit;
    text-decoration: none;
  }
  a.smrt-lead-list__name:hover, :global(.select-lead:hover) {
    text-decoration: underline;
  }
  :global(.select-lead) {
    border: 0;
    background: none;
    text-align: left;
    color: inherit;
  }
  tr.smrt-lead-list__selected td {
    background: var(--smrt-color-primary-container);
  }
  .smrt-lead-list__secondary {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-lead-list__merged-note {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-lead-list__merged-note code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-lead-list__next-action.smrt-lead-list__overdue {
    color: var(--smrt-color-error);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-lead-list__actions {
    text-align: right;
  }
}

</style>
