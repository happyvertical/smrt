<script lang="ts">
/**
 * DirectiveReviewQueue — the minimal human-in-the-loop surface for the persona
 * learning loop (#1889).
 *
 * Renders pending {@link DirectiveProposalView}s with their rationale and a
 * current-vs-proposed diff, and lets a reviewer approve (optionally editing the
 * proposed text) or reject. It is purely presentational — approval/rejection are
 * delegated to the `onApprove` / `onReject` callbacks, which a host wires to the
 * permission-gated `DirectiveApprovalService`.
 */
import { Textarea } from '@happyvertical/smrt-ui/forms';
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import type { DirectiveProposalView } from '../types.js';
import { confidencePercent, statusBadgeVariant } from '../types.js';

export interface Props {
  /** Proposals to review (typically the pending queue). */
  proposals?: DirectiveProposalView[];
  /** Disable actions while a review is in flight. */
  busy?: boolean;
  /** Approve a proposal, optionally with reviewer-edited instructions. */
  onApprove?: (id: string, editedInstructions?: string) => void;
  /** Reject a proposal. */
  onReject?: (id: string) => void;
}

const { proposals = [], busy = false, onApprove, onReject }: Props = $props();

// Reviewer edits, keyed by proposal id.
let edits = $state<Record<string, string>>({});

function draftFor(proposal: DirectiveProposalView): string {
  return edits[proposal.id] ?? proposal.proposedInstructions;
}

function onEdit(id: string, value: string): void {
  edits = { ...edits, [id]: value };
}

function approve(proposal: DirectiveProposalView): void {
  const edited = edits[proposal.id];
  const changed =
    edited !== undefined && edited !== proposal.proposedInstructions;
  onApprove?.(proposal.id, changed ? edited : undefined);
}
</script>

<section class="smrt-directive-review-queue__root" data-smrt-component="DirectiveReviewQueue">
  {#if proposals.length === 0}
    <p class="smrt-directive-review-queue__empty" data-smrt-part="empty">No directive proposals awaiting review.</p>
  {:else}
    {#each proposals as proposal (proposal.id)}
      {@const locked = busy || proposal.status !== 'pending'}
      <Card variant="outlined">
        <div class="smrt-directive-review-queue__header" data-smrt-part="header">
          <span class="smrt-directive-review-queue__title" data-smrt-part="title">
            {proposal.personaName ?? proposal.agentClass ?? 'Persona directive'}
          </span>
          <span class="smrt-directive-review-queue__badges" data-smrt-part="badges">
            {#if proposal.confidence != null}
              <Badge variant="info" size="sm">
                {confidencePercent(proposal.confidence)} confidence
              </Badge>
            {/if}
            <Badge variant={statusBadgeVariant(proposal.status)} size="sm">
              {proposal.status}
            </Badge>
          </span>
        </div>

        <p class="smrt-directive-review-queue__rationale" data-smrt-part="meta">{proposal.rationale}</p>

        <div class="smrt-directive-review-queue__diff" data-smrt-part="diff">
          <div class="smrt-directive-review-queue__column" data-smrt-part="column">
            <h4 class="smrt-directive-review-queue__column-title" data-smrt-part="label">Current</h4>
            <pre class="smrt-directive-review-queue__pre" data-smrt-part="body">{proposal.currentInstructions || '(none)'}</pre>
          </div>
          <div class="smrt-directive-review-queue__column" data-smrt-part="column">
            <h4 class="smrt-directive-review-queue__column-title" data-smrt-part="label">Proposed</h4>
            <Textarea
              value={draftFor(proposal)}
              rows={5}
              disabled={locked}
              oninput={(event) =>
                onEdit(
                  proposal.id,
                  (event.currentTarget as HTMLTextAreaElement).value,
                )}
            />
          </div>
        </div>

        <div class="smrt-directive-review-queue__actions" data-smrt-part="actions">
          <Button
            variant="primary"
            size="sm"
            disabled={locked}
            onclick={() => approve(proposal)}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={locked}
            onclick={() => onReject?.(proposal.id)}
          >
            Reject
          </Button>
        </div>
      </Card>
    {/each}
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-directive-review-queue__root {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-directive-review-queue__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .smrt-directive-review-queue__badges {
    display: inline-flex;
    gap: 0.375rem;
  }
  .smrt-directive-review-queue__rationale {
    margin: 0 0 0.75rem;
  }
  .smrt-directive-review-queue__diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 640px) {
    .smrt-directive-review-queue__diff {
      grid-template-columns: 1fr;
    }
  }
  .smrt-directive-review-queue__column-title {
    margin: 0 0 0.25rem;
  }
  .smrt-directive-review-queue__pre {
    margin: 0;
    padding: 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .smrt-directive-review-queue__actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
}

@layer smrt.theme {
  .smrt-directive-review-queue__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-directive-review-queue__title {
    font-weight: 600;
  }
  .smrt-directive-review-queue__column-title {
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-directive-review-queue__pre {
    background: var(--smrt-color-surface-variant);
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }
}

</style>
