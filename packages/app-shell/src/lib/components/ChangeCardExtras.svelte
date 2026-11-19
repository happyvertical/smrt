<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import type { ChangeCardView } from '$lib/ui/types';

// What the assistant adds under a waiting change (#5206): the comment thread
// (owner's words and the assistant's answer, plain text), the comment box, and
// the review questions with click-to-answer choices. Everything here is plain
// text: nothing the model wrote is rendered as markup or run. Questions never
// stop Apply; a choice that adds something makes a NEW change.
interface Props {
  card: ChangeCardView;
  /** The comment box is open for this card. */
  composing?: boolean;
  busy?: boolean;
  /** Resolves true when the comment was sent. */
  onsend: (text: string) => Promise<boolean>;
  oncancel: () => void;
  onanswer: (questionId: string, choice: number) => void;
}

let {
  card,
  composing = false,
  busy = false,
  onsend,
  oncancel,
  onanswer,
}: Props = $props();
let text = $state('');
let sending = $state(false);
const uid = $props.id();

async function send(event: SubmitEvent) {
  event.preventDefault();
  const value = text.trim();
  if (!value || sending) return;
  sending = true;
  try {
    if (await onsend(value)) text = '';
  } finally {
    sending = false;
  }
}
</script>

{#if card.comments.length || card.revising}
  <div class="smrt-change-extras__thread" data-testid="comment-thread" aria-label="Comments on this change">
    {#each card.comments as c, i (i)}
      <p class="smrt-change-extras__msg" data-role={c.role}><span class="smrt-change-extras__who">{c.role === 'owner' ? 'You' : 'Assistant'}</span> {c.text}</p>
    {/each}
    {#if card.revising}
      <p class="smrt-change-extras__msg smrt-change-extras__wait" role="status" data-testid="revising">Changing this…</p>
    {/if}
  </div>
{/if}

{#if composing && !card.revising}
  <form class="smrt-change-extras__form" onsubmit={send}>
    <label class="smrt-change-extras__label" for="{uid}-comment">Tell the assistant what to change</label>
    <textarea id="{uid}-comment" class="smrt-change-extras__text" rows="2" maxlength="2000" bind:value={text} disabled={sending || busy}></textarea>
    <div class="smrt-change-extras__row">
      <Button variant="ghost" size="sm" type="button" disabled={sending} onclick={oncancel}>Cancel</Button>
      <Button size="sm" type="submit" disabled={sending || busy || !text.trim()}>Send</Button>
    </div>
  </form>
{/if}

{#each card.questions as q (q.id)}
  <div class="smrt-change-extras__q" role="group" aria-labelledby="{uid}-{q.id}" data-testid="review-question">
    <p id="{uid}-{q.id}" class="smrt-change-extras__qtext">{q.text}</p>
    {#if q.state === 'open'}
      <div class="smrt-change-extras__row smrt-change-extras__choices">
        {#each q.choices as c, i (i)}
          <Button size="sm" variant="secondary" disabled={busy} onclick={() => onanswer(q.id, i)}>{c.label}</Button>
        {/each}
      </div>
    {:else}
      <p class="smrt-change-extras__done">You chose: {q.choices[q.answered ?? -1]?.label ?? 'an option'}</p>
    {/if}
  </div>
{/each}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-change-extras__thread,
  .smrt-change-extras__form,
  .smrt-change-extras__q {
    display: grid;
    gap: 0.4rem;
    margin-block-start: 0.75rem;
    padding: 0.6rem 0.75rem;
  }
  .smrt-change-extras__msg,
  .smrt-change-extras__qtext,
  .smrt-change-extras__done {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .smrt-change-extras__who {
    font-weight: 600;
  }
  .smrt-change-extras__row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    justify-content: flex-end;
  }
  .smrt-change-extras__choices {
    justify-content: flex-start;
  }
  .smrt-change-extras__text {
    padding: 0.4rem 0.6rem;
    font: inherit;
    resize: vertical;
  }
  .smrt-change-extras__label {
    font-size: 0.8125rem;
    font-weight: 600;
  }
}

@layer smrt.theme {
  .smrt-change-extras__thread,
  .smrt-change-extras__form,
  .smrt-change-extras__q {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface);
  }
  .smrt-change-extras__wait,
  .smrt-change-extras__done {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-change-extras__text {
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface);
    color: inherit;
  }
}
</style>
