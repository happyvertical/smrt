<script lang="ts">
/**
 * SMRTSearchInput - A search input with built-in functionality
 *
 * Features:
 * - Search icon
 * - Clear button
 * - Optional debounce
 * - Loading state
 * - Keyboard shortcuts
 * - Material 3 styling
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.forms.js';

const { t } = useI18n();

export interface Props {
  /** Current search value */
  value?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Debounce delay in ms (0 for no debounce) */
  debounce?: number;
  /** Show loading indicator */
  loading?: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** ID for the input element */
  id?: string;
  /** Name attribute */
  name?: string;
  /** ARIA label */
  ariaLabel?: string;
  /** Callback when value changes (after debounce) */
  onsearch?: (value: string) => void;
  /** Callback for immediate value changes */
  oninput?: (value: string) => void;
  /** Callback when Enter is pressed */
  onsubmit?: (value: string) => void;
}

let {
  value = $bindable(''),
  placeholder = 'Search...',
  debounce = 300,
  loading = false,
  disabled = false,
  size = 'md',
  id,
  name,
  ariaLabel = 'Search',
  onsearch,
  oninput,
  onsubmit,
}: Props = $props();

let inputEl: HTMLInputElement | null = $state(null);
let debounceTimer: ReturnType<typeof setTimeout> | null = $state(null);

// Cleanup debounce timer on component destroy
$effect(() => {
  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  };
});

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement;
  value = target.value;
  oninput?.(value);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (debounce > 0) {
    debounceTimer = setTimeout(() => {
      onsearch?.(value);
    }, debounce);
  } else {
    onsearch?.(value);
  }
}

function handleClear() {
  value = '';
  oninput?.('');
  onsearch?.('');
  inputEl?.focus();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    // Cancel pending debounce and fire immediately
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    onsearch?.(value);
    onsubmit?.(value);
  } else if (event.key === 'Escape') {
    if (value) {
      event.preventDefault();
      handleClear();
    }
  }
}

/** Focus the search input programmatically */
export function focus() {
  inputEl?.focus();
}

/** Clear and focus the search input */
export function clear() {
  handleClear();
}

const sizeClasses = {
  sm: 'smrt-search-input__sm',
  md: 'smrt-search-input__md',
  lg: 'smrt-search-input__lg',
};
</script>

<div
  class="smrt-search-input__root {sizeClasses[size]}"
  class:smrt-search-input__disabled={disabled}
  class:smrt-search-input__loading={loading} data-smrt-component="SearchInput"
>
  <span class="smrt-search-input__icon" data-smrt-part="icon" aria-hidden="true">
    {#if loading}
      <svg
        class="smrt-search-input__spinner"
        data-smrt-part="spinner"
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="32">
          <animate
            attributeName="stroke-dashoffset"
            values="32;0"
            dur="1s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
    {:else}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
    {/if}
  </span>

  <input
    bind:this={inputEl}
    type="search"
    class="smrt-search-input__field"
    data-smrt-part="input"
    {id}
    {name}
    {placeholder}
    {disabled}
    {value}
    oninput={handleInput}
    onkeydown={handleKeydown}
    aria-label={ariaLabel}
  />

  {#if value && !disabled}
    <button
      type="button"
      class="smrt-search-input__clear"
      data-smrt-part="close"
      onclick={handleClear}
      aria-label={t(M['ui.search_input.clear_aria_label'])}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-search-input__root {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }
  .smrt-search-input__disabled {
    cursor: not-allowed;
  }
  .smrt-search-input__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .smrt-search-input__field {
    flex: 1;
    width: 100%;
  }
  /* Hide default search clear button */
  .smrt-search-input__field::-webkit-search-cancel-button {
    display: none;
  }
  .smrt-search-input__clear {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    cursor: pointer;
  }
  /* Size: Small */
  .smrt-search-input__sm {
    height: 32px;
  }
  .smrt-search-input__sm .smrt-search-input__icon {
    padding-left: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-search-input__sm .smrt-search-input__field {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-search-input__sm .smrt-search-input__clear {
    width: 24px;
    height: 24px;
    margin-right: var(--smrt-spacing-1, 0.25rem);
  }
  /* Size: Medium (default) */
  .smrt-search-input__md {
    height: 40px;
  }
  .smrt-search-input__md .smrt-search-input__icon {
    padding-left: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-search-input__md .smrt-search-input__field {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-search-input__md .smrt-search-input__clear {
    width: 28px;
    height: 28px;
    margin-right: var(--smrt-spacing-2, 0.5rem);
  }
  /* Size: Large */
  .smrt-search-input__lg {
    height: 48px;
  }
  .smrt-search-input__lg .smrt-search-input__icon {
    padding-left: var(--smrt-spacing-4, 1rem);
  }
  .smrt-search-input__lg .smrt-search-input__field {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-search-input__lg .smrt-search-input__clear {
    width: 32px;
    height: 32px;
    margin-right: var(--smrt-spacing-3, 0.75rem);
  }
}

@layer smrt.theme {
  .smrt-search-input__root {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md, 0.5rem);
    transition: all var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-search-input__root:focus-within {
    background: var(--smrt-color-surface);
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 3px var(--smrt-color-primary-container, rgba(0, 90, 193, 0.1));
  }
  .smrt-search-input__disabled {
    opacity: 0.5;
  }
  .smrt-search-input__icon {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-search-input__spinner {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .smrt-search-input__field {
    border: none;
    background: transparent;
    font-family: inherit;
    color: var(--smrt-color-on-surface);
    outline: none;
  }
  .smrt-search-input__field::placeholder {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-search-input__clear {
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-full);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-search-input__clear:hover {
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container);
  }
  .smrt-search-input__clear:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  /* Size: Small */
  .smrt-search-input__sm {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  /* Size: Medium (default) */
  .smrt-search-input__md {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  /* Size: Large */
  .smrt-search-input__lg {
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
}

</style>
