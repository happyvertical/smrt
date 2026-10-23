<script lang="ts">
import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, untrack } from 'svelte';
import type { ReviewInput } from '../../execution-dto.js';
import type { ProposalCatalogEntry } from '../../proposal-dto.js';
import type { IntakeReviewHost, ReviewAction } from '../../review-dto.js';
import { M } from '../i18n.js';
import { argumentsObject, missingRequired } from '../view-utils.js';
import CandidatePicker from './CandidatePicker.svelte';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  action: ReviewAction;
  catalog?: ProposalCatalogEntry;
  currentAttemptId?: string;
  /** A resolved item is terminal: approve/correct/defer/apply and edits are hidden; only reject remains. */
  resolved?: boolean;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  deny: () => void;
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
let alive = true;
onDestroy(() => {
  alive = false;
});
const dirty = $derived(
  args !== (JSON.stringify(action.args, null, 2) ?? '') ||
    planArgs !== (JSON.stringify(action.plan?.args, null, 2) ?? ''),
);
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
<h3>{action.handlerId ?? action.review.actionId}</h3>
{#if action.origin === 'reviewer-selected'}<p>{t(M['ingestion.reviewerSelected'])}</p>{/if}
<p>{t(M['ingestion.state'])}: {action.review.state}</p>
{#if action.args !== undefined}
<h4>{t(M['ingestion.effects'])}</h4><pre>{JSON.stringify(action.review.display,null,2)}</pre>
<Textarea aria-label={t(M['ingestion.args'])} bind:value={args} readonly={!editable || !!action.plan} rows={8} />
{#if editable}
{#if missing.length}<h4>{t(M['ingestion.missing'])}</h4><ul>{#each missing as name (name)}<li>{name}</li>{/each}</ul>{/if}
<Input aria-label={t(M['ingestion.reason'])} bind:value={reason} />
{#if !action.plan && catalog}<CandidatePicker {host} {itemId} {catalog} {deny} onchoose={choose} />{/if}
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
{#if action.review.state === 'authorized' && !resolved}<Button disabled={dirty} onclick={() => { if (!dirty) void run(() => host.apply(action.review.actionId)); }}>{t(M['ingestion.apply'])}</Button>{/if}
{/if}
{#if action.review.state === 'stale' && !action.stalePlan && action.attemptId && host.editAction && !resolved}
<p>{t(M['ingestion.reviewAgain'])}</p>
<Textarea aria-label={t(M['ingestion.args'])} bind:value={args} rows={8} />
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
{#if host.feedback && action.args !== undefined && action.origin !== 'reviewer-selected'}<fieldset><legend>{t(M['ingestion.feedback'])}</legend><Textarea aria-label={t(M['ingestion.comment'])} bind:value={comment} /><Button disabled={dirty} onclick={() => run(() => host.feedback?.({itemId,actionId:action.review.actionId,expectedRevision:action.review.revision,expectedReviewVersion:action.review.reviewVersion,bindingHash:action.review.bindingHash,judgment:'correct',comment,requestId:crypto.randomUUID()}) ?? Promise.resolve())}>{t(M['ingestion.correctJudgment'])}</Button><Button disabled={dirty} onclick={() => run(() => host.feedback?.({itemId,actionId:action.review.actionId,expectedRevision:action.review.revision,expectedReviewVersion:action.review.reviewVersion,bindingHash:action.review.bindingHash,judgment:'incorrect',comment,requestId:crypto.randomUUID()}) ?? Promise.resolve())}>{t(M['ingestion.incorrectJudgment'])}</Button></fieldset>{/if}
</article>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
article{min-width:0;overflow-wrap:anywhere;border-block-start:var(--smrt-hairline);padding-block:1rem}.controls{display:flex;flex-wrap:wrap;gap:.5rem;margin-block:.75rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}fieldset{margin-block:1rem;min-width:0}
}
</style>
