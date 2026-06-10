<script lang="ts">
import { getThemeContext } from '../context.svelte.js';
import type { ColorScheme } from '../types.js';

interface Props {
  /** Show labels with icons */
  showLabels?: boolean;
  /** Button variant: 'switch' | 'buttons' | 'segmented' */
  variant?: 'switch' | 'buttons' | 'segmented';
  /** Additional CSS class */
  class?: string;
  /** Accessible label */
  ariaLabel?: string;
}

let {
  showLabels = true,
  variant = 'switch',
  class: className = '',
  ariaLabel = 'Toggle color scheme',
}: Props = $props();

const context = getThemeContext();

function setScheme(scheme: ColorScheme) {
  context.setColorScheme(scheme);
}

function toggle() {
  context.toggleColorScheme();
}

// Icons
const icons = {
  light: '☀️',
  dark: '🌙',
  system: '💻',
};

const labels = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};
</script>

<div class="smrt-color-scheme-toggle {variant} {className}">
  {#if variant === 'switch'}
    <button
      class="smrt-color-scheme-toggle__switch"
      onclick={toggle}
      type="button"
      aria-label={ariaLabel}
      title={labels[context.state.resolvedScheme]}
    >
      {#if context.state.isDark}
        <span class="smrt-color-scheme-toggle__icon">{icons.dark}</span>
      {:else}
        <span class="smrt-color-scheme-toggle__icon">{icons.light}</span>
      {/if}
      {#if showLabels}
        <span class="smrt-color-scheme-toggle__label">
          {labels[context.state.resolvedScheme]}
        </span>
      {/if}
    </button>

  {:else if variant === 'buttons'}
    <div class="smrt-color-scheme-toggle__buttons">
      {#each ['light', 'dark', 'system'] as scheme}
        <button
          class="smrt-color-scheme-toggle__button"
          class:active={context.state.colorScheme === scheme}
          onclick={() => setScheme(scheme as ColorScheme)}
          type="button"
        >
          <span class="smrt-color-scheme-toggle__icon">{icons[scheme as keyof typeof icons]}</span>
          {#if showLabels}
            <span class="smrt-color-scheme-toggle__label">
              {labels[scheme as keyof typeof labels]}
            </span>
          {/if}
        </button>
      {/each}
    </div>

  {:else if variant === 'segmented'}
    <div class="smrt-color-scheme-toggle__segmented" role="radiogroup" aria-label={ariaLabel}>
      {#each ['light', 'dark', 'system'] as scheme}
        <button
          class="smrt-color-scheme-toggle__segment"
          class:active={context.state.colorScheme === scheme}
          onclick={() => setScheme(scheme as ColorScheme)}
          type="button"
          role="radio"
          aria-checked={context.state.colorScheme === scheme}
        >
          <span class="smrt-color-scheme-toggle__icon">
            {icons[scheme as keyof typeof icons]}
          </span>
          {#if showLabels}
            <span class="smrt-color-scheme-toggle__label">
              {labels[scheme as keyof typeof labels]}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .smrt-color-scheme-toggle {
    display: inline-flex;
    align-items: center;
  }

  .smrt-color-scheme-toggle__switch {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border: 1px solid var(--smrt-color-outline, #ccc);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-low, #f5f5f5);
    color: var(--smrt-color-on-surface, inherit);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    cursor: pointer;
    transition: all 200ms ease;
  }

  .smrt-color-scheme-toggle__switch:hover {
    background: var(--smrt-color-surface-container, #eee);
  }

  .smrt-color-scheme-toggle__buttons {
    display: flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .smrt-color-scheme-toggle__button {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-1_5, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    border: 1px solid var(--smrt-color-outline, #ccc);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface-container-low, #f5f5f5);
    color: var(--smrt-color-on-surface, inherit);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    cursor: pointer;
    transition: all 200ms ease;
  }

  .smrt-color-scheme-toggle__button:hover {
    background: var(--smrt-color-surface-container, #eee);
  }

  .smrt-color-scheme-toggle__button.active {
    background: var(--smrt-color-primary-container, #e3f2fd);
    color: var(--smrt-color-on-primary-container, #1565c0);
    border-color: var(--smrt-color-primary, #2196f3);
  }

  .smrt-color-scheme-toggle__segmented {
    display: inline-flex;
    background: var(--smrt-color-surface-container-lowest, #fafafa);
    border: 1px solid var(--smrt-color-outline, #ccc);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    padding: var(--smrt-spacing-0_5, 0.125rem);
  }

  .smrt-color-scheme-toggle__segment {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-1_5, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    border: none;
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #666);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    cursor: pointer;
    transition: all 200ms ease;
  }

  .smrt-color-scheme-toggle__segment:hover {
    color: var(--smrt-color-on-surface, inherit);
  }

  .smrt-color-scheme-toggle__segment.active {
    background: var(--smrt-color-surface, white);
    color: var(--smrt-color-on-surface, inherit);
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgba(0,0,0,0.1));
  }

  .smrt-color-scheme-toggle__icon {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: 1;
  }

  .smrt-color-scheme-toggle__label {
    font-size: inherit;
  }
</style>
