<script lang="ts">
/**
 * AttributionConflictQueue — operator review queue for attribution
 * exceptions (#1931).
 *
 * Open exceptions show the competing candidate touches and an award editor:
 * per-referrer credit fractions that must sum to 100% (validated inline, the
 * same rule `AttributionService.resolveException` enforces) plus a REQUIRED
 * resolution reason — the resolve button stays disabled until both hold.
 * Resolved exceptions render their read-only audit trail.
 */
import { FormGroup, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import { formatDate, formatPercent } from '../format.js';
import type { AttributionAward, AttributionExceptionView } from '../types.js';
import {
  equalSplitAwards,
  uniqueCandidateReferrerIds,
  validateAwards,
} from '../types.js';

export interface Props {
  /** Exceptions to review (open and/or resolved). */
  exceptions?: AttributionExceptionView[];
  /** Disable actions while a resolution is in flight. */
  busy?: boolean;
  /** BCP 47 locale for date/percent formatting. */
  locale?: string;
  /** Resolve an open exception with explicit awards and a required reason. */
  onResolve?: (
    exceptionId: string,
    awards: AttributionAward[],
    resolutionReason: string,
  ) => void;
}

let { exceptions = [], busy = false, locale, onResolve }: Props = $props();

// Operator edits, keyed by exception id → referrer id → raw input string.
let fractionDrafts = $state<Record<string, Record<string, string>>>({});
// Resolution reasons, keyed by exception id.
let reasonDrafts = $state<Record<string, string>>({});

function referrerLabel(
  exception: AttributionExceptionView,
  referrerId: string,
): string {
  const candidate = exception.candidates.find(
    (c) => c.referrerId === referrerId,
  );
  return candidate?.referrerName ?? referrerId.slice(0, 8);
}

/** Current award draft: equal-split defaults overlaid with operator edits. */
function draftAwards(exception: AttributionExceptionView): AttributionAward[] {
  const referrerIds = uniqueCandidateReferrerIds(exception.candidates);
  const defaults = equalSplitAwards(referrerIds);
  const overrides = fractionDrafts[exception.id] ?? {};
  return defaults.map((award) => {
    const raw = overrides[award.referrerId];
    if (raw === undefined) return award;
    return { referrerId: award.referrerId, creditFraction: Number(raw) };
  });
}

function fractionInputValue(
  exception: AttributionExceptionView,
  referrerId: string,
): string {
  const raw = fractionDrafts[exception.id]?.[referrerId];
  if (raw !== undefined) return raw;
  const referrerIds = uniqueCandidateReferrerIds(exception.candidates);
  const seeded = equalSplitAwards(referrerIds).find(
    (award) => award.referrerId === referrerId,
  );
  return seeded ? String(seeded.creditFraction) : '';
}

function setFraction(exceptionId: string, referrerId: string, value: string) {
  fractionDrafts = {
    ...fractionDrafts,
    [exceptionId]: {
      ...(fractionDrafts[exceptionId] ?? {}),
      [referrerId]: value,
    },
  };
}

function setReason(exceptionId: string, value: string) {
  reasonDrafts = { ...reasonDrafts, [exceptionId]: value };
}

function resolve(exception: AttributionExceptionView) {
  const awards = draftAwards(exception);
  const reason = (reasonDrafts[exception.id] ?? '').trim();
  if (!validateAwards(awards).valid || reason === '') return;
  onResolve?.(exception.id, awards, reason);
}
</script>

<section class="sales-attribution-queue">
  {#if exceptions.length === 0}
    <p class="empty">No attribution exceptions to review.</p>
  {:else}
    {#each exceptions as exception (exception.id)}
      {@const open = exception.status === 'open'}
      {@const awards = draftAwards(exception)}
      {@const validation = validateAwards(awards)}
      {@const reason = (reasonDrafts[exception.id] ?? '').trim()}
      <Card variant="outlined">
        <div class="head">
          <span class="head__target">
            <span class="head__kind">{exception.targetKind}</span>
            {exception.targetLabel ?? exception.targetId}
          </span>
          <span class="head__badges">
            {#if exception.programName}
              <Badge variant="default" size="sm">{exception.programName}</Badge>
            {/if}
            <Badge variant={open ? 'warning' : 'success'} size="sm">
              {exception.status}
            </Badge>
          </span>
        </div>

        <p class="conflict-reason">{exception.conflictReason}</p>

        <table class="candidates">
          <caption class="visually-hidden">Competing candidate touches</caption>
          <thead>
            <tr>
              <th scope="col">Referrer</th>
              <th scope="col">Touch kind</th>
              <th scope="col">Occurred</th>
            </tr>
          </thead>
          <tbody>
            {#each exception.candidates as candidate (candidate.touchId + candidate.referrerId)}
              <tr>
                <td>{candidate.referrerName ?? candidate.referrerId.slice(0, 8)}</td>
                <td>{candidate.kind.replace(/_/g, ' ')}</td>
                <td>{formatDate(candidate.occurredAt, locale)}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if open && onResolve}
          <div class="award-editor">
            <h4>Award credit</h4>
            {#each awards as award (award.referrerId)}
              <div class="award-editor__row">
                <span class="award-editor__name">
                  {referrerLabel(exception, award.referrerId)}
                </span>
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.0001"
                  value={fractionInputValue(exception, award.referrerId)}
                  disabled={busy}
                  aria-label={`Credit fraction for ${referrerLabel(exception, award.referrerId)}`}
                  oninput={(event) =>
                    setFraction(
                      exception.id,
                      award.referrerId,
                      (event.currentTarget as HTMLInputElement).value,
                    )}
                />
              </div>
            {/each}
            <p
              class="award-editor__total"
              class:invalid={!validation.valid}
              role="status"
            >
              Total: {formatPercent(validation.totalFraction, locale)}
              {#if !validation.valid && validation.message}
                — {validation.message}
              {/if}
            </p>

            <FormGroup
              label="Resolution reason"
              required
              hint="Overrides are audited — say why this award is correct."
            >
              <Textarea
                rows={2}
                value={reasonDrafts[exception.id] ?? ''}
                disabled={busy}
                oninput={(event) =>
                  setReason(
                    exception.id,
                    (event.currentTarget as HTMLTextAreaElement).value,
                  )}
              />
            </FormGroup>

            <Button
              variant="primary"
              size="sm"
              disabled={busy || !validation.valid || reason === ''}
              onclick={() => resolve(exception)}
            >
              Resolve
            </Button>
          </div>
        {:else if !open}
          <dl class="audit">
            <div class="audit__item">
              <dt>Mode</dt>
              <dd>{exception.resolutionMode ?? '—'}</dd>
            </div>
            <div class="audit__item">
              <dt>Reason</dt>
              <dd>{exception.resolutionReason ?? '—'}</dd>
            </div>
            <div class="audit__item">
              <dt>Resolved by</dt>
              <dd>{exception.resolvedByName ?? '—'}</dd>
            </div>
            <div class="audit__item">
              <dt>Resolved at</dt>
              <dd>{formatDate(exception.resolvedAt, locale)}</dd>
            </div>
          </dl>
        {/if}
      </Card>
    {/each}
  {/if}
</section>

<style>
  .sales-attribution-queue {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-bottom: var(--smrt-spacing-2, 0.5rem);
  }

  .head__target {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .head__kind {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
    margin-right: var(--smrt-spacing-1, 0.25rem);
  }

  .head__badges {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .conflict-reason {
    margin: 0 0 var(--smrt-spacing-3, 0.75rem);
  }

  .candidates {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    margin-bottom: var(--smrt-spacing-3, 0.75rem);
  }

  .candidates th {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    white-space: nowrap;
  }

  .candidates td {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
  }

  .award-editor {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .award-editor h4 {
    margin: 0;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .award-editor__row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .award-editor__name {
    flex: 0 0 12rem;
  }

  .award-editor__total {
    margin: 0;
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .award-editor__total.invalid {
    color: var(--smrt-color-error, #dc2626);
  }

  .award-editor :global(.form-group) {
    margin-bottom: 0;
  }

  .audit {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }

  .audit__item dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .audit__item dd {
    margin: 0;
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
