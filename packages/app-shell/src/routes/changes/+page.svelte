<script lang="ts">
import { Button, toaster } from '@happyvertical/smrt-ui';
import { tick } from 'svelte';
import { goto, invalidate, invalidateAll } from '$app/navigation';
import ChangeCard from '$lib/components/ChangeCard.svelte';
import ChangeCardExtras from '$lib/components/ChangeCardExtras.svelte';
import { ApiError } from '$lib/ui/api';
import {
  activeCards,
  applyBlock,
  changesApi,
  groupCards,
  isChecking,
  overwriteLines,
  plural,
  type QuickEdit,
  removedCards,
} from '$lib/ui/changes';
import { DEPENDS } from '$lib/ui/events';
import type {
  ChangeCardView as ChangeCardViewType,
  ChangesState,
} from '$lib/ui/types';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

// What the last action returned wins until the layout reloads (the live
// event does that straight after); the layout's `changes` is the one source.
let override = $state<ChangesState | null>(null);
$effect(() => {
  data.changes;
  override = null;
});
const changes = $derived<ChangesState | null>(override ?? data.changes ?? null);
const cards = $derived(changes ? activeCards(changes) : []);
const rows = $derived(groupCards(cards));
// A group is shut until opened, unless one of its cards needs a look.
let opened = $state<Record<string, boolean>>({});
const needsLook = (group: { cards: { id: string; checks: unknown[] }[] }) =>
  group.cards.some((c) => c.checks.length > 0 || blockersFor(c.id).length > 0);
const isOpen = (group: {
  id: string;
  cards: { id: string; checks: unknown[] }[];
}) => opened[group.id] ?? needsLook(group);
const removed = $derived(changes ? removedCards(changes) : []);
const block = $derived(changes ? applyBlock(changes) : null);
const checking = $derived(changes ? isChecking(changes) : false);
const blockersFor = (id: string) =>
  (changes?.blockers ?? []).filter((b) => b.cardId === id);
const general = $derived((changes?.blockers ?? []).filter((b) => !b.cardId));

let busy = $state(false);
let working = $state('');
let error = $state('');
let notice = $state('');
let messages = $state<Record<string, string>>({});
let heading: HTMLHeadingElement | undefined = $state();

const gen = () => ({ generation: changes?.generation });

function fail(e: unknown, id?: string) {
  const text =
    e instanceof ApiError
      ? e.status === 409
        ? `${e.message}. The list has been refreshed.`
        : e.message
      : 'Something went wrong. Try again.';
  if (id) messages = { ...messages, [id]: text };
  else error = text;
}

async function refresh() {
  try {
    override = (await changesApi.get()).data;
  } catch {}
  await invalidate(DEPENDS.changes);
}

/** Run one write that answers the new state. */
async function act(
  run: () => Promise<{ data: ChangesState }>,
  id?: string,
  say = '',
): Promise<boolean> {
  busy = true;
  error = '';
  notice = '';
  // Taking one table out of an import replays the rest: say so while it runs.
  working = changes?.cards.some((c) => c.source === 'import')
    ? 'Rebuilding your changes. A large import can take a minute.'
    : '';
  if (id) messages = { ...messages, [id]: '' };
  try {
    override = (await run()).data;
    if (say) notice = say;
    await invalidate(DEPENDS.changes);
    return true;
  } catch (e) {
    fail(e, id);
    if (e instanceof ApiError && e.status === 409) await refresh();
    return false;
  } finally {
    busy = false;
    working = '';
  }
}

async function remove(id: string, summary: string) {
  if (
    await act(() => changesApi.removeCard(id, gen()), id, `Removed: ${summary}`)
  ) {
    await tick();
    heading?.focus();
  }
}

async function edit(id: string, edits: QuickEdit[]) {
  busy = true;
  error = '';
  messages = { ...messages, [id]: '' };
  try {
    for (const one of edits) {
      override = (await changesApi.editCard(id, one, gen())).data;
    }
    notice = 'Saved.';
    await invalidate(DEPENDS.changes);
    return true;
  } catch (e) {
    fail(e, id);
    if (e instanceof ApiError && e.status === 409) await refresh();
    return false;
  } finally {
    busy = false;
  }
}

let commenting = $state<string | null>(null);
let revisingId = $state<string | null>(null);

/** Send the owner's comment: the assistant changes that one card; nothing is applied. */
async function comment(id: string, text: string): Promise<boolean> {
  revisingId = id;
  error = '';
  messages = { ...messages, [id]: '' };
  try {
    override = (await changesApi.comment(id, text)).data;
    commenting = null;
    await invalidate(DEPENDS.changes);
    return true;
  } catch (e) {
    fail(e, id);
    if (e instanceof ApiError && e.status === 409) await refresh();
    return false;
  } finally {
    revisingId = null;
  }
}

/** A click on a review question's choice (its index); never applies anything. */
const answer = (id: string, questionId: string, choice: number) =>
  act(() => changesApi.answer(questionId, choice, gen()), id);

async function apply() {
  if (!changes || block) return;
  busy = true;
  error = '';
  notice = '';
  try {
    await changesApi.apply(changes.digest, gen());
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      error = e.message.startsWith("Can't apply yet")
        ? e.message
        : 'These changes were different when you last looked. Review them again, then Apply.';
      await refresh();
    } else fail(e);
    busy = false;
    return;
  }
  busy = false;
  toaster.success('Applied. Your app is live', {
    duration: 8000,
    action: { label: 'See History', run: () => goto('/history') },
  });
  // Back to the records, with the new structure in place.
  await goto('/', { invalidateAll: true });
  await invalidateAll();
}
</script>

<svelte:head><title>Changes waiting</title></svelte:head>

<div class="smrt-app-shell__page" data-smrt-component="AppShellChanges">
  <header class="smrt-app-shell__head" data-smrt-part="header">
    <div>
      <h1 tabindex="-1" bind:this={heading}>Changes waiting{#if changes && changes.count > 0} <span class="smrt-changes__count" aria-hidden="true">{changes.count}</span>{/if}</h1>
      <p class="smrt-app-shell__sub" data-smrt-part="description">
        Things set up for you. They are not in your app until you click Apply.
      </p>
    </div>
  </header>

  <p class="smrt-app-shell-changes__sr-only" role="status" aria-live="polite" data-smrt-part="label">{notice}</p>
  {#if error}<p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert">{error}</p>{/if}

  {#if !changes || changes.count === 0}
    <div class="smrt-app-shell__empty" data-smrt-part="empty">
      <p><strong>Nothing waiting</strong></p>
      <p class="smrt-app-shell__muted" data-smrt-part="description">Your app is as you left it.</p>
      {#if changes?.discarded}
        <Button variant="secondary" size="sm" disabled={busy} onclick={() => act(() => changesApi.restoreDiscarded(gen()), undefined, 'Your changes are back.')}>Put them back ({plural(changes.discarded.count, 'change')})</Button>
      {/if}
    </div>
  {:else}
    <div class="smrt-changes__box">
    <div class="smrt-changes__root">
      {#if working}<p class="smrt-changes__check" role="status">{working}</p>{/if}
      <ol class="smrt-changes__cards" aria-label="Changes waiting, in the order they were made">
        {#each rows as row (row.kind === 'group' ? row.id : row.card.id)}
          {#if row.kind === 'group'}
            <li class="smrt-changes__group" data-testid="change-group" data-group={row.id}>
              <button type="button" class="smrt-changes__group-head" aria-expanded={isOpen(row)} aria-controls="group-{row.id}" onclick={() => (opened[row.id] = !isOpen(row))}>
                <span class="smrt-changes__group-title">{row.title}</span>
                <span class="smrt-changes__count" aria-hidden="true">{row.cards.length}</span>
                <span class="smrt-app-shell__muted">{plural(row.cards.length, 'change')}{#if needsLook(row)} · needs a look{/if}</span>
                <span class="smrt-changes__chev" aria-hidden="true">{isOpen(row) ? '▾' : '▸'}</span>
              </button>
              {#if isOpen(row)}
                <ol class="smrt-changes__cards smrt-changes__group-cards" id="group-{row.id}" aria-label="{row.title}, {plural(row.cards.length, 'change')}">
                  {#each row.cards as card (card.id)}
                    <li>{@render cardView(card)}</li>
                  {/each}
                </ol>
              {/if}
            </li>
          {:else}
            <li>{@render cardView(row.card)}</li>
          {/if}
        {/each}
      </ol>
      {#snippet cardView(card: ChangeCardViewType)}
            <ChangeCard
              {card}
              blockers={blockersFor(card.id)}
              {checking}
              {busy}
              message={messages[card.id] ?? ''}
              onremove={() => remove(card.id, card.summary)}
              onputback={(removedId) => act(() => changesApi.restoreCard(removedId, gen()), card.id, 'Put it back.')}
              onremovedependents={() => act(() => changesApi.removeDependents(card.id, gen()), card.id, 'Removed those too.')}
              onedit={(edits) => edit(card.id, edits)}
              oncomment={card.editable && card.source !== 'import' ? (c) => (commenting = commenting === c.id ? null : c.id) : undefined}
            >
              {#snippet more(c)}
                <ChangeCardExtras
                  card={{ ...c, revising: c.revising || revisingId === c.id }}
                  composing={commenting === c.id}
                  {busy}
                  onsend={(text) => comment(c.id, text)}
                  oncancel={() => (commenting = null)}
                  onanswer={(questionId, choice) => answer(c.id, questionId, choice)}
                />
              {/snippet}
            </ChangeCard>
      {/snippet}
      {#if removed.length}
        <ul class="smrt-changes__removed" aria-label="Removed changes">
          {#each removed as card (card.id)}
            <li>
              <span class="smrt-app-shell__muted">Removed: {card.summary}</span>
              <Button variant="ghost" size="sm" aria-label="Put back: {card.summary}" disabled={busy} onclick={() => act(() => changesApi.restoreCard(card.id, gen()), card.id, `Put back: ${card.summary}`)}>Put back</Button>
              {#if messages[card.id]}<span role="alert">{messages[card.id]}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}

      <aside class="smrt-changes__side" aria-label="What will change">
        <h2>What will change</h2>
        <ul class="smrt-changes__sum">
          <li><strong>{plural(changes.count, 'change')}</strong></li>
          {#each overwriteLines(changes) as line (line)}<li>{line}</li>{/each}
        </ul>
        {#if checking}
          <p class="smrt-changes__check" role="status"><span class="smrt-changes__spin" aria-hidden="true"></span>Checking…</p>
        {:else if changes.held}
          <p class="smrt-changes__check smrt-changes__check-warn" role="status">{changes.held}</p>
        {:else if changes.blockers.length}
          <div class="smrt-changes__check smrt-changes__check-bad" role="alert">
            <strong>Can't apply yet</strong>
            {#each general as b (b.message)}<span>{b.message}</span>{/each}
            {#if general.length === 0}<span>Fix the changes marked above first.</span>{/if}
          </div>
        {:else if changes.canApply}
          <p class="smrt-changes__check smrt-changes__check-ok" role="status">Ready</p>
        {/if}
        <div class="smrt-changes__actions">
          <Button fullWidth disabled={busy || block !== null} onclick={apply}>Apply {plural(changes.count, 'change')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onclick={() => act(() => changesApi.discard(gen()), undefined, 'Changes discarded.')}>Discard all</Button>
        </div>
      </aside>
    </div>
    </div>
  {/if}

</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-changes__box {
    container-type: inline-size;
  }
  .smrt-changes__root {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 17.5rem;
    gap: 1.25rem;
    align-items: start;
  }
  .smrt-changes__cards,
  .smrt-changes__removed {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.75rem;
  }
  .smrt-changes__group {
    display: grid;
    gap: 0.5rem;
  }
  .smrt-changes__group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    inline-size: 100%;
    padding: 0.7rem 0.9rem;
    cursor: pointer;
  }
  .smrt-changes__chev {
    margin-inline-start: auto;
  }
  .smrt-changes__group-cards {
    padding-inline-start: 1rem;
  }
  .smrt-changes__removed li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-changes__side {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    position: sticky;
    inset-block-start: 1rem;
  }
  .smrt-changes__side h2 {
    margin: 0;
  }
  .smrt-changes__sum {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.35rem;
  }
  .smrt-changes__check {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0.5rem 0.7rem;
  }
  .smrt-changes__actions {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }
  .smrt-changes__actions :global(.smrt-button__primary) {
    inline-size: 100%;
  }
  .smrt-changes__count {
    display: inline-grid;
    place-items: center;
    min-inline-size: 1.5rem;
    block-size: 1.5rem;
    padding-inline: 0.4rem;
  }
  .smrt-changes__spin {
    display: inline-block;
    inline-size: 0.9rem;
    block-size: 0.9rem;
    margin-inline-end: 0.5rem;
  }
  .smrt-app-shell-changes__sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @keyframes smrt-changes-page-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @container (max-width: 40rem) {
    .smrt-changes__root {
      grid-template-columns: minmax(0, 1fr);
    }
    .smrt-changes__side {
      position: static;
    }
    /* Apply stays in reach on a phone. */
    .smrt-changes__actions :global(.smrt-button__primary) {
      position: sticky;
      inset-block-end: 0.5rem;
      z-index: 5;
    }
  }
}

@layer smrt.theme {
  .smrt-changes__group-head {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-color-surface);
    color: inherit;
  }
  .smrt-changes__side {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-color-surface);
  }
  .smrt-changes__count {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-changes__check {
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface-container);
    font-weight: 600;
  }
  .smrt-changes__check-ok {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-changes__check-warn {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-changes__check-bad {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-changes__check-bad span {
    font-weight: 400;
  }
  /* Button-only shade: white text on the theme orange is about 3.6:1, this is 5:1.
     The global primary token is unchanged. */
  .smrt-changes__actions :global(.smrt-button__primary) {
    --smrt-color-primary: var(--smrt-app-shell-action, var(--smrt-color-primary));
  }
  .smrt-changes__group-head {
    font: inherit;
    text-align: start;
  }
  .smrt-changes__group-title {
    font-weight: 600;
  }
  .smrt-changes__side h2 {
    font-size: 0.9375rem;
  }
  .smrt-changes__sum {
    font-size: 0.875rem;
  }
  .smrt-changes__count {
    vertical-align: middle;
    font-size: 0.8125rem;
    font-weight: 700;
  }
  .smrt-changes__spin {
    border: 2px solid currentColor;
    border-inline-end-color: transparent;
    border-radius: 50%;
    animation: smrt-changes-page-spin 0.8s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-changes__spin {
      animation: none;
    }
  }
}
</style>
