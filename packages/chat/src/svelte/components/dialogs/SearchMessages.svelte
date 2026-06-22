<script lang="ts">
/**
 * SearchMessages - Message search interface with results list
 * Provides a search input and displays matching messages
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';
import type { ChatMessageData } from '../../types.js';

const { t } = useI18n();

export interface Props {
  /** Whether the search panel is open */
  isOpen: boolean;
  /** Callback to close the search panel */
  onclose: () => void;
  /** Callback when a search query is submitted */
  onsearch: (query: string) => void;
  /** Search results */
  results: ChatMessageData[];
  /** Callback when a result is selected */
  onselectresult?: (messageId: string) => void;
}

let { isOpen, onclose, onsearch, results, onselectresult }: Props = $props();

let query = $state('');
let searchInput = $state<HTMLInputElement | null>(null);

const hasResults = $derived(results.length > 0);
const hasQuery = $derived(query.trim().length > 0);

function handleSubmit() {
  const trimmed = query.trim();
  if (trimmed.length > 0) {
    onsearch(trimmed);
  }
}

function handleClose() {
  query = '';
  onclose();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    handleClose();
  }
}

function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function highlightMatch(text: string, search: string): string {
  const safe = escapeHtml(text);
  if (!search.trim()) return safe;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(
    new RegExp(`(${escaped})`, 'gi'),
    '<mark class="highlight">$1</mark>',
  );
}

$effect(() => {
  if (!isOpen || typeof window === 'undefined') {
    return;
  }

  const onWindowKeydown = (event: KeyboardEvent) => {
    handleKeydown(event);
  };

  window.addEventListener('keydown', onWindowKeydown);
  return () => {
    window.removeEventListener('keydown', onWindowKeydown);
  };
});

$effect(() => {
  if (isOpen && searchInput) {
    searchInput.focus();
  }
});
</script>

{#if isOpen}
  <div
    class="search-panel"
    role="search"
    aria-label={t(M['chat.search_messages.search'])}
  >
    <div class="search-panel__header">
      <h2 class="search-panel__title">{t(M['chat.search_messages.title'])}</h2>
      <button
        class="close-btn"
        type="button"
        onclick={handleClose}
        aria-label={t(M['chat.search_messages.close'])}
      >
        <svg class="close-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>

    <form
      class="search-form"
      onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
    >
      <div class="search-input-wrap">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          bind:this={searchInput}
          bind:value={query}
          type="search"
          class="search-input"
          placeholder={t(M['chat.search_messages.input_placeholder'])}
          autocomplete="off"
          aria-label={t(M['chat.search_messages.query'])}
        />
        {#if hasQuery}
          <button
            class="clear-btn"
            type="button"
            onclick={() => { query = ''; searchInput?.focus(); }}
            aria-label={t(M['chat.search_messages.clear'])}
          >
            <svg class="clear-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        {/if}
      </div>
    </form>

    <div class="search-results" aria-label={t(M['chat.search_messages.results'])}>
      {#if hasResults}
        <p class="results-count">
          {t(M['chat.search_messages.results_count'], { count: results.length, plural: results.length !== 1 ? 's' : '' })}
        </p>
        <ul class="results-list" aria-label={t(M['chat.search_messages.results'])}>
          {#each results as message (message.id)}
            <li class="results-list__item">
              <button
                class="result-item"
                type="button"
                onclick={() => onselectresult?.(message.id)}
              >
                <div class="result-item__header">
                  {#if message.senderAvatarUrl}
                    <img class="result-item__avatar" src={message.senderAvatarUrl} alt="" />
                  {:else}
                    <span class="result-item__avatar-placeholder">
                      {message.senderName.charAt(0).toUpperCase()}
                    </span>
                  {/if}
                  <span class="result-item__sender">{message.senderName}</span>
                  <span class="result-item__date">{formatDate(message.createdAt)}</span>
                </div>
                <p class="result-item__content">
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  {@html highlightMatch(
                    message.content.length > 200
                      ? message.content.slice(0, 200) + '...'
                      : message.content,
                    query
                  )}
                </p>
              </button>
            </li>
          {/each}
        </ul>
      {:else if hasQuery}
        <div class="search-empty" role="status">
          <p class="search-empty__text">{t(M['chat.search_messages.no_results'], { query })}</p>
          <p class="search-empty__hint">{t(M['chat.search_messages.no_results_hint'])}</p>
        </div>
      {:else}
        <div class="search-empty" role="status">
          <p class="search-empty__text">{t(M['chat.search_messages.empty'])}</p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .search-panel {
    display: flex;
    flex-direction: column;
    width: 320px;
    height: 100%;
    background: var(--smrt-color-surface, #fefbff);
    border-left: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    overflow: hidden;
  }

  .search-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .search-panel__title {
    margin: 0;
    font: var(--smrt-typography-title-small-font, 600 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    background: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .close-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .close-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .close-btn__icon {
    width: 1rem;
    height: 1rem;
  }

  .search-form {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .search-input-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--smrt-color-outline, #74777f);
    border-radius: var(--smrt-radius-large, 1rem);
    background: var(--smrt-color-surface-container, #f0f0f4);
    transition: border-color var(--smrt-duration-short2, 150ms);
  }

  .search-input-wrap:focus-within {
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 1px var(--smrt-color-primary, #005ac1);
  }

  .search-icon {
    flex-shrink: 0;
    width: 1.125rem;
    height: 1.125rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .search-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .search-input::placeholder {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .clear-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: none;
    border-radius: var(--smrt-radius-full, 9999px);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
  }

  .clear-btn:hover {
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .clear-btn__icon {
    width: 0.875rem;
    height: 0.875rem;
  }

  .search-results {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .results-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .results-list__item {
    margin: 0;
    padding: 0;
  }

  .results-count {
    margin: 0;
    padding: 0.375rem 1rem;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .result-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .result-item:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .result-item:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .result-item__header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .result-item__avatar {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--smrt-radius-full, 9999px);
    object-fit: cover;
  }

  .result-item__avatar-placeholder {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }

  .result-item__sender {
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .result-item__date {
    margin-left: auto;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .result-item__content {
    margin: 0;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .result-item__content :global(.highlight) {
    background: var(--smrt-color-tertiary-container, #c2f0dd);
    color: var(--smrt-color-on-tertiary-container, #002114);
    border-radius: var(--smrt-radius-sm, 4px);
    padding: 0 0.125rem;
  }

  .search-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 2rem 1rem;
    text-align: center;
  }

  .search-empty__text {
    margin: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .search-empty__hint {
    margin: 0;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  @media (prefers-reduced-motion: reduce) {
    .close-btn,
    .result-item,
    .search-input-wrap {
      transition: none;
    }
  }
</style>
