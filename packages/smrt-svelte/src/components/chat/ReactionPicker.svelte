<script lang="ts">
/**
 * ReactionPicker — a labelled group of emoji reaction buttons.
 *
 * Each button has a text accessible name (so the emoji isn't announced as raw
 * glyphs), and the group carries an `aria-label`. Fires `onpick(emoji)` on
 * activation.
 */
export interface Props {
  /** Emoji set to offer. */
  emojis?: string[];
  /** Accessible label for the group. */
  label?: string;
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
  label = 'Add reaction',
  onpick,
}: Props = $props();
</script>

<div class="reactions" role="group" aria-label={label}>
  {#each emojis as emoji (emoji)}
    <button
      type="button"
      class="reactions__btn"
      aria-label={EMOJI_LABELS[emoji] ?? `React with ${emoji}`}
      onclick={() => onpick?.(emoji)}
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
  {/each}
</div>

<style>
  .reactions {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-full, 9999px);
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
