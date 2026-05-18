<script lang="ts">
import type { ContentContributionData } from '../../mock-smrt-client';

export interface Props {
  contributions?: ContentContributionData[];
  selectedId?: string | null;
  emptyMessage?: string;
  onSelect?: (contribution: ContentContributionData) => void;
  onApprove?: (
    contribution: ContentContributionData,
    options: { targetStatus: 'draft' | 'review'; note: string },
  ) => void;
  onRequestChanges?: (
    contribution: ContentContributionData,
    options: { note: string },
  ) => void;
  onReject?: (
    contribution: ContentContributionData,
    options: { note: string },
  ) => void;
}

let {
  contributions = [],
  selectedId = null,
  emptyMessage = 'No contributions need review right now.',
  onSelect = undefined,
  onApprove = undefined,
  onRequestChanges = undefined,
  onReject = undefined,
}: Props = $props();

let note = $state('');
let targetStatus = $state<'draft' | 'review'>('draft');

const selectedContribution = $derived(
  contributions.find((item) => item.id === selectedId) ||
    contributions[0] ||
    null,
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

$effect(() => {
  note = selectedContribution?.editorNotes || '';
  targetStatus = 'draft';
});
</script>

<section class="inbox">
  <header class="inbox__header">
    <div>
      <h3>Contribution inbox</h3>
      <p>Review held submissions, request changes, or promote them into editorial content.</p>
    </div>
    <span class="pill">{contributions.length}</span>
  </header>

  {#if contributions.length === 0}
    <p class="empty-copy">{emptyMessage}</p>
  {:else}
    <div class="inbox__layout">
      <div class="inbox__list">
        {#each contributions as contribution (contribution.id)}
          <button
            type="button"
            class:selected={selectedContribution?.id === contribution.id}
            onclick={() => onSelect?.(contribution)}
          >
            <strong>{contribution.title || contribution.contributionTypeKey || 'Untitled submission'}</strong>
            <span>{contribution.contributorName || contribution.contributorEmail || 'Unknown contributor'}</span>
            <span class="pill">{workflowStatus(contribution)}</span>
          </button>
        {/each}
      </div>

      {#if selectedContribution}
        <article class="inbox__detail">
          <header>
            <div>
              <h4>{selectedContribution.title || 'Untitled submission'}</h4>
              <p>{selectedContribution.contributorName || selectedContribution.contributorEmail || 'Unknown contributor'}</p>
            </div>
            <span class="pill">{workflowStatus(selectedContribution)}</span>
          </header>

          {#if selectedContribution.body}
            <div class="body-preview">
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
              <dt>Promoted content</dt>
              <dd>{selectedContribution.promotedContentId || 'Not promoted yet'}</dd>
            </div>
            {#if selectedContribution.intakeDecision}
              <div>
                <dt>Intake decision</dt>
                <dd>{selectedContribution.intakeDecision}</dd>
              </div>
            {/if}
          </dl>

          <label>
            Editorial note
            <textarea bind:value={note} rows="4"></textarea>
          </label>

          <div class="actions">
            {#if onApprove}
              <label class="inline">
                Promote to
                <select bind:value={targetStatus}>
                  <option value="draft">draft</option>
                  <option value="review">review</option>
                </select>
              </label>
              <button
                type="button"
                onclick={() =>
                  onApprove?.(selectedContribution, {
                    targetStatus,
                    note,
                  })}
              >
                {approveActionLabel(selectedContribution)}
              </button>
            {/if}

            {#if onRequestChanges}
              <button
                type="button"
                class="secondary"
                onclick={() =>
                  onRequestChanges?.(selectedContribution, {
                    note,
                  })}
              >
                Request changes
              </button>
            {/if}

            {#if onReject}
              <button
                type="button"
                class="danger"
                onclick={() =>
                  onReject?.(selectedContribution, {
                    note,
                  })}
              >
                Reject
              </button>
            {/if}
          </div>
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
  .inbox,
  .inbox__header,
  .inbox__layout,
  .inbox__detail {
    display: grid;
    gap: 1rem;
  }

  .inbox__layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }

  .inbox__list {
    display: grid;
    gap: 0.5rem;
  }

  .inbox__list button,
  .inbox__detail {
    border: 1px solid #d9d9d9;
    border-radius: 0.75rem;
    padding: 0.85rem;
    background: #fff;
  }

  .inbox__list button {
    display: grid;
    gap: 0.35rem;
    text-align: left;
  }

  .inbox__list button.selected {
    border-color: #0b5fff;
    box-shadow: 0 0 0 1px #0b5fff;
  }

  .body-preview {
    padding: 0.85rem;
    border-radius: 0.75rem;
    background: #f7f7f7;
    white-space: pre-wrap;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .actions,
  .inline {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: #eef3ff;
  }

  @media (max-width: 720px) {
    .inbox__layout {
      grid-template-columns: 1fr;
    }
  }
</style>
