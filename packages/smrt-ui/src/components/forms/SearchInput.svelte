<script lang="ts">
/**
 * SearchInput — the search box of a list's filter bar.
 *
 * It searches as you type (`debounceMs` after the last key; Enter searches at
 * once) and reports the trimmed, single-line text through `onsearch`. The page
 * keeps the applied search (a `?q=` URL parameter, say) and passes it back as
 * `value`; the box follows it, so Back, a filter link or an agent's search
 * update the text, and a search the box itself sent never undoes newer typing.
 * The × clears it. The label ("Search") is read by screen readers; the
 * placeholder says what the search matches. The field is a 44px target and
 * 16px on phones so iOS does not zoom when it gets focus.
 */
import { onDestroy } from 'svelte';
import Input from './Input.svelte';

export interface Props {
  /** The search the list is showing (from the URL or the page's state). */
  value: string;
  /** Called with the trimmed, single-line text (`''` to clear). */
  onsearch: (query: string) => void | Promise<void>;
  /** Placeholder text: what the search matches. */
  placeholder?: string;
  /** Accessible name of the field. */
  label?: string;
  /** Accessible name of the clear button. */
  clearLabel?: string;
  /** Pause after the last key before searching, in milliseconds. */
  debounceMs?: number;
  /** Form field name. */
  name?: string;
  /** Additional CSS class names on the wrapper. */
  class?: string;
}

const {
  value,
  onsearch,
  placeholder = 'Search',
  label = 'Search',
  clearLabel = 'Clear search',
  debounceMs = 300,
  name = 'q',
  class: className = '',
}: Props = $props();

const instanceId = $props.id();
const inputId = `smrt-search-${instanceId}`;
let text = $state('');
let timer: ReturnType<typeof setTimeout> | null = null;
/** The search this box last sent; its own round trip must not undo newer typing. */
let sent: string | null = null;

// Follow the applied search (back/forward, a filter link, an agent's search).
$effect(() => {
  const next = value;
  if (sent !== null && next === sent) {
    sent = null;
    return;
  }
  text = next;
});

function normalized(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function cancel() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function search(raw: string) {
  cancel();
  const query = normalized(raw);
  if (query === normalized(value)) return;
  sent = query;
  void onsearch(query);
}

function handleInput() {
  cancel();
  timer = setTimeout(() => search(text), debounceMs);
}

function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  search(text);
}

function clear() {
  text = '';
  search('');
  document.getElementById(inputId)?.focus();
}

onDestroy(cancel);
</script>

<form class="search-input {className}" role="search" onsubmit={handleSubmit}>
  <label class="search-input__label" for={inputId}>{label}</label>
  <span class="search-input__icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  </span>
  <Input
    id={inputId}
    type="search"
    {name}
    {placeholder}
    enterkeyhint="search"
    autocomplete="off"
    class="search-input__field"
    bind:value={text}
    oninput={handleInput}
  />
  {#if text}
    <button type="button" class="search-input__clear" aria-label={clearLabel} onclick={clear}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
    </button>
  {/if}
</form>

<style>
  .search-input {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 16rem;
    max-inline-size: 28rem;
    min-inline-size: 0;
  }
  .search-input__label {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  .search-input :global(.search-input__field) {
    inline-size: 100%;
    min-block-size: 2.75rem;
    padding-inline: 2.4rem 2.75rem;
  }
  /* The browser's own clear button would sit on top of ours. */
  .search-input :global(.search-input__field::-webkit-search-cancel-button) {
    -webkit-appearance: none;
    appearance: none;
  }
  .search-input__icon {
    position: absolute;
    inset-inline-start: 0.8rem;
    z-index: 1;
    display: inline-flex;
    color: var(--smrt-color-on-surface-variant);
    pointer-events: none;
  }
  .search-input__clear {
    position: absolute;
    inset-inline-end: 0;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    padding: 0;
    border: none;
    border-radius: var(--smrt-radius-full, 999px);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }
  .search-input__clear:hover {
    color: var(--smrt-color-on-surface);
  }
  .search-input__clear:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  /* Phones: full width. */
  @media (max-width: 48rem) {
    .search-input {
      flex-basis: 100%;
      max-inline-size: none;
    }
  }
</style>
