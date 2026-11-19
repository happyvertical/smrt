<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import type { Snippet } from 'svelte';
import {
  type CardKind,
  cardKind,
  planQuickEdit,
  type QuickEdit,
  quickEditCalls,
} from '$lib/ui/changes';
import type { ChangeBlocker, ChangeCardView } from '$lib/ui/types';

interface Props {
  card: ChangeCardView;
  /** Blockers that name this card ("Can't apply yet"). */
  blockers?: ChangeBlocker[];
  /** True while the changes are being re-checked. */
  checking?: boolean;
  busy?: boolean;
  /** Set while this card's last action failed. */
  message?: string;
  onremove: () => void;
  /** One PATCH body per changed piece; resolves true when saved. */
  onedit: (edits: QuickEdit[]) => Promise<boolean>;
  /**
   * Seam for the assistant slice: when given, Comment is offered and this runs
   * with the card. Nothing is rendered when it is absent.
   */
  oncomment?: (card: ChangeCardView) => void;
  /** Seam for review questions and comment threads (assistant slice). */
  more?: Snippet<[ChangeCardView]>;
}

let {
  card,
  blockers = [],
  checking = false,
  busy = false,
  message = '',
  onremove,
  onedit,
  oncomment,
  more,
}: Props = $props();

const kind: CardKind = $derived(cardKind(card));
const edit = $derived(planQuickEdit(card));
const shownChoices = $derived(edit?.fields[0]?.choices ?? []);
let editing = $state(false);
let label = $state('');
let choices = $state<string[][]>([]);
let adding = $state<string[]>([]);
let saving = $state(false);
const uid = $props.id();

function openEdit() {
  if (!edit) return;
  label = edit.label ?? '';
  choices = edit.fields.map((f) => [...f.choices]);
  adding = edit.fields.map(() => '');
  editing = true;
}

function addChoice(i: number) {
  const value = adding[i]?.trim();
  if (!value || choices[i].includes(value)) return;
  choices[i] = [...choices[i], value];
  adding[i] = '';
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  if (!edit) return;
  for (let i = 0; i < choices.length; i++) addChoice(i);
  const calls = quickEditCalls(edit, { label, choices });
  if (!calls.length) {
    editing = false;
    return;
  }
  saving = true;
  try {
    if (await onedit(calls)) editing = false;
  } finally {
    saving = false;
  }
}

const problems = $derived([
  ...card.checks.map((c) => c.message),
  ...blockers.map((b) => b.message),
]);
</script>

<article
  class="smrt-change-card"
  class:smrt-change-card__blocked={problems.length > 0}
  aria-labelledby="{uid}-title"
  data-testid="change-card"
  data-card-id={card.id}
>
  <div class="smrt-change-card__top">
    <span class="smrt-change-card__kind" aria-hidden="true" data-kind={kind}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        {#if kind === 'table'}<rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 10h17M3.5 15h17M9.5 4.5v15" />
        {:else if kind === 'data'}<path d="M5 6h14M5 12h14M5 18h14" />
        {:else if kind === 'report'}<path d="M5 20V10M12 20V4M19 20v-7" />
        {:else}<rect x="3.5" y="6" width="17" height="12" rx="2" /><path d="M7.5 10l2.5 2.5L7.5 15M13 15h3.5" />{/if}
      </svg>
    </span>
    <div class="smrt-change-card__main">
      <h3 id="{uid}-title">{card.summary || 'A change to your app'}</h3>
      <div class="smrt-change-card__chips">
        {#each shownChoices as c (c)}<span class="smrt-change-card__chip">{c}</span>{/each}
        {#if checking}<span class="smrt-change-card__chip" role="status">Checking…</span>{/if}
        {#each problems as p (p)}<span class="smrt-change-card__chip smrt-change-card__chip-bad">{p}</span>{/each}
        {#if card.opaque}<span class="smrt-change-card__chip">Made before changes waiting</span>{/if}
      </div>
    </div>
    <div class="smrt-change-card__tools">
      {#if edit}
        <Button variant="ghost" size="sm" aria-label="Quick edit: {card.summary}" aria-expanded={editing} aria-controls="{uid}-edit" disabled={busy} onclick={() => (editing ? (editing = false) : openEdit())}>Quick edit</Button>
      {/if}
      {#if oncomment}
        <Button variant="ghost" size="sm" aria-label="Comment on: {card.summary}" disabled={busy} onclick={() => oncomment(card)}>Comment</Button>
      {/if}
      {#if card.editable}
        <Button variant="ghost" size="sm" aria-label="Remove this change: {card.summary}" title="Remove this change" disabled={busy} onclick={onremove}>×</Button>
      {/if}
    </div>
  </div>

  {#if editing && edit}
    <form class="smrt-change-card__panel" id="{uid}-edit" onsubmit={save}>
      {#if edit.label !== null}
        <label class="smrt-change-card__f" for="{uid}-name">{edit.labelName}
          <input class="smrt-change-card__input" id="{uid}-name" name="name" bind:value={label} maxlength="80" required />
        </label>
      {/if}
      {#each edit.fields as f, i (f.field ?? i)}
        <div class="smrt-change-card__f">
          <span id="{uid}-ch{i}">{f.name}</span>
          <div class="smrt-change-card__choices" role="group" aria-labelledby="{uid}-ch{i}">
            {#each choices[i] ?? [] as c, j (c)}
              <span class="smrt-change-card__chip">{c}
                <button type="button" class="smrt-change-card__chip-x" aria-label="Remove choice {c}" disabled={(choices[i]?.length ?? 0) <= 1} onclick={() => (choices[i] = choices[i].filter((_, k) => k !== j))}>×</button>
              </span>
            {/each}
            <input class="smrt-change-card__add" aria-label="Add a choice" placeholder="Add a choice…" bind:value={adding[i]} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChoice(i); } }} />
          </div>
        </div>
      {/each}
      <div class="smrt-change-card__row">
        <Button variant="ghost" size="sm" type="button" disabled={saving} onclick={() => (editing = false)}>Cancel</Button>
        <Button size="sm" type="submit" disabled={saving}>Save</Button>
      </div>
    </form>
  {/if}

  {#if message}<p class="smrt-change-card__err" role="alert">{message}</p>{/if}
  {#if more}{@render more(card)}{/if}
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-change-card {
    padding: 0.875rem 1rem;
  }
  .smrt-change-card__top {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.75rem;
    align-items: start;
  }
  .smrt-change-card__kind {
    display: grid;
    place-items: center;
    inline-size: 2.25rem;
    block-size: 2.25rem;
  }
  .smrt-change-card h3 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.35;
  }
  .smrt-change-card__chips,
  .smrt-change-card__choices,
  .smrt-change-card__row,
  .smrt-change-card__tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
  }
  .smrt-change-card__chips {
    margin-block-start: 0.4rem;
  }
  .smrt-change-card__chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .smrt-change-card__chip-x {
    border: 0;
    background: none;
    padding: 0 0.15rem;
    cursor: pointer;
    color: inherit;
  }
  .smrt-change-card__panel {
    display: grid;
    gap: 0.6rem;
    margin-block-start: 0.75rem;
    padding: 0.75rem;
  }
  .smrt-change-card__f {
    display: grid;
    gap: 0.2rem;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .smrt-change-card__input,
  .smrt-change-card__add {
    min-block-size: 2.25rem;
    padding: 0.3rem 0.6rem;
    font: inherit;
    font-weight: 400;
  }
  .smrt-change-card__row {
    justify-content: flex-end;
  }
  .smrt-change-card__err {
    margin: 0.5rem 0 0;
  }
  .smrt-change-card {
    container-type: inline-size;
  }
  @container (max-width: 26rem) {
    .smrt-change-card__top {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .smrt-change-card__tools {
      grid-column: 1 / -1;
      justify-content: flex-end;
    }
  }
}

@layer smrt.theme {
  .smrt-change-card {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-color-surface-container-low, var(--smrt-color-surface));
  }
  .smrt-change-card__blocked {
    border-color: var(--smrt-color-error);
  }
  .smrt-change-card__kind {
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-change-card__chip {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-change-card__chip-bad {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-change-card__panel {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface);
  }
  .smrt-change-card__input,
  .smrt-change-card__add {
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface);
    color: inherit;
  }
  .smrt-change-card__err {
    color: var(--smrt-color-error);
  }
  /* Button-only shade (5:1 with white); the global primary token is unchanged. */
  .smrt-change-card :global(.smrt-button__primary) {
    --smrt-color-primary: var(--smrt-app-shell-action, #c2470a);
  }
}
</style>
