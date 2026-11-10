<script lang="ts">
/**
 * SearchMessages - Message search interface with results list
 * Provides a search input and displays matching messages
 */
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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

const hasResults = $derived(results.length > 0);
const hasQuery = $derived(query.trim().length > 0);

// The Input primitive doesn't expose its inner element, so resolve it by id.
function focusSearchInput() {
  if (typeof document === 'undefined') return;
  document.getElementById('search-messages-input')?.focus();
}

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
    '<mark class="smrt-search-messages__highlight">$1</mark>',
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
  if (isOpen) {
    // Defer a frame so the search input is mounted before focusing.
    const raf = requestAnimationFrame(focusSearchInput);
    return () => cancelAnimationFrame(raf);
  }
});
</script>

{#if isOpen}
  <div
    class="smrt-search-messages__root"
    role="search"
    aria-label={t(M['chat.search_messages.search'])} data-smrt-component="SearchMessages"
  >
    <div class="smrt-search-messages__header" data-smrt-part="header">
      <h2 class="smrt-search-messages__title" data-smrt-part="title">{t(M['chat.search_messages.title'])}</h2>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onclick={handleClose}
        aria-label={t(M['chat.search_messages.close'])}
      >
        <svg class="smrt-search-messages__close-icon" data-smrt-part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </Button>
    </div>

    <Form
      onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
    >
      <div class="smrt-search-messages__input-wrap" data-smrt-part="input">
        <svg class="smrt-search-messages__search-icon" data-smrt-part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <Input
          bind:value={query}
          id="search-messages-input"
          type="search"
          placeholder={t(M['chat.search_messages.input_placeholder'])}
          autocomplete="off"
          aria-label={t(M['chat.search_messages.query'])}
        />
        {#if hasQuery}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onclick={() => { query = ''; focusSearchInput(); }}
            aria-label={t(M['chat.search_messages.clear'])}
          >
            <svg class="smrt-search-messages__clear-icon" data-smrt-part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </Button>
        {/if}
      </div>
    </Form>

    <div class="smrt-search-messages__results" data-smrt-part="body" aria-label={t(M['chat.search_messages.results'])}>
      {#if hasResults}
        <p class="smrt-search-messages__count" data-smrt-part="count">
          {t(M['chat.search_messages.results_count'], { count: results.length, plural: results.length !== 1 ? 's' : '' })}
        </p>
        <ul class="smrt-search-messages__list" data-smrt-part="list" aria-label={t(M['chat.search_messages.results'])}>
          {#each results as message (message.id)}
            <li class="smrt-search-messages__item" data-smrt-part="item">
              <!-- raw-primitive-allow: large pressable search-result card wrapping rich content (avatar, sender, date, multi-line highlighted message excerpt); no Button primitive owns this structural selection-card pattern -->
              <button
                class="smrt-search-messages__result"
                data-smrt-part="result"
                type="button"
                onclick={() => onselectresult?.(message.id)}
              >
                <div class="smrt-search-messages__result-header" data-smrt-part="result-header">
                  {#if message.senderAvatarUrl}
                    <img class="smrt-search-messages__avatar" data-smrt-part="avatar" src={message.senderAvatarUrl} alt="" />
                  {:else}
                    <span class="smrt-search-messages__avatar-placeholder" data-smrt-part="avatar">
                      {message.senderName.charAt(0).toUpperCase()}
                    </span>
                  {/if}
                  <span class="smrt-search-messages__sender" data-smrt-part="label">{message.senderName}</span>
                  <span class="smrt-search-messages__date" data-smrt-part="time">{formatDate(message.createdAt)}</span>
                </div>
                <p class="smrt-search-messages__message" data-smrt-part="message">
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
        <div class="smrt-search-messages__empty" data-smrt-part="empty" role="status">
          <p class="smrt-search-messages__empty-text" data-smrt-part="message">{t(M['chat.search_messages.no_results'], { query })}</p>
          <p class="smrt-search-messages__empty-hint" data-smrt-part="hint">{t(M['chat.search_messages.no_results_hint'])}</p>
        </div>
      {:else}
        <div class="smrt-search-messages__empty" data-smrt-part="empty" role="status">
          <p class="smrt-search-messages__empty-text" data-smrt-part="message">{t(M['chat.search_messages.empty'])}</p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-search-messages__root {
    display: flex;
    flex-direction: column;
    width: 320px;
    height: 100%;
    overflow: hidden;
  }
  .smrt-search-messages__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
  }
  .smrt-search-messages__title {
    margin: 0;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-search-messages__header :global([data-smrt-component="Button"]) {
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
  }
  .smrt-search-messages__close-icon {
    width: 1rem;
    height: 1rem;
  }
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  .smrt-search-messages__root :global([data-smrt-component="Form"]) {
    padding: 0.75rem 1rem;
  }
  .smrt-search-messages__input-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
  }
  .smrt-search-messages__search-icon {
    flex-shrink: 0;
    width: 1.125rem;
    height: 1.125rem;
  }
  /* The Input primitive sits inside the bordered .smrt-search-messages__input-wrap, which owns
  the border + focus-within ring — so neutralize the primitive's own chrome
  (border/background/padding/box-shadow) and let it render borderless. */
  .smrt-search-messages__input-wrap :global([data-smrt-component="Input"]) {
    flex: 1;
    padding: 0;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-search-messages__input-wrap :global([data-smrt-component="Button"]) {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
  }
  .smrt-search-messages__clear-icon {
    width: 0.875rem;
    height: 0.875rem;
  }
  .smrt-search-messages__results {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }
  .smrt-search-messages__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-search-messages__item {
    margin: 0;
    padding: 0;
  }
  .smrt-search-messages__count {
    margin: 0;
    padding: 0.375rem 1rem;
  }
  .smrt-search-messages__result {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    padding: 0.75rem 1rem;
    cursor: pointer;
  }
  .smrt-search-messages__result-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .smrt-search-messages__avatar {
    width: 1.25rem;
    height: 1.25rem;
    object-fit: cover;
  }
  .smrt-search-messages__avatar-placeholder {
    width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-search-messages__date {
    margin-left: auto;
  }
  .smrt-search-messages__message {
    margin: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .smrt-search-messages__message :global(.smrt-search-messages__highlight) {
    padding: 0 0.125rem;
  }
  .smrt-search-messages__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 2rem 1rem;
  }
  .smrt-search-messages__empty-text {
    margin: 0;
  }
  .smrt-search-messages__empty-hint {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-search-messages__root {
    background: var(--smrt-color-surface);
    border-left: var(--smrt-hairline);
  }
  .smrt-search-messages__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-search-messages__title {
    font: var(--smrt-typography-title-small-font, 600 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-search-messages__header :global([data-smrt-component="Button"]) {
    background: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface-variant);
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-search-messages__header :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-variant);
  }
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  .smrt-search-messages__root :global([data-smrt-component="Form"]) {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-search-messages__input-wrap {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-large, 1rem);
    background: var(--smrt-color-surface-container);
    transition: border-color var(--smrt-duration-short2, 150ms);
  }
  .smrt-search-messages__input-wrap:focus-within {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 1px var(--smrt-color-primary);
  }
  .smrt-search-messages__search-icon {
    color: var(--smrt-color-on-surface-variant);
  }
  /* The Input primitive sits inside the bordered .smrt-search-messages__input-wrap, which owns
  the border + focus-within ring — so neutralize the primitive's own chrome
  (border/background/padding/box-shadow) and let it render borderless. */
  .smrt-search-messages__input-wrap :global([data-smrt-component="Input"]) {
    border: none;
    outline: none;
    background: transparent;
    box-shadow: none;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-search-messages__input-wrap :global([data-smrt-component="Input"]:focus) {
    border: none;
    outline: none;
    box-shadow: none;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-search-messages__input-wrap :global([data-smrt-component="Button"]) {
    background: none;
    border-radius: var(--smrt-radius-full);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-search-messages__input-wrap :global([data-smrt-component="Button"]:hover) {
    background: none;
    color: var(--smrt-color-on-surface);
  }
  .smrt-search-messages__count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .smrt-search-messages__result {
    border: none;
    background: none;
    text-align: left;
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-search-messages__result:hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-search-messages__result:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-search-messages__avatar {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-search-messages__avatar-placeholder {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }
  .smrt-search-messages__sender {
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-search-messages__date {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-search-messages__message {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-search-messages__message :global(.smrt-search-messages__highlight) {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-search-messages__empty {
    text-align: center;
  }
  .smrt-search-messages__empty-text {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-search-messages__empty-hint {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-outline);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-search-messages__result,
    .smrt-search-messages__input-wrap {
      transition: none;
    }
    .smrt-search-messages__header :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
