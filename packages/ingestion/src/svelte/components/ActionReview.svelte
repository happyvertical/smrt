<script lang="ts" module>
/** A reviewer operation whose result may finish the item for this reviewer. */
export type ReviewOutcome = 'approve' | 'apply' | 'resolve';
</script>
<script lang="ts">
import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, untrack } from 'svelte';
import type { ReviewInput } from '../../execution-dto.js';
import type {
  ProposalCandidate,
  ProposalCatalogEntry,
} from '../../proposal-dto.js';
import type { IntakeReviewHost, ReviewAction } from '../../review-dto.js';
import { argumentFields } from '../argument-fields.js';
import { M, messageKey } from '../i18n.js';
import {
  argumentsObject,
  displayEntries,
  missingRequired,
} from '../view-utils.js';
import ArgumentFields from './ArgumentFields.svelte';
import CandidatePicker from './CandidatePicker.svelte';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  action: ReviewAction;
  catalog?: ProposalCatalogEntry;
  currentAttemptId?: string;
  /** A resolved item is terminal: approve/correct/defer/apply and edits are hidden; only reject remains. */
  resolved?: boolean;
  /** `outcome` names an approve or apply so the parent can report it after its reload. */
  run: (
    operation: () => Promise<unknown>,
    outcome?: ReviewOutcome,
  ) => Promise<void>;
  deny: () => void;
  /** Whether this editor holds unsent input (arguments, reason, comment). */
  ondirty?: (dirty: boolean) => void;
  /** The handler's display label (#4503); the handler id is drawn when absent. */
  label?: string;
  /**
   * The handler whose `argsSchema` draws the arguments as fields (#4503),
   * the offered or reviewer catalog entry; the raw JSON stays under
   * "Advanced". Without it (or a schema without properties) JSON only.
   */
  fields?: ProposalCatalogEntry;
  /** Candidates already known for reference labels (the generation's offer). */
  candidates?: readonly ProposalCandidate[];
  /** Originals an evidence reference may name. */
  evidence?: ReadonlyArray<{ id: string; label: string }>;
  /**
   * The judgment this reviewer sent for the action in this view (kept by the
   * parent across the reload that follows), with the receipt id when the
   * host returned one.
   */
  sent?: { judgment: 'correct' | 'incorrect'; id?: string };
  /** Told about a judgment once the host accepted it. */
  onjudged?: (judged: { judgment: 'correct' | 'incorrect'; id?: string }) => void;
}
let {
  host,
  itemId,
  action,
  catalog,
  currentAttemptId,
  resolved = false,
  run,
  deny,
  ondirty,
  label,
  fields,
  candidates,
  evidence,
  sent,
  onjudged,
}: Props = $props();
const { t } = useI18n();
// ReviewView keys this editor by action/revision/reviewVersion; edits are local to that binding.
let args = $state(untrack(() => JSON.stringify(action.args, null, 2) ?? '')),
  reason = $state(''),
  invalid = $state(false),
  comment = $state(''),
  planArgs = $state(
    untrack(() => JSON.stringify(action.plan?.args, null, 2) ?? ''),
  );
// Fields replace the destination picker when the schema draws any.
const drawsFields = $derived(
  !!fields && argumentFields(fields.argsSchema, fields.references).length > 0,
);
const stateKey = $derived(
  messageKey('ingestion.reviewState.', action.review.state),
);
// The handler's preview fields, then non-empty framework metadata.
const effects = $derived(displayEntries(action.review.display));
// The current judgment: the loaded one, else the one sent from this view.
const judged = $derived(action.feedback ?? sent);
function judge(judgment: 'correct' | 'incorrect') {
  const send = host.feedback;
  if (!send) return;
  const previous = action.feedback?.id ?? sent?.id;
  const input = {
    itemId,
    actionId: action.review.actionId,
    expectedRevision: action.review.revision,
    expectedReviewVersion: action.review.reviewVersion,
    bindingHash: action.review.bindingHash,
    judgment,
    comment,
    requestId: crypto.randomUUID(),
    // A second judgment replaces the reviewer's current one.
    ...(previous ? { supersedesId: previous } : {}),
  };
  return run(async () => {
    const receipt = await send(input);
    onjudged?.({
      judgment,
      ...(receipt && typeof receipt.id === 'string' ? { id: receipt.id } : {}),
    });
  });
}
let alive = true;
onDestroy(() => {
  alive = false;
  // The editor's local input goes with it.
  ondirty?.(false);
});
const dirty = $derived(
  args !== (JSON.stringify(action.args, null, 2) ?? '') ||
    planArgs !== (JSON.stringify(action.plan?.args, null, 2) ?? ''),
);
const unsent = $derived(dirty || !!reason || !!comment);
$effect(() => {
  const edited = unsent;
  untrack(() => ondirty?.(edited));
});
const waiting = $derived(
  action.args !== undefined && action.review.state === 'waiting_review',
);
const revisable = $derived(
  ['authorized', 'deferred', 'rejected', 'failed'].includes(
    action.review.state,
  ),
);
const editable = $derived(
  action.args !== undefined &&
    (waiting ||
      (!action.plan &&
        revisable &&
        !!host.editAction &&
        !!action.attemptId &&
        !!action.handlerId &&
        !!action.handlerVersion)),
);
const planEditable = $derived(
  action.args !== undefined && (waiting || revisable),
);
// Required handler arguments absent from the current draft; a hint only,
// the server-side preview still validates the published arguments (#4208).
const missing = $derived(
  catalog && editable && !action.plan
    ? missingRequired(catalog.argsSchema, args)
    : [],
);
async function decide(decision: ReviewInput['decision']) {
  if (!waiting) return;
  let correctedArgs: ReviewInput['correctedArgs'];
  try {
    if (decision === 'correct' && action.plan) return;
    if (decision === 'correct') correctedArgs = argumentsObject(args);
  } catch {
    invalid = true;
    return;
  }
  const review = action.review;
  await run(() =>
    host.decide({
      actionId: review.actionId,
      expectedRevision: review.revision,
      expectedReviewVersion: review.reviewVersion,
      bindingHash: review.bindingHash,
      requestId: crypto.randomUUID(),
      decision,
      ...(reason ? { reason } : {}),
      ...(correctedArgs ? { correctedArgs } : {}),
    }),
    decision === 'approve' ? 'approve' : undefined,
  );
}
async function saveEdits() {
  if (waiting) return decide('correct');
  if (
    (!editable && action.review.state !== 'stale') ||
    action.plan ||
    action.stalePlan ||
    !host.editAction ||
    !action.attemptId ||
    !action.handlerId ||
    !action.handlerVersion
  )
    return;
  let values;
  try {
    values = argumentsObject(args);
  } catch {
    invalid = true;
    return;
  }
  const input = {
    itemId,
    actionId: action.review.actionId,
    attemptId: action.attemptId,
    expectedRevision: action.review.revision,
    handlerId: action.handlerId,
    handlerVersion: action.handlerVersion,
    args: values,
    requestId: crypto.randomUUID(),
    ...(action.dependencies ? { dependencies: action.dependencies } : {}),
  };
  await run(() => host.editAction?.(input) ?? Promise.resolve());
}
async function editPlan() {
  const plan = action.plan ?? action.stalePlan;
  const attemptId = action.plan?.attemptId ?? currentAttemptId;
  if (
    !plan ||
    !plan.handlerId ||
    !plan.handlerVersion ||
    !attemptId ||
    !host.editPlan
  )
    return;
  let values;
  try {
    values = argumentsObject(planArgs);
  } catch {
    invalid = true;
    return;
  }
  const input = {
    itemId,
    planKey: plan.key,
    attemptId,
    expectedRevision: plan.revision,
    handlerId: plan.handlerId,
    handlerVersion: plan.handlerVersion,
    args: values,
    requestId: crypto.randomUUID(),
  };
  await run(() => host.editPlan?.(input) ?? Promise.resolve());
}
function choose(field: string, id: string) {
  try {
    args = JSON.stringify({ ...argumentsObject(args), [field]: id }, null, 2);
  } catch {
    invalid = true;
  }
}
</script>
<article data-testid={`action-${action.review.actionId}`}>
<h3>{label ?? action.handlerId ?? action.review.actionId}</h3>
{#if action.origin === 'reviewer-selected'}<p>{t(M['ingestion.reviewerSelected'])}</p>{/if}
<p data-testid="review-state">{t(M['ingestion.state'])}: {stateKey ? t(M[stateKey]) : action.review.state}</p>
{#if action.args !== undefined}
<h4>{t(M['ingestion.effects'])}</h4>{#if effects.length}<dl class="effects" data-testid="effects">{#each effects as [name, value] (name)}<dt>{name}</dt><dd>{value}</dd>{/each}</dl>{/if}
<ArgumentFields bind:value={args} label={t(M['ingestion.args'])} catalog={fields} {candidates} {evidence} readonly={!editable || !!action.plan} {host} {itemId} {deny} />
{#if editable}
{#if missing.length}<h4>{t(M['ingestion.missing'])}</h4><ul>{#each missing as name (name)}<li>{name}</li>{/each}</ul>{/if}
<Input aria-label={t(M['ingestion.reason'])} bind:value={reason} />
{#if !action.plan && catalog && !drawsFields}<CandidatePicker {host} {itemId} {catalog} {deny} onchoose={choose} />{/if}
{#if dirty}<p>{t(M['ingestion.reviewAgain'])}</p>{/if}
{#if invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
<div class="controls">{#if waiting && !resolved}<Button disabled={dirty} onclick={() => decide('approve')}>{t(M['ingestion.approve'])}</Button>{/if}{#if !action.plan && !resolved}<Button disabled={!dirty} onclick={saveEdits}>{t(M['ingestion.correct'])}</Button>{/if}{#if waiting}<Button onclick={() => decide('reject')}>{t(M['ingestion.reject'])}</Button>{#if !resolved}<Button onclick={() => decide('defer')}>{t(M['ingestion.defer'])}</Button>{/if}{/if}</div>
{/if}
{#if action.plan?.stepIndex === 0 && action.plan.args && host.editPlan && planEditable && !resolved}
<Textarea aria-label={t(M['ingestion.planArgs'])} bind:value={planArgs} rows={8} />
{#if !editable && dirty}<p>{t(M['ingestion.reviewAgain'])}</p>{/if}
{#if !editable && invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
<Button onclick={editPlan}>{t(M['ingestion.editPlan'])}</Button>
{/if}
{#if action.review.state === 'authorized' && !resolved}<Button disabled={unsent} onclick={() => { if (!unsent) void run(() => host.apply(action.review.actionId), 'apply'); }}>{t(M['ingestion.apply'])}</Button>{/if}
{/if}
{#if action.review.state === 'stale' && !action.stalePlan && action.attemptId && host.editAction && !resolved}
<p>{t(M['ingestion.reviewAgain'])}</p>
<ArgumentFields bind:value={args} label={t(M['ingestion.args'])} catalog={fields} {candidates} {evidence} {host} {itemId} {deny} />
{#if invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
<Button onclick={saveEdits}>{t(M['ingestion.correct'])}</Button>
{/if}
{#if action.review.state === 'stale' && action.stalePlan && currentAttemptId && host.editPlan && !resolved}
<p>{t(M['ingestion.reviewAgain'])}</p>
<Textarea aria-label={t(M['ingestion.planArgs'])} bind:value={planArgs} rows={8} />
{#if invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
<Button onclick={editPlan}>{t(M['ingestion.editPlan'])}</Button>
{/if}
{#if action.result}<h4>{t(M['ingestion.result'])}</h4><pre>{JSON.stringify(action.result,null,2)}</pre>{/if}
{#if host.feedback && action.args !== undefined && action.origin !== 'reviewer-selected'}<fieldset><legend>{t(M['ingestion.feedback'])}</legend><Textarea aria-label={t(M['ingestion.comment'])} bind:value={comment} /><Button disabled={dirty} aria-pressed={judged?.judgment === 'correct'} onclick={() => judge('correct')}>{t(M['ingestion.correctJudgment'])}</Button><Button disabled={dirty} aria-pressed={judged?.judgment === 'incorrect'} onclick={() => judge('incorrect')}>{t(M['ingestion.incorrectJudgment'])}</Button>{#if sent}<p role="status" data-testid="feedback-sent">{t(M['ingestion.feedbackSent'])}</p>{/if}</fieldset>{/if}
</article>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
article{min-width:0;overflow-wrap:anywhere;border-block-start:var(--smrt-hairline);padding-block:1rem}.controls{display:flex;flex-wrap:wrap;gap:.5rem;margin-block:.75rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}fieldset{margin-block:1rem;min-width:0}.effects{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:.25rem 1rem;margin-block:.5rem}.effects dt{font-weight:600}.effects dd{margin:0}
}
</style>
