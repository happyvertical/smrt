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

<section class="directive-review-queue">
  {#if proposals.length === 0}
    <p class="dq-empty">No directive proposals awaiting review.</p>
  {:else}
    {#each proposals as proposal (proposal.id)}
      {@const locked = busy || proposal.status !== 'pending'}
      <Card variant="outlined">
        <div class="dq-head">
          <span class="dq-title">
            {proposal.personaName ?? proposal.agentClass ?? 'Persona directive'}
          </span>
          <span class="dq-badges">
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

        <p class="dq-rationale">{proposal.rationale}</p>

        <div class="dq-diff">
          <div class="dq-col">
            <h4 class="dq-col-title">Current</h4>
            <pre class="dq-pre">{proposal.currentInstructions || '(none)'}</pre>
          </div>
          <div class="dq-col">
            <h4 class="dq-col-title">Proposed</h4>
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

        <div class="dq-actions">
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
  .directive-review-queue {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .dq-empty {
    color: var(--color-text-muted, #6b7280);
    font-style: italic;
  }

  .dq-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .dq-title {
    font-weight: 600;
  }

  .dq-badges {
    display: inline-flex;
    gap: 0.375rem;
  }

  .dq-rationale {
    margin: 0 0 0.75rem;
  }

  .dq-diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  @media (max-width: 640px) {
    .dq-diff {
      grid-template-columns: 1fr;
    }
  }

  .dq-col-title {
    margin: 0 0 0.25rem;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted, #6b7280);
  }

  .dq-pre {
    margin: 0;
    padding: 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--color-surface-muted, #f3f4f6);
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }

  .dq-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
</style>
