<script lang="ts">
import { getThemeContext } from '../context.svelte.js';
import { getThemeOptions } from '../registry.js';
import type { ThemePreset } from '../types.js';

interface Props {
  /** Custom label text */
  label?: string;
  /** Show icons for each theme */
  showIcons?: boolean;
  /** Button variant: 'select' | 'buttons' | 'segmented' */
  variant?: 'select' | 'buttons' | 'segmented';
  /** Additional CSS class */
  class?: string;
}

let {
  label = 'Theme',
  showIcons = true,
  variant = 'select',
  class: className = '',
}: Props = $props();

const context = getThemeContext();
const options = getThemeOptions();

function handleChange(event: Event) {
  const select = event.target as HTMLSelectElement;
  context.setPreset(select.value as ThemePreset);
}

function handlePresetClick(preset: ThemePreset) {
  context.setPreset(preset);
}

// Icons for each theme
const themeIcons: Record<ThemePreset, string> = {
  material: '🔷',
  glass: '💎',
  studio: '◻️',
  smrt: '🟠',
  happyvertical: '🔶',
};
</script>

<div class="smrt-theme-switcher__root smrt-theme-switcher__variant-{variant} {className}" data-smrt-component="ThemeSwitcher">
  {#if label}
    <span class="smrt-theme-switcher__label" data-smrt-part="label">{label}</span>
  {/if}

  {#if variant === 'select'}
    <select
      class="smrt-theme-switcher__select" data-smrt-part="trigger"
      value={context.state.preset}
      onchange={handleChange}
    >
      {#each options as option}
        <option value={option.value}>
          {#if showIcons}{themeIcons[option.value]} {/if}
          {option.label}
        </option>
      {/each}
    </select>

  {:else if variant === 'buttons'}
    <div class="smrt-theme-switcher__buttons" data-smrt-part="list">
      {#each options as option}
        <button
          class="smrt-theme-switcher__button" data-smrt-part="trigger"
          class:smrt-theme-switcher__active={context.state.preset === option.value}
          onclick={() => handlePresetClick(option.value)}
          type="button"
        >
          {#if showIcons}
            <span class="smrt-theme-switcher__icon" data-smrt-part="icon">{themeIcons[option.value]}</span>
          {/if}
          <span class="smrt-theme-switcher__text" data-smrt-part="label">{option.label}</span>
        </button>
      {/each}
    </div>

  {:else if variant === 'segmented'}
    <div class="smrt-theme-switcher__segmented" data-smrt-part="list" role="radiogroup">
      {#each options as option}
        <button
          class="smrt-theme-switcher__segment" data-smrt-part="trigger"
          class:smrt-theme-switcher__active={context.state.preset === option.value}
          onclick={() => handlePresetClick(option.value)}
          type="button"
          role="radio"
          aria-checked={context.state.preset === option.value}
        >
          {#if showIcons}
            <span class="smrt-theme-switcher__icon" data-smrt-part="icon">{themeIcons[option.value]}</span>
          {/if}
          <span class="smrt-theme-switcher__text" data-smrt-part="label">{option.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-theme-switcher__root {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-theme-switcher__select {
    padding: var(--smrt-spacing-1_5, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    cursor: pointer;
  }
  .smrt-theme-switcher__buttons {
    display: flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-theme-switcher__button {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-1_5, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    cursor: pointer;
  }
  .smrt-theme-switcher__segmented {
    display: inline-flex;
    padding: var(--smrt-spacing-0_5, 0.125rem);
  }
  .smrt-theme-switcher__segment {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-1_5, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    cursor: pointer;
  }
}

@layer smrt.theme {
  .smrt-theme-switcher__label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 400);
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-theme-switcher__select {
    border-radius: var(--smrt-radius-md, 0.5rem);
    border: var(--smrt-hairline-strong);
    background: var(--smrt-color-surface, white);
    color: var(--smrt-color-on-surface, inherit);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-theme-switcher__button {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface, inherit);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    transition: all 200ms ease;
  }
  .smrt-theme-switcher__button:hover {
    background: var(--smrt-color-surface-container);
  }
  .smrt-theme-switcher__button.smrt-theme-switcher__active {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    border-color: var(--smrt-color-primary);
  }
  .smrt-theme-switcher__segmented {
    background: var(--smrt-color-surface-container-lowest);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-lg, 0.75rem);
  }
  .smrt-theme-switcher__segment {
    border: none;
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    transition: all 200ms ease;
  }
  .smrt-theme-switcher__segment:hover {
    color: var(--smrt-color-on-surface, inherit);
  }
  .smrt-theme-switcher__segment.smrt-theme-switcher__active {
    background: var(--smrt-color-surface, white);
    color: var(--smrt-color-on-surface, inherit);
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgba(0,0,0,0.1));
  }
  .smrt-theme-switcher__icon {
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
}

</style>
