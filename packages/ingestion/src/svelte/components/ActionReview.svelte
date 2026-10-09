<script lang="ts">
import { Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, untrack } from 'svelte';
import type { ReviewInput } from '../../execution-dto.js';
import type {
  CandidatePage,
  ProposalCatalogEntry,
} from '../../proposal-dto.js';
import type { IntakeReviewHost, ReviewAction } from '../../review-dto.js';
import { M } from '../i18n.js';
import { argumentsObject } from '../view-utils.js';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  action: ReviewAction;
  catalog?: ProposalCatalogEntry;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  deny: () => void;
}
let { host, itemId, action, catalog, run, deny }: Props = $props();
const { t } = useI18n();
// ReviewView keys this editor by action/revision/reviewVersion; edits are local to that binding.
let args = $state(untrack(() => JSON.stringify(action.args, null, 2) ?? '')),
  reason = $state(''),
  query = $state(''),
  field = $state(''),
  candidates = $state<CandidatePage>(),
  searching = $state(false),
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
    !editable ||
    action.plan ||
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
async function search() {
  if (!action.handlerId || !action.handlerVersion || searching) return;
  searching = true;
  candidates = undefined;
  try {
    const result = await host.candidates({
      itemId,
      handlerId: action.handlerId,
      handlerVersion: action.handlerVersion,
      query,
    });
    if (alive) candidates = result;
  } catch {
    if (alive) deny();
  } finally {
    if (alive) searching = false;
  }
}
async function editPlan() {
  const plan = action.plan;
  if (
    !plan?.args ||
    !plan.handlerId ||
    !plan.handlerVersion ||
    !plan.attemptId ||
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
    attemptId: plan.attemptId,
    expectedRevision: plan.revision,
    handlerId: plan.handlerId,
    handlerVersion: plan.handlerVersion,
    args: values,
    requestId: crypto.randomUUID(),
  };
  await run(() => host.editPlan?.(input) ?? Promise.resolve());
}
function choose(id: string) {
  try {
    const values = argumentsObject(args);
    const ref = catalog?.references[field];
    if (
      ref?.kind !== 'candidate' ||
      !candidates?.items.some(
        (candidate) => candidate.id === id && candidate.model === ref.model,
      )
    )
      return;
    args = JSON.stringify({ ...values, [field]: id }, null, 2);
  } catch {
    invalid = true;
  }
}
</script>
<article data-testid={`action-${action.review.actionId}`}>
<h3>{action.handlerId ?? action.review.actionId}</h3>
<p>{t(M['ingestion.state'])}: {action.review.state}</p>
{#if action.args !== undefined}
<h4>{t(M['ingestion.effects'])}</h4><pre>{JSON.stringify(action.review.display,null,2)}</pre>
<Textarea aria-label={t(M['ingestion.args'])} bind:value={args} readonly={!editable || !!action.plan} rows={8} />
{#if editable}
<Input aria-label={t(M['ingestion.reason'])} bind:value={reason} />
{#if !action.plan && catalog && Object.values(catalog.references).some((ref) => ref.kind === 'candidate')}
<h4>{t(M['ingestion.candidates'])}</h4>
<Select aria-label={t(M['ingestion.field'])} bind:value={field}><option value="">{t(M['ingestion.field'])}</option>{#each Object.entries(catalog.references) as [name,ref]}{#if ref.kind === 'candidate'}<option value={name}>{name}</option>{/if}{/each}</Select>
<Input aria-label={t(M['ingestion.query'])} bind:value={query} />
<Button onclick={search} disabled={searching}>{t(M['ingestion.search'])}</Button>
{#if candidates}<ul>{#each candidates.items as candidate (candidate.key)}<li>{candidate.label} <Button disabled={!field} onclick={() => choose(candidate.id)}>{t(M['ingestion.choose'])}</Button></li>{/each}</ul>{#if candidates.truncated}<p>{t(M['ingestion.truncated'])}</p>{/if}{/if}
{/if}
{#if dirty}<p>{t(M['ingestion.reviewAgain'])}</p>{/if}
{#if invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
<div class="controls">{#if waiting}<Button disabled={dirty} onclick={() => decide('approve')}>{t(M['ingestion.approve'])}</Button>{/if}{#if !action.plan}<Button disabled={!dirty} onclick={saveEdits}>{t(M['ingestion.correct'])}</Button>{/if}{#if waiting}<Button onclick={() => decide('reject')}>{t(M['ingestion.reject'])}</Button><Button onclick={() => decide('defer')}>{t(M['ingestion.defer'])}</Button>{/if}</div>
{/if}
{#if action.plan?.stepIndex === 0 && action.plan.args && host.editPlan && planEditable}
<Textarea aria-label={t(M['ingestion.planArgs'])} bind:value={planArgs} rows={8} />
{#if !editable && dirty}<p>{t(M['ingestion.reviewAgain'])}</p>{/if}
{#if !editable && invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
<Button onclick={editPlan}>{t(M['ingestion.editPlan'])}</Button>
{/if}
{#if action.review.state === 'authorized'}<Button disabled={dirty} onclick={() => { if (!dirty) void run(() => host.apply(action.review.actionId)); }}>{t(M['ingestion.apply'])}</Button>{/if}
{/if}
{#if action.result}<h4>{t(M['ingestion.result'])}</h4><pre>{JSON.stringify(action.result,null,2)}</pre>{/if}
{#if host.feedback && action.args !== undefined}<fieldset><legend>{t(M['ingestion.feedback'])}</legend><Textarea aria-label={t(M['ingestion.comment'])} bind:value={comment} /><Button onclick={() => run(() => host.feedback?.({itemId,actionId:action.review.actionId,judgment:'correct',comment,requestId:crypto.randomUUID()}) ?? Promise.resolve())}>{t(M['ingestion.correctJudgment'])}</Button><Button onclick={() => run(() => host.feedback?.({itemId,actionId:action.review.actionId,judgment:'incorrect',comment,requestId:crypto.randomUUID()}) ?? Promise.resolve())}>{t(M['ingestion.incorrectJudgment'])}</Button></fieldset>{/if}
</article>
<style>
article{min-width:0;overflow-wrap:anywhere;border-block-start:1px solid var(--smrt-color-outline-variant,#ccc);padding-block:1rem}.controls{display:flex;flex-wrap:wrap;gap:.5rem;margin-block:.75rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}fieldset{margin-block:1rem;min-width:0}
</style>
