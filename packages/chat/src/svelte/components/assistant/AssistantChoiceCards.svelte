<script lang="ts">
/**
 * AssistantChoiceCards — the options an assistant offered (see
 * `./assistant-choices.svelte.ts`), as cards the person picks from.
 *
 * Used by `AssistantDock` for its own conversation, and by a host that runs
 * a second, focused conversation next to the page (for example "change this
 * picture") with its own controller. Only the person's click chooses; "None
 * of these" dismisses the set.
 *
 * A set whose source can preview (`set.previewable`) works in two steps: a
 * click on a card PREVIEWS it in place (`onpreview`; the "Original" card puts
 * the page back), and nothing is applied until the person presses the
 * primary button (`oncommit`). The secondary button, Escape, and closing
 * the offer restore the original (`oncancel`). Once applied the cards
 * collapse to the outcome line.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import type { AssistantChoiceSet } from './assistant-choices.svelte.js';

export interface Props {
  /** The controller's `choices` (dismissed sets are hidden). */
  choices: AssistantChoiceSet[];
  /** The person picked an option (`controller.chooseOption`). */
  onchoose: (setId: string, optionId: string) => void;
  /** The person wants none of them (`controller.dismissChoices`). */
  ondismiss: (setId: string) => void;
  /** Preview a card of a previewable set in place (`controller.previewOption`). */
  onpreview?: (setId: string, optionId: string) => void;
  /** Apply the previewed card (`controller.commitOption`). */
  oncommit?: (setId: string) => void;
  /** Restore the original and close the set (`controller.cancelChoices`). */
  oncancel?: (setId: string) => void;
}

const { choices, onchoose, ondismiss, onpreview, oncommit, oncancel }: Props =
  $props();

/** Previewable sets are only previewable when the host wired the callbacks. */
function previews(set: AssistantChoiceSet): boolean {
  return Boolean(set.previewable && onpreview && oncommit);
}

function cancel(set: AssistantChoiceSet) {
  (oncancel ?? ondismiss)(set.id);
}

function onkeydown(event: KeyboardEvent, set: AssistantChoiceSet) {
  if (
    event.key === 'Escape' &&
    previews(set) &&
    (set.status === 'waiting' || set.status === 'failed')
  ) {
    event.preventDefault();
    event.stopPropagation();
    cancel(set);
  }
}
const { t } = useI18n();
</script>

{#each choices.filter((set) => set.status !== 'dismissed') as set (set.id)}
  {@const chosen = set.options.find((option) => option.id === set.chosenOptionId)}
  {@const making = set.status === 'waiting' && set.pending ? set.pending : null}
  {@const preview = previews(set)}
  {@const open = set.status === 'waiting' || set.status === 'failed'}
  {@const previewed = set.previewOptionId}
  {@const cards = preview && set.original ? [set.original, ...set.options] : set.options}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="assistant-dock-choices"
    role="group"
    aria-label={set.title}
    aria-busy={making ? 'true' : undefined}
    onkeydown={(event) => onkeydown(event, set)}
  >
    <p class="assistant-dock-choices-title">{set.title}</p>
    {#if making}
      <p class="assistant-dock-choices-status assistant-dock-choices-making" role="status">{making.message}</p>
    {/if}
    {#if !(preview && set.status === 'applied')}
    <ul class="assistant-dock-choice-list">
      {#each cards as option (option.id)}
        <li>
          <!-- raw-primitive-allow: a picture card that is itself the choice (image, label and description inside one pressable target); Button's single-label layout does not fit -->
          <button
            type="button"
            class="assistant-dock-choice"
            class:chosen={preview ? previewed === option.id : set.chosenOptionId === option.id}
            aria-pressed={preview ? previewed === option.id : set.chosenOptionId === option.id}
            disabled={!open}
            onclick={() => (preview ? onpreview?.(set.id, option.id) : onchoose(set.id, option.id))}
          >
            {#if option.imageUrl}
              <img src={option.imageUrl} alt={option.imageAlt ?? option.label} loading="lazy" />
            {/if}
            <span class="assistant-dock-choice-label">{option.label}</span>
            {#if option.description}
              <span class="assistant-dock-choice-description">{option.description}</span>
            {/if}
          </button>
        </li>
      {/each}
      {#if making}
        {#each { length: making.expected } as _, index (index)}
          <li class="assistant-dock-choice-pending" aria-hidden="true">
            <span class="assistant-dock-choice-placeholder"></span>
            <span class="assistant-dock-choice-label">{t(M['chat.assistant_dock.choices_making'])}</span>
          </li>
        {/each}
      {/if}
    </ul>
    {/if}
    {#if set.note && set.status === 'waiting'}
      <p class="assistant-dock-choices-status">{set.note}</p>
    {/if}
    {#if preview && open}
      <div class="assistant-dock-choices-actions assistant-dock-choices-commit">
        <Button
          type="button"
          class="assistant-dock-choices-use"
          disabled={!previewed || previewed === set.original?.id}
          onclick={() => oncommit?.(set.id)}
        >
          {set.commitLabel}
        </Button>
        <Button type="button" variant="ghost" onclick={() => cancel(set)}>
          {set.cancelLabel}
        </Button>
      </div>
      {#if set.status === 'failed'}
        <p class="assistant-dock-choices-status assistant-dock-choices-error" role="alert">
          {t(M['chat.assistant_dock.choices_failed'], { message: set.error ?? '' })}
        </p>
      {/if}
    {:else if set.status === 'waiting'}
      <div class="assistant-dock-choices-actions">
        <span>{set.options.length > 0 ? t(M['chat.assistant_dock.choices_pick']) : ''}</span>
        <Button type="button" size="sm" variant="ghost" onclick={() => ondismiss(set.id)}>
          {t(M['chat.assistant_dock.choices_none'])}
        </Button>
      </div>
    {:else if set.status === 'applying'}
      <p class="assistant-dock-choices-status" role="status">{t(M['chat.assistant_dock.choices_applying'])}</p>
    {:else if set.status === 'applied'}
      <p class="assistant-dock-choices-status" role="status">
        {set.outcome ?? t(M['chat.assistant_dock.choices_applied'], { label: chosen?.label ?? '' })}
      </p>
    {:else if set.status === 'failed' && !preview}
      <p class="assistant-dock-choices-status assistant-dock-choices-error" role="alert">
        {t(M['chat.assistant_dock.choices_failed'], { message: set.error ?? '' })}
      </p>
    {:else if set.status === 'unavailable'}
      <div class="assistant-dock-choices-actions">
        <p class="assistant-dock-choices-status assistant-dock-choices-error" role="alert">
          {t(M['chat.assistant_dock.choices_unavailable'], { message: set.error ?? '' })}
        </p>
        <Button type="button" size="sm" variant="ghost" onclick={() => ondismiss(set.id)}>
          {t(M['chat.assistant_dock.choices_none'])}
        </Button>
      </div>
    {/if}
  </div>
{/each}

<style>
  .assistant-dock-choices {
    display: grid;
    gap: 0.5rem;
    margin: 0.5rem 0;
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: 0.75rem;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
  }

  .assistant-dock-choices-title {
    margin: 0;
    font-weight: 600;
  }

  .assistant-dock-choice-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .assistant-dock-choice {
    display: grid;
    gap: 0.25rem;
    align-content: start;
    width: 100%;
    min-height: 44px;
    padding: 0.35rem;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: 0.6rem;
    background: var(--smrt-color-surface, #fff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .assistant-dock-choice:hover:not(:disabled),
  .assistant-dock-choice:focus-visible {
    border-color: var(--smrt-color-primary, #3558d6);
  }

  .assistant-dock-choice.chosen {
    border-color: var(--smrt-color-primary, #3558d6);
    background: var(--smrt-color-primary-container, #dde3ff);
  }

  .assistant-dock-choice:disabled:not(.chosen) {
    opacity: 0.55;
    cursor: default;
  }

  .assistant-dock-choice img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: 0.4rem;
    background: var(--smrt-color-surface-container, #eceef4);
  }

  .assistant-dock-choice-label {
    font-size: 0.85rem;
    font-weight: 600;
  }

  .assistant-dock-choice-description {
    color: var(--smrt-color-on-surface-variant, #44474e);
    font-size: 0.78rem;
  }

  .assistant-dock-choices-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.85rem;
  }

  /* The buttons stay in view while the cards scroll. */
  .assistant-dock-choices-commit {
    position: sticky;
    inset-block-end: 0;
    padding-block: 0.25rem;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
  }

  .assistant-dock-choices-commit :global(button) {
    min-block-size: 44px;
  }

  .assistant-dock-choices-commit :global(.assistant-dock-choices-use) {
    flex: 1 1 auto;
  }

  .assistant-dock-choices-status {
    margin: 0;
    font-size: 0.85rem;
  }

  .assistant-dock-choices-error {
    color: var(--smrt-color-error, #b3261e);
  }

  .assistant-dock-choice-pending {
    display: grid;
    gap: 0.25rem;
    align-content: start;
    min-height: 44px;
    padding: 0.35rem;
    border: 2px dashed var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: 0.6rem;
    color: var(--smrt-color-on-surface-variant, #44474e);
  }

  .assistant-dock-choice-placeholder {
    width: 100%;
    aspect-ratio: 4 / 3;
    border-radius: 0.4rem;
    background: var(--smrt-color-surface-container, #eceef4);
    animation: assistant-dock-choice-pulse 1.4s ease-in-out infinite;
  }

  @keyframes assistant-dock-choice-pulse {
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .assistant-dock-choice-placeholder {
      animation: none;
    }
  }

</style>
