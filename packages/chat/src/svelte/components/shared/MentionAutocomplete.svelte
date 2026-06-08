<script lang="ts">
/**
 * MentionAutocomplete - @mention suggestions popup
 * Floating dropdown positioned near cursor. Shows matching profile names
 * with optional avatars. Keyboard navigable.
 */
import Avatar from './Avatar.svelte';

export interface Props {
  /** Current search query (text after @) */
  query: string;
  /** Matching suggestions */
  suggestions: Array<{ id: string; name: string; avatarUrl?: string }>;
  /** Select a suggestion */
  onselect: (id: string) => void;
  /** Whether the popup is visible */
  isVisible: boolean;
}

const { query, suggestions, onselect, isVisible }: Props = $props();

let activeIndex = $state(0);

// Reset active index when suggestions change
$effect(() => {
  if (suggestions.length) {
    activeIndex = 0;
  }
});

function handleKeydown(event: KeyboardEvent) {
  if (!isVisible || suggestions.length === 0) return;

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      activeIndex = (activeIndex + 1) % suggestions.length;
      break;
    case 'ArrowUp':
      event.preventDefault();
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
      break;
    case 'Enter':
    case 'Tab':
      event.preventDefault();
      onselect(suggestions[activeIndex].id);
      break;
    case 'Escape':
      break;
  }
}

function highlightMatch(
  name: string,
  q: string,
): { before: string; match: string; after: string } {
  if (!q) return { before: name, match: '', after: '' };
  const lower = name.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return { before: name, match: '', after: '' };
  return {
    before: name.slice(0, idx),
    match: name.slice(idx, idx + q.length),
    after: name.slice(idx + q.length),
  };
}
</script>

<svelte:window onkeydown={isVisible ? handleKeydown : undefined} />

{#if isVisible && suggestions.length > 0}
  <div
    class="mention-autocomplete"
    role="listbox"
    aria-label="Mention suggestions"
  >
    {#each suggestions as suggestion, i (suggestion.id)}
      {@const parts = highlightMatch(suggestion.name, query)}
      <button
        class="mention-autocomplete__item"
        class:mention-autocomplete__item--active={i === activeIndex}
        type="button"
        role="option"
        aria-selected={i === activeIndex}
        onclick={() => onselect(suggestion.id)}
        onpointerenter={() => activeIndex = i}
      >
        <Avatar
          name={suggestion.name}
          avatarUrl={suggestion.avatarUrl}
          size="sm"
        />
        <span class="mention-autocomplete__name">
          {parts.before}<mark class="mention-autocomplete__highlight">{parts.match}</mark>{parts.after}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .mention-autocomplete {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: var(--smrt-spacing-1, 4px);
    min-width: 200px;
    max-width: 320px;
    max-height: 240px;
    overflow-y: auto;
    background: var(--smrt-color-surface, #fefbff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 8px);
    box-shadow: var(--smrt-elevation-level2, 0 2px 8px rgba(0, 0, 0, 0.15));
    z-index: var(--smrt-z-index-dropdown, 1000);
    padding: var(--smrt-spacing-1, 4px);
    display: flex;
    flex-direction: column;
  }

  .mention-autocomplete__item {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    width: 100%;
    padding: var(--smrt-spacing-2, 8px);
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-radius: var(--smrt-radius-small, 4px);
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .mention-autocomplete__item:hover,
  .mention-autocomplete__item--active {
    background: var(--smrt-color-surface-container-high, #e6e6ea);
  }

  .mention-autocomplete__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .mention-autocomplete__name {
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.25 sans-serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mention-autocomplete__highlight {
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
    font-weight: 600;
  }

  @media (prefers-reduced-motion: reduce) {
    .mention-autocomplete__item {
      transition: none;
    }
  }
</style>
