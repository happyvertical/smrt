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
  sm: 'search-input--sm',
  md: 'search-input--md',
  lg: 'search-input--lg',
};
</script>

<div
  class="search-input {sizeClasses[size]}"
  class:search-input--disabled={disabled}
  class:search-input--loading={loading}
>
  <span class="search-input__icon" aria-hidden="true">
    {#if loading}
      <svg
        class="search-input__spinner"
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
    class="search-input__field"
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
      class="search-input__clear"
      onclick={handleClear}
      aria-label="Clear search"
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
  .search-input {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-radius: var(--smrt-radius-md, 0.5rem);
    transition: all var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, ease);
  }

  .search-input:focus-within {
    background: var(--smrt-surface, #ffffff);
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px var(--smrt-color-primary-container, rgba(0, 90, 193, 0.1));
  }

  .search-input--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .search-input__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .search-input__spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .search-input__field {
    flex: 1;
    width: 100%;
    border: none;
    background: transparent;
    font-family: inherit;
    color: var(--smrt-color-on-surface, #111827);
    outline: none;
  }

  .search-input__field::placeholder {
    color: var(--smrt-color-on-surface-variant, #9ca3af);
  }

  /* Hide default search clear button */
  .search-input__field::-webkit-search-cancel-button {
    display: none;
  }

  .search-input__clear {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    cursor: pointer;
    border-radius: var(--smrt-radius-full, 9999px);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .search-input__clear:hover {
    color: var(--smrt-color-on-surface, #111827);
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .search-input__clear:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  /* Size: Small */
  .search-input--sm {
    height: 32px;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .search-input--sm .search-input__icon {
    padding-left: var(--smrt-spacing-2, 0.5rem);
  }

  .search-input--sm .search-input__field {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
  }

  .search-input--sm .search-input__clear {
    width: 24px;
    height: 24px;
    margin-right: var(--smrt-spacing-1, 0.25rem);
  }

  /* Size: Medium (default) */
  .search-input--md {
    height: 40px;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .search-input--md .search-input__icon {
    padding-left: var(--smrt-spacing-3, 0.75rem);
  }

  .search-input--md .search-input__field {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }

  .search-input--md .search-input__clear {
    width: 28px;
    height: 28px;
    margin-right: var(--smrt-spacing-2, 0.5rem);
  }

  /* Size: Large */
  .search-input--lg {
    height: 48px;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }

  .search-input--lg .search-input__icon {
    padding-left: var(--smrt-spacing-4, 1rem);
  }

  .search-input--lg .search-input__field {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
  }

  .search-input--lg .search-input__clear {
    width: 32px;
    height: 32px;
    margin-right: var(--smrt-spacing-3, 0.75rem);
  }
</style>
