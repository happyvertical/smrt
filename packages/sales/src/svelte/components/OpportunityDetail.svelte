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

<article class="smrt-opportunity-detail__root" data-smrt-component="OpportunityDetail">
  <header class="smrt-opportunity-detail__header" data-smrt-part="header">
    <h2 class="smrt-opportunity-detail__title" data-smrt-part="title">{opportunity.name}</h2>
    <Badge variant={opportunityStatusBadgeVariant(opportunity.status)} size="sm">
      {opportunity.status}
    </Badge>
  </header>

  <dl class="smrt-opportunity-detail__facts" data-smrt-part="meta">
    <div class="smrt-opportunity-detail__fact" data-smrt-part="field">
      <dt>Expected value</dt>
      <dd>
        {formatCents(opportunity.expectedValueCents, opportunity.currency, locale)}
      </dd>
    </div>
    <div class="smrt-opportunity-detail__fact" data-smrt-part="field">
      <dt>Probability</dt>
      <dd>{formatPercent(opportunity.probability, locale)}</dd>
    </div>
    <div class="smrt-opportunity-detail__fact" data-smrt-part="field">
      <dt>Expected close</dt>
      <dd>{formatDate(opportunity.expectedCloseAt, locale)}</dd>
    </div>
    <div class="smrt-opportunity-detail__fact" data-smrt-part="field">
      <dt>Stage</dt>
      <dd>{opportunity.stageName ?? '—'}</dd>
    </div>
    <div class="smrt-opportunity-detail__fact" data-smrt-part="field">
      <dt>Owner</dt>
      <dd>{opportunity.ownerName ?? '—'}</dd>
    </div>
  </dl>

  {#if !isOpen}
    <p class="smrt-opportunity-detail__outcome" class:smrt-opportunity-detail__won={opportunity.status === 'won'} class:smrt-opportunity-detail__lost={opportunity.status === 'lost'} data-smrt-part="description">
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
    <div class="smrt-opportunity-detail__controls" data-smrt-part="actions">
      {#if onMoveStage && stages.length > 0}
        <div class="smrt-opportunity-detail__group" data-smrt-part="group">
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
        <div class="smrt-opportunity-detail__group" data-smrt-part="group">
          <FormGroup label="Outcome reason" hint="Recorded with the close (recommended when losing).">
            <Input
              value={closeReason}
              disabled={busy}
              oninput={(event) => {
                closeReason = (event.currentTarget as HTMLInputElement).value;
              }}
            />
          </FormGroup>
          <span class="smrt-opportunity-detail__buttons" data-smrt-part="actions">
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

  <section class="smrt-opportunity-detail__timeline" data-smrt-part="list" aria-label="Activity timeline">
    <h3>Activity</h3>
    {#if activities.length === 0}
      <p class="smrt-opportunity-detail__empty" data-smrt-part="empty">No activity recorded yet.</p>
    {:else}
      <ol class="smrt-opportunity-detail__timeline-list" data-smrt-part="list">
        {#each activities as activity (activity.id)}
          {@const open = isOpenNextAction(activity)}
          <li class="smrt-opportunity-detail__item" class:smrt-opportunity-detail__next-action={open} data-smrt-part="item">
            <span class="smrt-opportunity-detail__kind" data-smrt-part="meta">{activity.activityKind}</span>
            <span class="smrt-opportunity-detail__summary" data-smrt-part="summary">{activity.summary}</span>
            <span class="smrt-opportunity-detail__dates" data-smrt-part="group">
              {#if activity.dueAt}
                <span class:smrt-opportunity-detail__overdue={open && isOverdue(activity.dueAt)} data-smrt-part="meta">
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
    <section class="smrt-opportunity-detail__conversions" data-smrt-part="group" aria-label="Conversions">
      <h3>Conversions</h3>
      <ul class="smrt-opportunity-detail__conversions-list" data-smrt-part="list">
        {#each conversions as conversion (conversion.id)}
          <li>
            <span class="smrt-opportunity-detail__conversion-kind" data-smrt-part="meta">{conversion.targetKind}</span>
            {#if conversion.href}
              <a href={conversion.href}><code>{conversion.targetId}</code></a>
            {:else}
              <code>{conversion.targetId}</code>
            {/if}
            {#if conversion.note}
              <span class="smrt-opportunity-detail__note" data-smrt-part="description">{conversion.note}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-opportunity-detail__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }
  .smrt-opportunity-detail__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-detail__title {
    margin: 0;
  }
  .smrt-opportunity-detail__facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }
  .smrt-opportunity-detail__fact dd {
    margin: 0;
  }
  .smrt-opportunity-detail__outcome {
    margin: 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-opportunity-detail__controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    align-items: flex-end;
  }
  .smrt-opportunity-detail__group {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-detail__buttons {
    display: inline-flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  /* The base FormGroup carries a bottom margin for stacked forms; inside these
  inline action rows it would misalign the adjacent buttons. */
  .smrt-opportunity-detail__group :global([data-smrt-component="FormGroup"]),
  .smrt-opportunity-detail__root :global(.record [data-smrt-component="FormGroup"]) {
    margin-bottom: 0;
  }
  h3 {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-detail__empty {
    margin: 0;
  }
  .smrt-opportunity-detail__timeline-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-detail__item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-detail__summary {
    flex: 1 1 12rem;
  }
  .smrt-opportunity-detail__dates {
    display: inline-flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-detail__root :global(.record) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-opportunity-detail__conversions-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-opportunity-detail__conversion-kind {
    margin-right: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-opportunity-detail__note {
    margin-left: var(--smrt-spacing-1, 0.25rem);
  }
}

@layer smrt.theme {
  .smrt-opportunity-detail__title {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }
  .smrt-opportunity-detail__fact dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-opportunity-detail__fact dd {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-opportunity-detail__outcome {
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-surface-container);
  }
  .smrt-opportunity-detail__won {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-opportunity-detail__lost {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  h3 {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-opportunity-detail__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-opportunity-detail__item {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-opportunity-detail__item.smrt-opportunity-detail__next-action {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  .smrt-opportunity-detail__kind {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-opportunity-detail__dates {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-opportunity-detail__dates .smrt-opportunity-detail__overdue {
    color: var(--smrt-color-error);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-opportunity-detail__conversion-kind {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-opportunity-detail__note {
    color: var(--smrt-color-on-surface-variant);
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
}

</style>
