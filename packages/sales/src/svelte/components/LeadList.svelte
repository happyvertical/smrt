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
import type { LeadListItemView, SalesRepOptionView } from '../types.js';
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
}

let {
  leads = [],
  reps = [],
  busy = false,
  locale,
  onAssign,
  onQualify,
}: Props = $props();

function handleAssign(leadId: string, event: Event) {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (value) onAssign?.(leadId, value);
}
</script>

<div class="sales-lead-list">
  {#if leads.length === 0}
    <p class="sales-lead-list__empty">No leads yet.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th scope="col">Lead</th>
          <th scope="col">Contact</th>
          <th scope="col">Source</th>
          <th scope="col">Owner</th>
          <th scope="col">Status</th>
          <th scope="col">Next action</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each leads as lead (lead.id)}
          {@const merged = lead.status === 'merged'}
          <tr class:merged>
            <td>
              <span class="lead-name">{lead.name}</span>
              {#if lead.organizationName}
                <span class="secondary">{lead.organizationName}</span>
              {/if}
              {#if merged && lead.mergedIntoId}
                <span class="merged-note">
                  merged into <code>{lead.mergedIntoId.slice(0, 8)}</code>
                </span>
              {/if}
            </td>
            <td>
              {#if lead.contactName}
                <span class="secondary">{lead.contactName}</span>
              {/if}
              {#if lead.email}
                <span class="secondary">{lead.email}</span>
              {/if}
              {#if lead.phone}
                <span class="secondary">{lead.phone}</span>
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
                <span class="next-action" class:overdue={isOverdue(lead.nextAction.dueAt)}>
                  {lead.nextAction.summary}
                </span>
                {#if lead.nextAction.dueAt}
                  <span class="secondary">
                    due {formatDate(lead.nextAction.dueAt, locale)}
                  </span>
                {/if}
              {:else}
                —
              {/if}
            </td>
            <td class="actions">
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
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .sales-lead-list {
    width: 100%;
    overflow-x: auto;
  }

  .sales-lead-list__empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    white-space: nowrap;
  }

  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    vertical-align: top;
  }

  tr.merged td {
    opacity: 0.65;
  }

  .lead-name {
    display: block;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .secondary {
    display: block;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .merged-note {
    display: block;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .merged-note code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .next-action {
    display: block;
  }

  .next-action.overdue {
    color: var(--smrt-color-error, #dc2626);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .actions {
    white-space: nowrap;
    text-align: right;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
