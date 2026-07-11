<script lang="ts">
/**
 * OpportunityDetail — single-opportunity work surface (#1924).
 *
 * Shows value / probability / expected close / outcome, the owner, the
 * activity timeline (open next actions highlighted), and recorded conversion
 * links. Stage movement, activity recording, and closing are delegated to
 * callbacks; everything renders from plain view-model props.
 */
import { Form, FormGroup, Input, Select } from '@happyvertical/smrt-ui/forms';
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatDate, formatPercent } from '../format.js';
import type {
  ClosedOpportunityOutcome,
  ConversionLinkView,
  OpportunityDetailView,
  PipelineStageView,
  RecordActivityDraft,
  SalesActivityView,
} from '../types.js';
import { isOverdue, opportunityStatusBadgeVariant } from '../types.js';

export interface Props {
  /** The opportunity being worked. */
  opportunity: OpportunityDetailView;
  /** Stages of the opportunity's pipeline (for the move picker). */
  stages?: PipelineStageView[];
  /** Activity/next-action timeline rows, newest first by convention. */
  activities?: SalesActivityView[];
  /** Recorded downstream conversion links. */
  conversions?: ConversionLinkView[];
  /** Selectable activity kinds for the record-activity form. */
  activityKinds?: string[];
  /** Disable actions while a mutation is in flight. */
  busy?: boolean;
  /** BCP 47 locale for money/date formatting. */
  locale?: string;
  /** Move the opportunity to another stage. */
  onMoveStage?: (stageId: string) => void;
  /** Record a new activity / next action. */
  onRecordActivity?: (draft: RecordActivityDraft) => void;
  /** Close the opportunity with a terminal outcome. */
  onClose?: (outcome: ClosedOpportunityOutcome, reason?: string) => void;
}

let {
  opportunity,
  stages = [],
  activities = [],
  conversions = [],
  activityKinds = ['note', 'call', 'email', 'meeting', 'task'],
  busy = false,
  locale,
  onMoveStage,
  onRecordActivity,
  onClose,
}: Props = $props();

const isOpen = $derived(opportunity.status === 'open');

// Stage-move draft.
let moveTargetStageId = $state('');

// Close draft.
let closeReason = $state('');

// Record-activity draft.
let draftKind = $state('note');
let draftSummary = $state('');
let draftDueAt = $state('');

function submitMove() {
  if (moveTargetStageId) onMoveStage?.(moveTargetStageId);
}

function close(outcome: ClosedOpportunityOutcome) {
  const reason = closeReason.trim();
  onClose?.(outcome, reason === '' ? undefined : reason);
}

function submitActivity() {
  const summary = draftSummary.trim();
  if (summary === '') return;
  onRecordActivity?.({
    activityKind: draftKind,
    summary,
    dueAt: draftDueAt === '' ? null : draftDueAt,
  });
  draftSummary = '';
  draftDueAt = '';
}

function isOpenNextAction(activity: SalesActivityView): boolean {
  return (
    activity.dueAt != null && activity.dueAt !== '' && !activity.completedAt
  );
}
</script>

<article class="sales-opportunity-detail">
  <header class="head">
    <h2 class="head__name">{opportunity.name}</h2>
    <Badge variant={opportunityStatusBadgeVariant(opportunity.status)} size="sm">
      {opportunity.status}
    </Badge>
  </header>

  <dl class="facts">
    <div class="facts__item">
      <dt>Expected value</dt>
      <dd>
        {formatCents(opportunity.expectedValueCents, opportunity.currency, locale)}
      </dd>
    </div>
    <div class="facts__item">
      <dt>Probability</dt>
      <dd>{formatPercent(opportunity.probability, locale)}</dd>
    </div>
    <div class="facts__item">
      <dt>Expected close</dt>
      <dd>{formatDate(opportunity.expectedCloseAt, locale)}</dd>
    </div>
    <div class="facts__item">
      <dt>Stage</dt>
      <dd>{opportunity.stageName ?? '—'}</dd>
    </div>
    <div class="facts__item">
      <dt>Owner</dt>
      <dd>{opportunity.ownerName ?? '—'}</dd>
    </div>
  </dl>

  {#if !isOpen}
    <p class="outcome" class:outcome--won={opportunity.status === 'won'} class:outcome--lost={opportunity.status === 'lost'}>
      Closed {opportunity.status}
      {#if opportunity.status === 'won'}
        on {formatDate(opportunity.wonAt, locale)}
      {:else}
        on {formatDate(opportunity.lostAt, locale)}
      {/if}
      {#if opportunity.outcomeReason}
        — {opportunity.outcomeReason}
      {/if}
    </p>
  {/if}

  {#if isOpen && (onMoveStage || onClose)}
    <div class="controls">
      {#if onMoveStage && stages.length > 0}
        <div class="controls__group">
          <FormGroup label="Move to stage">
            <Select
              value={moveTargetStageId}
              disabled={busy}
              onchange={(event) => {
                moveTargetStageId = (event.currentTarget as HTMLSelectElement).value;
              }}
            >
              <option value="" disabled>Choose a stage…</option>
              {#each stages as stage (stage.id)}
                {#if stage.id !== opportunity.stageId}
                  <option value={stage.id}>{stage.name}</option>
                {/if}
              {/each}
            </Select>
          </FormGroup>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || moveTargetStageId === ''}
            onclick={submitMove}
          >
            Move
          </Button>
        </div>
      {/if}

      {#if onClose}
        <div class="controls__group">
          <FormGroup label="Outcome reason" hint="Recorded with the close (recommended when losing).">
            <Input
              value={closeReason}
              disabled={busy}
              oninput={(event) => {
                closeReason = (event.currentTarget as HTMLInputElement).value;
              }}
            />
          </FormGroup>
          <span class="controls__buttons">
            <Button variant="primary" size="sm" disabled={busy} onclick={() => close('won')}>
              Close won
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onclick={() => close('lost')}>
              Close lost
            </Button>
          </span>
        </div>
      {/if}
    </div>
  {/if}

  <section class="timeline" aria-label="Activity timeline">
    <h3>Activity</h3>
    {#if activities.length === 0}
      <p class="empty">No activity recorded yet.</p>
    {:else}
      <ol class="timeline__list">
        {#each activities as activity (activity.id)}
          {@const open = isOpenNextAction(activity)}
          <li class="timeline__item" class:next-action={open}>
            <span class="timeline__kind">{activity.activityKind}</span>
            <span class="timeline__summary">{activity.summary}</span>
            <span class="timeline__dates">
              {#if activity.dueAt}
                <span class:overdue={open && isOverdue(activity.dueAt)}>
                  due {formatDate(activity.dueAt, locale)}
                </span>
              {/if}
              {#if activity.completedAt}
                <span>done {formatDate(activity.completedAt, locale)}</span>
              {/if}
              {#if activity.actorName}
                <span>by {activity.actorName}</span>
              {/if}
            </span>
          </li>
        {/each}
      </ol>
    {/if}

    {#if onRecordActivity && isOpen}
      <Form class="record" onsubmit={submitActivity}>
        <FormGroup label="Kind">
          <Select
            value={draftKind}
            disabled={busy}
            onchange={(event) => {
              draftKind = (event.currentTarget as HTMLSelectElement).value;
            }}
          >
            {#each activityKinds as kind (kind)}
              <option value={kind}>{kind}</option>
            {/each}
          </Select>
        </FormGroup>
        <FormGroup label="Summary" required>
          <Input
            value={draftSummary}
            disabled={busy}
            required
            oninput={(event) => {
              draftSummary = (event.currentTarget as HTMLInputElement).value;
            }}
          />
        </FormGroup>
        <FormGroup label="Due date" hint="Leave empty for a completed note.">
          <Input
            type="date"
            value={draftDueAt}
            disabled={busy}
            oninput={(event) => {
              draftDueAt = (event.currentTarget as HTMLInputElement).value;
            }}
          />
        </FormGroup>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={busy || draftSummary.trim() === ''}
        >
          Record activity
        </Button>
      </Form>
    {/if}
  </section>

  {#if conversions.length > 0}
    <section class="conversions" aria-label="Conversions">
      <h3>Conversions</h3>
      <ul class="conversions__list">
        {#each conversions as conversion (conversion.id)}
          <li>
            <span class="conversions__kind">{conversion.targetKind}</span>
            {#if conversion.href}
              <a href={conversion.href}><code>{conversion.targetId}</code></a>
            {:else}
              <code>{conversion.targetId}</code>
            {/if}
            {#if conversion.note}
              <span class="conversions__note">{conversion.note}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</article>

<style>
  .sales-opportunity-detail {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .head__name {
    margin: 0;
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }

  .facts__item dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }

  .facts__item dd {
    margin: 0;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .outcome {
    margin: 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-radius: var(--smrt-radius-sm, 4px);
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .outcome--won {
    background: var(--smrt-color-success-container, #dcfce7);
    color: var(--smrt-color-on-success-container, #14532d);
  }

  .outcome--lost {
    background: var(--smrt-color-error-container, #fee2e2);
    color: var(--smrt-color-on-error-container, #7f1d1d);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    align-items: flex-end;
  }

  .controls__group {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .controls__buttons {
    display: inline-flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  /* The base FormGroup carries a bottom margin for stacked forms; inside these
     inline action rows it would misalign the adjacent buttons. */
  .controls__group :global(.form-group),
  .sales-opportunity-detail :global(.record .form-group) {
    margin-bottom: 0;
  }

  h3 {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  .timeline__list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .timeline__item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-sm, 4px);
  }

  .timeline__item.next-action {
    border-color: var(--smrt-color-primary, #2563eb);
    background: var(--smrt-color-primary-container, #eff6ff);
  }

  .timeline__kind {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .timeline__summary {
    flex: 1 1 12rem;
  }

  .timeline__dates {
    display: inline-flex;
    gap: var(--smrt-spacing-2, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .timeline__dates .overdue {
    color: var(--smrt-color-error, #dc2626);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .sales-opportunity-detail :global(.record) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-3, 0.75rem);
  }

  .conversions__list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .conversions__kind {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, #64748b);
    margin-right: var(--smrt-spacing-1, 0.25rem);
  }

  .conversions__note {
    color: var(--smrt-color-on-surface-variant, #64748b);
    margin-left: var(--smrt-spacing-1, 0.25rem);
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
</style>
