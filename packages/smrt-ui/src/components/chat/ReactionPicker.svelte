<script lang="ts">
/**
 * ReactionPicker — a labelled group of emoji reaction buttons.
 *
 * Each button carries a text accessible name (so the emoji isn't announced as
 * raw glyphs) and the group carries an `aria-label`. Fires `onpick(emoji)` on
 * activation. The group label and the fallback name for unrecognised emoji
 * default to translated `ui.reaction_picker.*` strings; the common reactions use
 * built-in English names unless a caller supplies `emojiLabel` (e.g. to route
 * every label through a domain i18n catalog). Wraps gracefully for larger emoji
 * sets.
 */
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';

export interface Props {
  /** Emoji set to offer. */
  emojis?: string[];
  /** Accessible label for the group. Defaults to a translated "Add reaction". */
  label?: string;
  /**
   * Accessible name for each emoji button. Defaults to a built-in name for the
   * common reactions, else a translated "React with {emoji}".
   */
  emojiLabel?: (emoji: string) => string;
  /** Whether the picker is shown. */
  isOpen?: boolean;
  /** Fired with the chosen emoji. */
  onpick?: (emoji: string) => void;
}

const DEFAULT_EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢'];
const EMOJI_LABELS: Record<string, string> = {
  '👍': 'Thumbs up',
  '❤️': 'Heart',
  '😂': 'Laugh',
  '🎉': 'Celebrate',
  '😮': 'Surprised',
  '😢': 'Sad',
};

const {
  emojis = DEFAULT_EMOJIS,
  label,
  emojiLabel,
  isOpen = true,
  onpick,
}: Props = $props();

const { t } = useI18n();

const groupLabel = $derived(label ?? t(M['ui.reaction_picker.label']));

function nameFor(emoji: string): string {
  return (
    emojiLabel?.(emoji) ??
    EMOJI_LABELS[emoji] ??
    t(M['ui.reaction_picker.react_with'], { emoji })
  );
}
</script>

{#if isOpen}
  <div class="reactions" role="group" aria-label={groupLabel}>
    {#each emojis as emoji (emoji)}
      <button
        type="button"
        class="reactions__btn"
        aria-label={nameFor(emoji)}
        onclick={() => onpick?.(emoji)}
      >
        <span aria-hidden="true">{emoji}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .reactions {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 4px);
    max-width: 16rem;
    border-radius: var(--smrt-radius-large, 12px);
    background: var(--smrt-color-surface-container, #f3edf7);
  }

  .reactions__btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: var(--smrt-radius-full, 9999px);
    background: none;
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    line-height: 1;
    cursor: pointer;
    transition: transform 0.1s ease, background 0.1s ease;
  }
  .reactions__btn:hover {
    background: var(--smrt-color-surface-container-highest, #e6e0e9);
    transform: scale(1.15);
  }
  .reactions__btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 1px;
  }

  @media (prefers-reduced-motion: reduce) {
    .reactions__btn {
      transition: none;
    }
    .reactions__btn:hover {
      transform: none;
    }
  }
</style>
