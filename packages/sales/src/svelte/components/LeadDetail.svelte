<script lang="ts">
/**
 * LeadDetail — callback-driven Lead follow-up and timeline surface.
 *
 * This component is deliberately presentational: host applications supply
 * plain view models and connect callbacks to `LeadWorkflowService` (or their
 * own authorization boundary). It performs no data fetching and imports no
 * CRM model classes.
 */
import {
  Form,
  FormGroup,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { formatDate } from '../format.js';
import type {
  LeadDetailView,
  LeadHumanActivityDraft,
  LeadNextActionDraft,
  SalesActivityView,
  SalesRepOptionView,
} from '../types.js';
import {
  isOverdue,
  leadStatusBadgeVariant,
  leadWorkflowActionsFor,
} from '../types.js';

export interface Props {
  /** Lead header and contact data. */
  lead: LeadDetailView;
  /** Complete chronological, merge-aware trail supplied by the host. */
  activities?: SalesActivityView[];
  /** Assignable sales representatives. */
  reps?: SalesRepOptionView[];
  /** Disable every mutation affordance while the host is busy. */
  busy?: boolean;
  /** BCP 47 locale for timeline dates. */
  locale?: string;
  /** Assign or reassign the Lead owner. */
  onAssign?: (leadId: string, repId: string) => void;
  /** Start a new Lead or reopen a disqualified Lead. */
  onStartWorking?: (leadId: string) => void;
  /** Disqualify with a required reason. */
  onDisqualify?: (leadId: string, reason: string) => void;
  /** Record a human note, call, email, or meeting. */
  onRecordActivity?: (leadId: string, draft: LeadHumanActivityDraft) => void;
  /** Schedule a dated next action. */
  onScheduleNextAction?: (leadId: string, draft: LeadNextActionDraft) => void;
  /** Complete one currently open next-action task. */
  onCompleteNextAction?: (leadId: string, taskId: string) => void;
  /** Delegate qualification to the host's existing LeadCollection lifecycle. */
  onQualify?: (leadId: string) => void;
}

let {
  lead,
  activities = [],
  reps = [],
  busy = false,
  locale,
  onAssign,
  onStartWorking,
  onDisqualify,
  onRecordActivity,
  onScheduleNextAction,
  onCompleteNextAction,
  onQualify,
}: Props = $props();

const actions = $derived(leadWorkflowActionsFor(lead.status));
const humanActivityKinds = ['note', 'call', 'email', 'meeting'] as const;

let selectedRepId = $state('');
let disqualificationReason = $state('');
let humanActivityKind = $state<(typeof humanActivityKinds)[number]>('note');
let humanActivitySummary = $state('');
let nextActionSummary = $state('');
let nextActionDueAt = $state('');

function submitAssignment() {
  if (selectedRepId) onAssign?.(lead.id, selectedRepId);
}

function submitDisqualification() {
  const reason = disqualificationReason.trim();
  if (!reason) return;
  onDisqualify?.(lead.id, reason);
  disqualificationReason = '';
}

function submitHumanActivity() {
  const summary = humanActivitySummary.trim();
  if (!summary) return;
  onRecordActivity?.(lead.id, { activityKind: humanActivityKind, summary });
  humanActivitySummary = '';
}

function submitNextAction() {
  const summary = nextActionSummary.trim();
  if (!summary || !nextActionDueAt) return;
  onScheduleNextAction?.(lead.id, { summary, dueAt: nextActionDueAt });
  nextActionSummary = '';
  nextActionDueAt = '';
}

function isOpenTask(activity: SalesActivityView): boolean {
  return (
    activity.activityKind === 'task' &&
    activity.dueAt != null &&
    activity.dueAt !== '' &&
    !activity.completedAt
  );
}
</script>

<article class="sales-lead-detail">
  <header class="head">
    <div>
      <h2 class="head__name">{lead.name}</h2>
      {#if lead.organizationName}
        <p class="head__organization">{lead.organizationName}</p>
      {/if}
    </div>
    <Badge variant={leadStatusBadgeVariant(lead.status)} size="sm">
      {lead.status}
    </Badge>
  </header>

  <dl class="facts">
    <div class="facts__item">
      <dt>Contact</dt>
      <dd>{lead.contactName ?? '—'}</dd>
    </div>
    <div class="facts__item">
      <dt>Email</dt>
      <dd>{lead.email ?? '—'}</dd>
    </div>
    <div class="facts__item">
      <dt>Phone</dt>
      <dd>{lead.phone ?? '—'}</dd>
    </div>
    <div class="facts__item">
      <dt>Owner</dt>
      <dd>{lead.ownerName ?? 'Unassigned'}</dd>
    </div>
  </dl>

  {#if lead.status === 'merged' && lead.mergedIntoId}
    <p class="merged-note">This lead was merged into <code>{lead.mergedIntoId}</code>.</p>
  {/if}

  {#if actions.canAssign || actions.canStartWorking || actions.canDisqualify || actions.canQualify}
    <section class="controls" aria-label="Lead workflow actions">
      {#if actions.canAssign && onAssign && reps.length > 0}
        <Form class="control-form" onsubmit={submitAssignment}>
          <FormGroup label="Owner">
            <Select
              value={selectedRepId || lead.ownerRepId || ''}
              disabled={busy}
              aria-label={`Assign owner for ${lead.name}`}
              onchange={(event) => {
                selectedRepId = (event.currentTarget as HTMLSelectElement).value;
              }}
            >
              <option value="" disabled>Choose an owner…</option>
              {#each reps as rep (rep.id)}
                <option value={rep.id}>{rep.name}</option>
              {/each}
            </Select>
          </FormGroup>
          <Button type="submit" variant="secondary" size="sm" disabled={busy || !selectedRepId}>
            Assign
          </Button>
        </Form>
      {/if}

      {#if actions.canStartWorking && onStartWorking}
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onclick={() => onStartWorking?.(lead.id)}
        >
          {lead.status === 'disqualified' ? 'Reopen follow-up' : 'Start working'}
        </Button>
      {/if}

      {#if actions.canQualify && onQualify}
        <Button variant="secondary" size="sm" disabled={busy} onclick={() => onQualify?.(lead.id)}>
          Qualify
        </Button>
      {/if}

      {#if actions.canDisqualify && onDisqualify}
        <Form class="control-form control-form--disqualify" onsubmit={submitDisqualification}>
          <FormGroup label="Disqualification reason" required>
            <Textarea
              value={disqualificationReason}
              disabled={busy}
              required
              rows={2}
              oninput={(event) => {
                disqualificationReason = (event.currentTarget as HTMLTextAreaElement).value;
              }}
            />
          </FormGroup>
          <Button
            type="submit"
            variant="danger"
            size="sm"
            disabled={busy || disqualificationReason.trim() === ''}
          >
            Disqualify
          </Button>
        </Form>
      {/if}
    </section>
  {/if}

  <section class="timeline" aria-label="Lead activity timeline">
    <h3>Activity timeline</h3>
    {#if activities.length === 0}
      <p class="empty">No activity recorded yet.</p>
    {:else}
      <ol class="timeline__list">
        {#each activities as activity (activity.id)}
          {@const openTask = isOpenTask(activity)}
          <li class="timeline__item" class:next-action={openTask}>
            <div class="timeline__content">
              <span class="timeline__kind">{activity.activityKind}</span>
              <span class="timeline__summary">{activity.summary}</span>
            </div>
            <div class="timeline__meta">
              {#if activity.createdAt}
                <span>recorded {formatDate(activity.createdAt, locale)}</span>
              {/if}
              {#if activity.dueAt}
                <span class:overdue={openTask && isOverdue(activity.dueAt)}>
                  due {formatDate(activity.dueAt, locale)}
                </span>
              {/if}
              {#if activity.completedAt}
                <span>completed {formatDate(activity.completedAt, locale)}</span>
              {/if}
              {#if activity.actorName}
                <span>by {activity.actorName}</span>
              {/if}
            </div>
            {#if openTask && actions.canCompleteNextAction && onCompleteNextAction}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onclick={() => onCompleteNextAction?.(lead.id, activity.id)}
              >
                Complete task
              </Button>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  {#if actions.canRecordActivity && onRecordActivity}
    <section class="composer" aria-label="Record follow-up activity">
      <h3>Record follow-up</h3>
      <Form class="composer__form" onsubmit={submitHumanActivity}>
        <FormGroup label="Kind">
          <Select
            value={humanActivityKind}
            disabled={busy}
            onchange={(event) => {
              humanActivityKind = (event.currentTarget as HTMLSelectElement)
                .value as (typeof humanActivityKinds)[number];
            }}
          >
            {#each humanActivityKinds as kind (kind)}
              <option value={kind}>{kind}</option>
            {/each}
          </Select>
        </FormGroup>
        <FormGroup label="Summary" required>
          <Textarea
            value={humanActivitySummary}
            disabled={busy}
            required
            rows={2}
            oninput={(event) => {
              humanActivitySummary = (event.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </FormGroup>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={busy || humanActivitySummary.trim() === ''}
        >
          Record activity
        </Button>
      </Form>
    </section>
  {/if}

  {#if actions.canScheduleNextAction && onScheduleNextAction}
    <section class="composer" aria-label="Schedule next action">
      <h3>Schedule next action</h3>
      <Form class="composer__form" onsubmit={submitNextAction}>
        <FormGroup label="Summary" required>
          <Input
            value={nextActionSummary}
            disabled={busy}
            required
            oninput={(event) => {
              nextActionSummary = (event.currentTarget as HTMLInputElement).value;
            }}
          />
        </FormGroup>
        <FormGroup label="Due date" required>
          <Input
            type="date"
            value={nextActionDueAt}
            disabled={busy}
            required
            oninput={(event) => {
              nextActionDueAt = (event.currentTarget as HTMLInputElement).value;
            }}
          />
        </FormGroup>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={busy || nextActionSummary.trim() === '' || nextActionDueAt === ''}
        >
          Schedule task
        </Button>
      </Form>
    </section>
  {/if}
</article>

<style>
  .sales-lead-detail {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .head__name,
  h3 {
    margin: 0;
  }

  .head__name {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }

  .head__organization,
  .empty,
  .merged-note {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--smrt-spacing-3, 0.75rem);
    margin: 0;
  }

  .facts__item dt,
  .timeline__kind {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }

  .facts__item dd {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
    overflow-wrap: anywhere;
  }

  .controls,
  .sales-lead-detail :global(.composer__form) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-3, 0.75rem);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .sales-lead-detail :global(.control-form) {
    display: flex;
    flex: 1 1 16rem;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .sales-lead-detail :global(.control-form--disqualify) {
    flex-basis: min(100%, 24rem);
  }

  .sales-lead-detail :global(.form-group) {
    flex: 1 1 10rem;
    margin-bottom: 0;
  }

  h3 {
    margin-bottom: var(--smrt-spacing-2, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .timeline__list {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .timeline__item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-sm, 4px);
  }

  .timeline__item.next-action {
    border-color: var(--smrt-color-primary, #2563eb);
    background: var(--smrt-color-primary-container, #eff6ff);
  }

  .timeline__content {
    display: grid;
    flex: 1 1 14rem;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .timeline__kind {
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .timeline__summary {
    overflow-wrap: anywhere;
  }

  .timeline__meta {
    display: flex;
    flex: 1 1 12rem;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .timeline__meta .overdue {
    color: var(--smrt-color-error, #dc2626);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  @media (max-width: 40rem) {
    .sales-lead-detail :global(.control-form),
    .sales-lead-detail :global(.composer__form) {
      align-items: stretch;
      flex-direction: column;
    }

    .sales-lead-detail :global(.form-group),
    .sales-lead-detail :global(.control-form),
    .sales-lead-detail :global(.control-form--disqualify) {
      width: 100%;
    }
  }
</style>
