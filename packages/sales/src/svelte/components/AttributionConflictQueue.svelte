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

<section class="smrt-attribution-conflict-queue__root" data-smrt-component="AttributionConflictQueue">
  {#if exceptions.length === 0}
    <p class="smrt-attribution-conflict-queue__empty" data-smrt-part="empty">No attribution exceptions to review.</p>
  {:else}
    {#each exceptions as exception (exception.id)}
      {@const open = exception.status === 'open'}
      {@const awards = draftAwards(exception)}
      {@const validation = validateAwards(awards)}
      {@const reason = (reasonDrafts[exception.id] ?? '').trim()}
      <Card variant="outlined">
        <div class="smrt-attribution-conflict-queue__header" data-smrt-part="header">
          <span class="smrt-attribution-conflict-queue__target" data-smrt-part="target">
            <span class="smrt-attribution-conflict-queue__kind" data-smrt-part="kind">{exception.targetKind}</span>
            {exception.targetLabel ?? exception.targetId}
          </span>
          <span class="smrt-attribution-conflict-queue__badges" data-smrt-part="badges">
            {#if exception.programName}
              <Badge variant="default" size="sm">{exception.programName}</Badge>
            {/if}
            <Badge variant={open ? 'warning' : 'success'} size="sm">
              {exception.status}
            </Badge>
          </span>
        </div>

        <p class="smrt-attribution-conflict-queue__message" data-smrt-part="message">{exception.conflictReason}</p>

        <table class="smrt-attribution-conflict-queue__candidates" data-smrt-part="candidates">
          <caption class="smrt-attribution-conflict-queue__visually-hidden" data-smrt-part="label">Competing candidate touches</caption>
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
          <div class="smrt-attribution-conflict-queue__editor" data-smrt-part="editor">
            <h4>Award credit</h4>
            {#each awards as award (award.referrerId)}
              <div class="smrt-attribution-conflict-queue__row" data-smrt-part="row">
                <span class="smrt-attribution-conflict-queue__name" data-smrt-part="name">
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
              class="smrt-attribution-conflict-queue__total"
              class:smrt-attribution-conflict-queue__invalid={!validation.valid}
              data-smrt-part="total"
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
          <dl class="smrt-attribution-conflict-queue__audit" data-smrt-part="audit">
            <div class="smrt-attribution-conflict-queue__audit-item" data-smrt-part="audit-item">
              <dt>Mode</dt>
              <dd>{exception.resolutionMode ?? '—'}</dd>
            </div>
            <div class="smrt-attribution-conflict-queue__audit-item" data-smrt-part="audit-item">
              <dt>Reason</dt>
              <dd>{exception.resolutionReason ?? '—'}</dd>
            </div>
            <div class="smrt-attribution-conflict-queue__audit-item" data-smrt-part="audit-item">
              <dt>Resolved by</dt>
              <dd>{exception.resolvedByName ?? '—'}</dd>
            </div>
            <div class="smrt-attribution-conflict-queue__audit-item" data-smrt-part="audit-item">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-attribution-conflict-queue__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }
  .smrt-attribution-conflict-queue__empty {
    margin: 0;
  }
  .smrt-attribution-conflict-queue__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-bottom: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-attribution-conflict-queue__kind {
    margin-right: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-attribution-conflict-queue__badges {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-attribution-conflict-queue__message {
    margin: 0 0 var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-attribution-conflict-queue__candidates {
    width: 100%;
    margin-bottom: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-attribution-conflict-queue__candidates th {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    white-space: nowrap;
  }
  .smrt-attribution-conflict-queue__candidates td {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-attribution-conflict-queue__editor {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-attribution-conflict-queue__editor h4 {
    margin: 0;
  }
  .smrt-attribution-conflict-queue__row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-attribution-conflict-queue__name {
    flex: 0 0 12rem;
  }
  .smrt-attribution-conflict-queue__total {
    margin: 0;
  }
  .smrt-attribution-conflict-queue__editor :global([data-smrt-component="FormGroup"]) {
    margin-bottom: 0;
  }
  .smrt-attribution-conflict-queue__audit {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }
  .smrt-attribution-conflict-queue__audit-item dd {
    margin: 0;
  }
  .smrt-attribution-conflict-queue__visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-attribution-conflict-queue__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-attribution-conflict-queue__target {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-attribution-conflict-queue__kind {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-attribution-conflict-queue__candidates {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-attribution-conflict-queue__candidates th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-attribution-conflict-queue__candidates td {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-attribution-conflict-queue__editor h4 {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-attribution-conflict-queue__total {
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-attribution-conflict-queue__total.smrt-attribution-conflict-queue__invalid {
    color: var(--smrt-color-error);
  }
  .smrt-attribution-conflict-queue__audit-item dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
}

</style>
