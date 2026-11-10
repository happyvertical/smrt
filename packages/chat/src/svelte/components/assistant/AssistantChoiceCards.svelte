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
  {@const previewing = preview && set.previewPendingId !== undefined}
  {@const cards = preview && set.original ? [set.original, ...set.options] : set.options}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="smrt-assistant-choice-cards__root"
    role="group"
    aria-label={set.title}
    aria-busy={making ? 'true' : undefined}
    onkeydown={(event) => onkeydown(event, set)} data-smrt-component="AssistantChoiceCards"
  >
    <p class="smrt-assistant-choice-cards__title" data-smrt-part="title">{set.title}</p>
    {#if making}
      <p class="smrt-assistant-choice-cards__status smrt-assistant-choice-cards__making" data-smrt-part="status" role="status">{making.message}</p>
    {/if}
    {#if !(preview && set.status === 'applied')}
    <ul class="smrt-assistant-choice-cards__list" data-smrt-part="list">
      {#each cards as option (option.id)}
        <li>
          <!-- raw-primitive-allow: a picture card that is itself the choice (image, label and description inside one pressable target); Button's single-label layout does not fit -->
          <button
            type="button"
            class="smrt-assistant-choice-cards__card"
            data-smrt-part="option"
            aria-pressed={preview ? previewed === option.id : set.chosenOptionId === option.id}
            aria-busy={previewing && set.previewPendingId === option.id ? 'true' : undefined}
            disabled={!open || previewing}
            onclick={() => (preview ? onpreview?.(set.id, option.id) : onchoose(set.id, option.id))}
  class:smrt-assistant-choice-cards__chosen={preview ? previewed === option.id : set.chosenOptionId === option.id}

          >
            {#if option.imageUrl}
              <img src={option.imageUrl} alt={option.imageAlt ?? option.label} loading="lazy" />
            {/if}
            <span class="smrt-assistant-choice-cards__label" data-smrt-part="label">{option.label}</span>
            {#if option.description}
              <span class="smrt-assistant-choice-cards__description" data-smrt-part="meta">{option.description}</span>
            {/if}
          </button>
        </li>
      {/each}
      {#if making}
        {#each { length: making.expected } as _, index (index)}
          <li class="smrt-assistant-choice-cards__pending" data-smrt-part="pending" aria-hidden="true">
            <span class="smrt-assistant-choice-cards__placeholder" data-smrt-part="placeholder"></span>
            <span class="smrt-assistant-choice-cards__label" data-smrt-part="label">{t(M['chat.assistant_dock.choices_making'])}</span>
          </li>
        {/each}
      {/if}
    </ul>
    {/if}
    {#if set.note && set.status === 'waiting'}
      <p class="smrt-assistant-choice-cards__status" data-smrt-part="status">{set.note}</p>
    {/if}
    {#if preview && open}
      <div class="smrt-assistant-choice-cards__actions smrt-assistant-choice-cards__commit" data-smrt-part="commit">
        <Button
          type="button"
          disabled={previewing || !previewed || previewed === set.original?.id}
          onclick={() => oncommit?.(set.id)}
        >
          {set.commitLabel}
        </Button>
        <Button type="button" variant="ghost" onclick={() => cancel(set)}>
          {set.cancelLabel}
        </Button>
      </div>
      {#if set.status === 'failed'}
        <p class="smrt-assistant-choice-cards__status smrt-assistant-choice-cards__error" data-smrt-part="status" role="alert">
          {t(M['chat.assistant_dock.choices_failed'], { message: set.error ?? '' })}
        </p>
      {/if}
    {:else if set.status === 'waiting'}
      <div class="smrt-assistant-choice-cards__actions" data-smrt-part="actions">
        <span>{set.options.length > 0 ? t(M['chat.assistant_dock.choices_pick']) : ''}</span>
        <Button type="button" size="sm" variant="ghost" onclick={() => ondismiss(set.id)}>
          {t(M['chat.assistant_dock.choices_none'])}
        </Button>
      </div>
    {:else if set.status === 'applying'}
      <p class="smrt-assistant-choice-cards__status" data-smrt-part="status" role="status">{t(M['chat.assistant_dock.choices_applying'])}</p>
    {:else if set.status === 'applied'}
      <p class="smrt-assistant-choice-cards__status" data-smrt-part="status" role="status">
        {set.outcome ?? t(M['chat.assistant_dock.choices_applied'], { label: chosen?.label ?? '' })}
      </p>
    {:else if set.status === 'failed' && !preview}
      <p class="smrt-assistant-choice-cards__status smrt-assistant-choice-cards__error" data-smrt-part="status" role="alert">
        {t(M['chat.assistant_dock.choices_failed'], { message: set.error ?? '' })}
      </p>
    {:else if set.status === 'unavailable'}
      <div class="smrt-assistant-choice-cards__actions" data-smrt-part="actions">
        <p class="smrt-assistant-choice-cards__status smrt-assistant-choice-cards__error" data-smrt-part="status" role="alert">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-assistant-choice-cards__root {
    display: grid;
    gap: 0.5rem;
    margin: 0.5rem 0;
    padding: 0.75rem;
  }
  .smrt-assistant-choice-cards__title {
    margin: 0;
  }
  .smrt-assistant-choice-cards__list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-assistant-choice-cards__card {
    display: grid;
    gap: 0.25rem;
    align-content: start;
    width: 100%;
    min-height: 44px;
    padding: 0.35rem;
    cursor: pointer;
  }
  .smrt-assistant-choice-cards__card:disabled:not(.smrt-assistant-choice-cards__chosen) {
    cursor: default;
  }
  .smrt-assistant-choice-cards__card img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
  }
  .smrt-assistant-choice-cards__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  /* The buttons stay in view while the cards scroll. */
  .smrt-assistant-choice-cards__commit {
    position: sticky;
    inset-block-end: 0;
    padding-block: 0.25rem;
  }
  .smrt-assistant-choice-cards__commit :global(button) {
    min-block-size: 44px;
  }
  .smrt-assistant-choice-cards__commit > :global([data-smrt-component="Button"]:first-of-type) {
    flex: 1 1 auto;
  }
  .smrt-assistant-choice-cards__status {
    margin: 0;
  }
  .smrt-assistant-choice-cards__pending {
    display: grid;
    gap: 0.25rem;
    align-content: start;
    min-height: 44px;
    padding: 0.35rem;
  }
  .smrt-assistant-choice-cards__placeholder {
    width: 100%;
    aspect-ratio: 4 / 3;
  }
}

@layer smrt.theme {
  .smrt-assistant-choice-cards__root {
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-assistant-choice-cards__title {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-assistant-choice-cards__card {
    border: 2px solid var(--smrt-color-outline-variant);
    border-radius: 0.6rem;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
    text-align: left;
  }
  .smrt-assistant-choice-cards__card:hover:not(:disabled),
  .smrt-assistant-choice-cards__card:focus-visible {
    border-color: var(--smrt-color-primary);
  }
  .smrt-assistant-choice-cards__card.smrt-assistant-choice-cards__chosen {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  .smrt-assistant-choice-cards__card:disabled:not(.smrt-assistant-choice-cards__chosen) {
    opacity: 0.55;
  }
  .smrt-assistant-choice-cards__card img {
    border-radius: 0.4rem;
    background: var(--smrt-color-surface-container);
  }
  .smrt-assistant-choice-cards__label {
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-assistant-choice-cards__description {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.78rem);
  }
  .smrt-assistant-choice-cards__actions {
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  /* The buttons stay in view while the cards scroll. */
  .smrt-assistant-choice-cards__commit {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-assistant-choice-cards__status {
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-assistant-choice-cards__error {
    color: var(--smrt-color-error);
  }
  .smrt-assistant-choice-cards__pending {
    border: 2px dashed var(--smrt-color-outline-variant);
    border-radius: 0.6rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-assistant-choice-cards__placeholder {
    border-radius: 0.4rem;
    background: var(--smrt-color-surface-container);
    animation: assistant-dock-choice-pulse 1.4s ease-in-out infinite;
  }
  @keyframes assistant-dock-choice-pulse {
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-assistant-choice-cards__placeholder {
      animation: none;
    }
  }
}

</style>
