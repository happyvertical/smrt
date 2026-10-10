<script lang="ts">
import { Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, onMount } from 'svelte';
import type { EvidenceLocation } from '../../extraction-types.js';
import type { IntakeReviewHost, ItemReviewView } from '../../review-dto.js';
import { M } from '../i18n.js';
import { evidenceUrl, extractedContent, pageGroups } from '../view-utils.js';
import ActionReview from './ActionReview.svelte';
import EvidenceViewer from './EvidenceViewer.svelte';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
}
let { host, itemId }: Props = $props();
const { t } = useI18n();
let view = $state<ItemReviewView>(),
  pending = $state(false),
  error = $state(false),
  splits = $state<Record<string, string>>({}),
  invalid = $state(false);
let alive = true,
  epoch = 0,
  loadedPages = 1;
onDestroy(() => {
  alive = false;
  epoch++;
});
function deny() {
  epoch++;
  view = undefined;
  splits = {};
  error = true;
  pending = false;
}
async function load(pageCount = loadedPages) {
  const ticket = ++epoch;
  view = undefined;
  splits = {};
  pending = true;
  error = false;
  invalid = false;
  try {
    let cursor: string | undefined;
    let result: ItemReviewView | undefined;
    const actions: ItemReviewView['reviews']['actions'] = [];
    const actionIds = new Set<string>();
    const cursors = new Set<string>();
    let refreshedPages = 0;
    for (let index = 0; index < pageCount; index++) {
      const page = await host.load(itemId, cursor);
      if (!alive || ticket !== epoch) return;
      if (page.availability !== 'available') {
        result = page;
        break;
      }
      if (
        result &&
        page.entry.item.analysisRevision !== result.entry.item.analysisRevision
      )
        throw new Error('Review changed during pagination');
      result ??= page;
      for (const action of page.reviews.actions) {
        if (!actionIds.has(action.review.actionId)) {
          actionIds.add(action.review.actionId);
          actions.push(action);
        }
      }
      refreshedPages++;
      cursor = page.reviews.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('Repeated review cursor');
      cursors.add(cursor);
    }
    if (!result) throw new Error('Missing review page');
    if (result.availability === 'available') {
      result = {
        ...result,
        reviews: { ...result.reviews, actions, nextCursor: cursor },
      };
      loadedPages = refreshedPages;
    }
    // A host denial must not leave any original, candidate, or argument in the DOM.
    view =
      result.availability === 'available'
        ? result
        : {
            entry: result.entry,
            evidence: [],
            reviews: { actions: [] },
            availability: result.availability,
          };
    splits = Object.fromEntries(
      (view.generation?.splits ?? []).map((split) => [
        split.evidenceId,
        JSON.stringify(split.groups),
      ]),
    );
  } catch {
    if (alive && ticket === epoch) deny();
  } finally {
    if (alive && ticket === epoch) pending = false;
  }
}
async function run(operation: () => Promise<unknown>) {
  if (pending) return;
  const ticket = ++epoch;
  pending = true;
  error = false;
  view = undefined;
  splits = {};
  try {
    await operation();
    if (alive && ticket === epoch) await load();
  } catch {
    if (alive && ticket === epoch) deny();
  }
}
function preview(index: number) {
  const analysis = view?.analysis;
  const suggestion = view?.generation?.suggestions[index];
  if (!analysis || suggestion?.disposition !== 'ready_for_review') return;
  const input = {
    itemId,
    attemptId: analysis.attemptId,
    index,
    requestId: crypto.randomUUID(),
  };
  void run(() => host.preview(input));
}
function split(evidenceId: string) {
  const analysis = view?.analysis;
  if (!view?.generation || !analysis) return;
  let groups: number[][];
  try {
    groups = pageGroups(splits[evidenceId]);
  } catch {
    invalid = true;
    return;
  }
  const input = {
    itemId,
    attemptId: analysis.attemptId,
    expectedRevision: analysis.revision,
    evidenceId,
    groups,
    requestId: crypto.randomUUID(),
  };
  void run(() => host.split(input));
}
function locationLabel(location: EvidenceLocation) {
  switch (location.kind) {
    case 'page':
      return t(M['ingestion.page'], { page: location.page });
    case 'pages':
      return t(M['ingestion.pages'], {
        start: location.startPage,
        end: location.endPage,
      });
    case 'time':
      return t(M['ingestion.time'], {
        start: location.startMs / 1000,
        end: location.endMs / 1000,
      });
    default:
      return t(M['ingestion.source']);
  }
}
function locationUrl(evidenceId: string, location: EvidenceLocation) {
  const evidence = view?.evidence.find(
    (entry) => entry.evidence.id === evidenceId,
  );
  const url = evidenceUrl(evidence?.viewUrl);
  if (!url) return undefined;
  const base = url.split('#')[0];
  if (
    location.kind === 'page' &&
    evidence?.evidence.mediaType === 'application/pdf'
  )
    return `${base}#page=${location.page}`;
  if (
    location.kind === 'pages' &&
    evidence?.evidence.mediaType === 'application/pdf'
  )
    return `${base}#page=${location.startPage}`;
  if (
    location.kind === 'time' &&
    evidence?.evidence.mediaType.startsWith('audio/')
  )
    return `${base}#t=${location.startMs / 1000},${location.endMs / 1000}`;
  return url;
}
onMount(() => {
  void load();
});
</script>
<section data-testid="intake-review" aria-busy={pending}>
<header><h1>{t(M['ingestion.review'])}</h1><Button onclick={() => load()} disabled={pending}>{t(M['ingestion.refresh'])}</Button></header>
{#if pending}<p role="status">{t(M['ingestion.loading'])}</p>{/if}
{#if error}<p role="alert">{t(M['ingestion.error'])}</p>{/if}
{#if view}
{#if view.availability !== 'available'}<p role="alert">{t(M[`ingestion.${view.availability}`])}</p>
{:else}
{@const extracted = view.analysis ? extractedContent(view.analysis.result.output) : []}
<h2>{view.entry.label}</h2><p>{t(M[`ingestion.${view.entry.state}`])}</p>
<div class="review-grid"><EvidenceViewer evidence={view.evidence} /><div class="details">
{#if extracted.length}
<h2>{t(M['ingestion.extracted'])}</h2>
{#each extracted as segment}
<article><pre>{segment.text}</pre>
{#if segment.confidence !== undefined}<p>{t(M['ingestion.confidence'])}: {segment.confidence}</p>{:else}<p>{t(M['ingestion.noConfidence'])}</p>{/if}
{#if segment.location}{@const url = locationUrl(segment.evidenceId,segment.location)}{#if url}<Button href={url} target="_blank" rel="noopener noreferrer">{locationLabel(segment.location)}</Button>{:else}<p>{locationLabel(segment.location)}</p>{/if}{/if}
</article>
{/each}
{/if}
{#if view.generation}
{@const generation = view.generation}
<h2>{t(M['ingestion.proposals'])}</h2><p>{generation.outcome}</p>
{#if typeof view.analysis?.result.confidence === 'number' && Number.isFinite(view.analysis.result.confidence)}<p>{t(M['ingestion.confidence'])}: {view.analysis.result.confidence}</p>{:else}<p>{t(M['ingestion.noConfidence'])}</p>{/if}
{#each generation.warnings as warning}<p>{warning}</p>{/each}
{#each generation.suggestions as suggestion,index}
<article><h3>{suggestion.handlerId}</h3><p>{suggestion.explanation}</p><pre>{JSON.stringify(suggestion.args,null,2)}</pre>
{#if suggestion.alternatives.length}<h4>{t(M['ingestion.alternatives'])}</h4><ul>{#each suggestion.alternatives as alternative}<li>{alternative}</li>{/each}</ul>{/if}
{#if suggestion.missingFields.length}<h4>{t(M['ingestion.missing'])}</h4><ul>{#each suggestion.missingFields as missing}<li>{missing}</li>{/each}</ul>{/if}
<ul>{#each suggestion.evidence as reference}{@const url = locationUrl(reference.evidenceId,reference.location)}<li>{#if url}<Button href={url} target="_blank" rel="noopener noreferrer">{locationLabel(reference.location)}</Button>{:else}{locationLabel(reference.location)}{/if}</li>{/each}</ul>
<Button disabled={suggestion.disposition !== 'ready_for_review' || !view.analysis} onclick={() => preview(index)}>{t(M['ingestion.preview'])}</Button>
</article>
{/each}
{#each generation.splits as proposed (proposed.evidenceId)}<div><Textarea aria-label={`${t(M['ingestion.split'])}: ${proposed.evidenceId}`} bind:value={splits[proposed.evidenceId]} /><Button disabled={!view.analysis} onclick={() => split(proposed.evidenceId)}>{t(M['ingestion.saveSplit'])}</Button></div>{/each}
{#if invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
{/if}
{#if !view.reviews.actions.length}<p>{t(M['ingestion.noReviews'])}</p>{/if}
{#each view.reviews.actions as action (`${action.review.actionId}:${action.review.revision}:${action.review.reviewVersion}`)}
<ActionReview {host} {itemId} {action} {run} {deny} currentAttemptId={action.stalePlan && view.reviews.actions.find((entry) => entry.stalePlan?.id === action.stalePlan?.id) === action ? action.attemptId : undefined} catalog={view.generation?.offered.find((entry) => entry.handler.id === action.handlerId && entry.handler.version === action.handlerVersion)?.handler} />
{/each}
{#if view.reviews.nextCursor}<Button onclick={() => load(loadedPages + 1)}>{t(M['ingestion.more'])}</Button>{/if}
</div></div>
{/if}{/if}
</section>
<style>
section{overflow-wrap:anywhere;max-width:90rem;margin-inline:auto;padding:1rem;color:var(--smrt-color-on-surface,#222)}header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.review-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem}.details,article{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto}article{padding-block:1rem;border-block-end:1px solid var(--smrt-color-outline-variant,#ccc)}@media(max-width:48rem){.review-grid{grid-template-columns:minmax(0,1fr)}header{flex-wrap:wrap}}
</style>
