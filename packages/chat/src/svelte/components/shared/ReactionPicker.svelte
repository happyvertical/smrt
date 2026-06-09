<script lang="ts">
/**
 * ReactionPicker - Emoji reaction selector
 * Compact popup grid of common emojis.
 */

export interface Props {
  /** Callback when an emoji is selected */
  onreact: (emoji: string) => void;
  /** Whether the picker is visible */
  isOpen?: boolean;
}

const { onreact, isOpen = false }: Props = $props();

const emojis = [
  '\u{1F44D}',
  '\u{1F44E}',
  '\u{2764}\u{FE0F}',
  '\u{1F602}',
  '\u{1F62E}',
  '\u{1F622}',
  '\u{1F525}',
  '\u{1F389}',
  '\u{1F44F}',
  '\u{1F914}',
  '\u{1F60D}',
  '\u{1F680}',
  '\u{1F440}',
  '\u{2705}',
  '\u{274C}',
  '\u{1F4AF}',
];

function handleSelect(emoji: string) {
  onreact(emoji);
}

function handleKeydown(event: KeyboardEvent, emoji: string) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleSelect(emoji);
  }
}
</script>

{#if isOpen}
  <div class="reaction-picker" role="grid" aria-label="Emoji reactions">
    {#each emojis as emoji}
      <button
        class="reaction-picker__item"
        type="button"
        onclick={() => handleSelect(emoji)}
        aria-label="React with {emoji}"
      >
        {emoji}
      </button>
    {/each}
  </div>
{/if}

<style>
  .reaction-picker {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-2, 0.375rem);
    background: var(--smrt-color-surface, #ffffff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    box-shadow: var(--smrt-elevation-level2, 0 2px 6px rgba(0, 0, 0, 0.15));
    width: max-content;
  }

  .reaction-picker__item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    cursor: pointer;
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
    line-height: 1;
    padding: 0;
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .reaction-picker__item:hover {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .reaction-picker__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }
</style>
