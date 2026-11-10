<script lang="ts">
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentContributionData } from '../../mock-smrt-client';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

export interface Props {
  /** List of contributions pending review. */
  contributions?: ContentContributionData[];
  /** ID of the contribution currently selected for review. */
  selectedId?: string | null;
  /** Message shown when the contributions list is empty. */
  emptyMessage?: string;
  /** URL for workflow form submission to handle approve/reject server-side. */
  workflowFormAction?: string;
  /** Fired when the user selects a contribution from the list. */
  onSelect?: (contribution: ContentContributionData) => void;
  /** Fired when the user approves a contribution and optionally promotes it. */
  onApprove?: (
    contribution: ContentContributionData,
    options: { targetStatus: 'draft' | 'review'; note: string },
  ) => void;
  /** Fired when the user requests changes to a contribution. */
  onRequestChanges?: (
    contribution: ContentContributionData,
    options: { note: string },
  ) => void;
  /** Fired when the user rejects a contribution. */
  onReject?: (
    contribution: ContentContributionData,
    options: { note: string },
  ) => void;
}

let {
  contributions = [],
  selectedId = null,
  emptyMessage = 'No contributions need review right now.',
  workflowFormAction = undefined,
  onSelect = undefined,
  onApprove = undefined,
  onRequestChanges = undefined,
  onReject = undefined,
}: Props = $props();

let note = $state('');
let targetStatus = $state<'draft' | 'review'>('draft');
const workflowIntents = ['approve', 'request-changes', 'reject'] as const;
type WorkflowIntent = (typeof workflowIntents)[number];

const selectedContribution = $derived(
  contributions.find((item) => item.id === selectedId) ||
    contributions[0] ||
    null,
);
const canSubmitWorkflow = $derived(
  !workflowFormAction || Boolean(selectedContribution?.id),
);

function workflowStatus(
  contribution: ContentContributionData | null | undefined,
) {
  return contribution?.status || 'submitted';
}

function approveActionLabel(contribution: ContentContributionData) {
  return workflowStatus(contribution) === 'approved'
    ? 'Promote'
    : 'Approve and promote';
}

function isWorkflowIntent(
  intent: string | undefined,
): intent is WorkflowIntent {
  return workflowIntents.includes(intent as WorkflowIntent);
}

function handleWorkflowSubmit(event: SubmitEvent) {
  const submitter = event.submitter as HTMLButtonElement | null;
  const intent = submitter?.value;
  const hasNativeWorkflowTarget =
    Boolean(workflowFormAction) &&
    Boolean(selectedContribution?.id) &&
    isWorkflowIntent(intent);
  const shouldHandleWithCallback =
    Boolean(selectedContribution) &&
    ((intent === 'approve' && Boolean(onApprove)) ||
      (intent === 'request-changes' && Boolean(onRequestChanges)) ||
      (intent === 'reject' && Boolean(onReject)));

  if (!hasNativeWorkflowTarget || shouldHandleWithCallback) {
    event.preventDefault();
  }

  if (intent === 'approve' && onApprove && selectedContribution) {
    onApprove(selectedContribution, {
      targetStatus,
      note,
    });
    return;
  }

  if (
    intent === 'request-changes' &&
    onRequestChanges &&
    selectedContribution
  ) {
    onRequestChanges(selectedContribution, {
      note,
    });
    return;
  }

  if (intent === 'reject' && onReject && selectedContribution) {
    onReject(selectedContribution, {
      note,
    });
  }
}

$effect(() => {
  note = selectedContribution?.editorNotes || '';
  targetStatus = 'draft';
});
</script>

<section class="smrt-content-contribution-inbox__root" data-smrt-component="ContentContributionInbox">
  <header class="smrt-content-contribution-inbox__header" data-smrt-part="header">
    <div>
      <h3>{t(M['content.contribution_inbox.heading'])}</h3>
      <p>{t(M['content.contribution_inbox.intro'])}</p>
    </div>
    <span class="smrt-content-contribution-inbox__pill" data-smrt-part="badge">{contributions.length}</span>
  </header>

  {#if contributions.length === 0}
    <p class="smrt-content-contribution-inbox__empty" data-smrt-part="empty">{emptyMessage}</p>
  {:else}
    <div class="smrt-content-contribution-inbox__layout" data-smrt-part="body">
      <div class="smrt-content-contribution-inbox__list" data-smrt-part="list">
        {#each contributions as contribution (contribution.id)}
          <!-- raw-primitive-allow: large pressable selection card wrapping a title and metadata with a selected state -->
          <button
            type="button"
            class:smrt-content-contribution-inbox__selected={selectedContribution?.id === contribution.id}
            data-smrt-part="item"
            onclick={() => onSelect?.(contribution)}
          >
            <strong>{contribution.title || contribution.contributionTypeKey || 'Untitled submission'}</strong>
            <span>{contribution.contributorName || contribution.contributorEmail || 'Unknown contributor'}</span>
            <span class="smrt-content-contribution-inbox__pill" data-smrt-part="badge">{workflowStatus(contribution)}</span>
          </button>
        {/each}
      </div>

      {#if selectedContribution}
        <article class="smrt-content-contribution-inbox__detail" data-smrt-part="panel">
          <header>
            <div>
              <h4>{selectedContribution.title || 'Untitled submission'}</h4>
              <p>{selectedContribution.contributorName || selectedContribution.contributorEmail || 'Unknown contributor'}</p>
            </div>
            <span class="smrt-content-contribution-inbox__pill" data-smrt-part="badge">{workflowStatus(selectedContribution)}</span>
          </header>

          {#if selectedContribution.body}
            <div class="smrt-content-contribution-inbox__preview" data-smrt-part="preview">
              {selectedContribution.body}
            </div>
          {/if}

          <dl>
            <div>
              <dt>Type</dt>
              <dd>{selectedContribution.contributionTypeKey || 'n/a'}</dd>
            </div>
            <div>
              <dt>Revisions</dt>
              <dd>{selectedContribution.revisionCount || 0}</dd>
            </div>
            <div>
              <dt>{t(M['content.contribution_inbox.promoted_content'])}</dt>
              <dd>{selectedContribution.promotedContentId || 'Not promoted yet'}</dd>
            </div>
            {#if selectedContribution.intakeDecision}
              <div>
                <dt>{t(M['content.contribution_inbox.intake_decision'])}</dt>
                <dd>{selectedContribution.intakeDecision}</dd>
              </div>
            {/if}
          </dl>

          <Form
            method="post"
            action={workflowFormAction}
            preventDefault={false}
            onsubmit={handleWorkflowSubmit}
          >
            {#if selectedContribution.id}
              <Input type="hidden" name="contributionId" value={selectedContribution.id} />
            {/if}

            <label>
              {t(M['content.contribution_inbox.editorial_note'])}
              <Textarea name="editorNote" bind:value={note} rows={4}></Textarea>
            </label>

            <div class="smrt-content-contribution-inbox__actions" data-smrt-part="actions">
              {#if onApprove || workflowFormAction}
                <label class="smrt-content-contribution-inbox__inline" data-smrt-part="field">
                  {t(M['content.contribution_inbox.promote_to'])}
                  <Select name="targetStatus" bind:value={targetStatus}>
                    <option value="draft">draft</option>
                    <option value="review">review</option>
                  </Select>
                </label>
                <Button
                  variant="primary"
                  type="submit"
                  name="intent"
                  value="approve"
                  disabled={!canSubmitWorkflow}
                >
                  {approveActionLabel(selectedContribution)}
                </Button>
              {/if}

              {#if onRequestChanges || workflowFormAction}
                <Button
                  variant="secondary"
                  type="submit"
                  name="intent"
                  value="request-changes"
                  disabled={!canSubmitWorkflow}
                >
                  {t(M['content.contribution_inbox.request_changes'])}
                </Button>
              {/if}

              {#if onReject || workflowFormAction}
                <Button
                  variant="danger"
                  type="submit"
                  name="intent"
                  value="reject"
                  disabled={!canSubmitWorkflow}
                >
                  Reject
                </Button>
              {/if}
            </div>
          </Form>
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-contribution-inbox__root,
  .smrt-content-contribution-inbox__header,
  .smrt-content-contribution-inbox__layout,
  .smrt-content-contribution-inbox__detail,
  .smrt-content-contribution-inbox__detail :global(.form) {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-contribution-inbox__layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }
  .smrt-content-contribution-inbox__list {
    display: grid;
    gap: 0.5rem;
  }
  .smrt-content-contribution-inbox__list button,
  .smrt-content-contribution-inbox__detail {
    padding: 0.85rem;
  }
  .smrt-content-contribution-inbox__list button {
    display: grid;
    gap: 0.35rem;
  }
  .smrt-content-contribution-inbox__preview {
    padding: 0.85rem;
    white-space: pre-wrap;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .smrt-content-contribution-inbox__actions,
  .smrt-content-contribution-inbox__inline {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .smrt-content-contribution-inbox__pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
    padding: 0.15rem 0.5rem;
  }
  @media (max-width: 720px) {
    .smrt-content-contribution-inbox__layout {
      grid-template-columns: 1fr;
    }
  }
}

@layer smrt.theme {
  .smrt-content-contribution-inbox__list button,
  .smrt-content-contribution-inbox__detail {
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
    background: var(--smrt-color-surface);
  }
  .smrt-content-contribution-inbox__list button {
    text-align: left;
  }
  .smrt-content-contribution-inbox__list button.smrt-content-contribution-inbox__selected {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 1px var(--smrt-color-primary);
  }
  .smrt-content-contribution-inbox__preview {
    border-radius: 0.75rem;
    background: var(--smrt-color-surface-container);
  }
  .smrt-content-contribution-inbox__pill {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
  }
}

</style>
