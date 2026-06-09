<script lang="ts">
/**
 * SMRTToggle - An accessible toggle/switch component
 *
 * Features:
 * - Native checkbox semantics for accessibility
 * - Bindable checked state
 * - Disabled state
 * - Labels on either side
 * - Size variants
 * - Material 3 styling
 */

export interface Props {
  /** Whether the toggle is checked */
  checked?: boolean;
  /** Whether the toggle is disabled */
  disabled?: boolean;
  /** Name attribute for form submission */
  name?: string;
  /** Value attribute for form submission */
  value?: string;
  /** Label text */
  label?: string;
  /** Position of the label */
  labelPosition?: 'left' | 'right';
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** ID for the input element */
  id?: string;
  /** ARIA label for accessibility */
  ariaLabel?: string;
  /** Change callback */
  onchange?: (checked: boolean) => void;
}

let {
  checked = $bindable(false),
  disabled = false,
  name,
  value,
  label,
  labelPosition = 'right',
  size = 'md',
  id,
  ariaLabel,
  onchange,
}: Props = $props();

function handleChange(event: Event) {
  const target = event.target as HTMLInputElement;
  checked = target.checked;
  onchange?.(checked);
}

const sizeClasses = {
  sm: 'toggle--sm',
  md: 'toggle--md',
  lg: 'toggle--lg',
};
</script>

<label class="toggle {sizeClasses[size]}" class:toggle--disabled={disabled}>
  {#if label && labelPosition === 'left'}
    <span class="toggle__label toggle__label--left">{label}</span>
  {/if}

  <span class="toggle__track">
    <input
      type="checkbox"
      class="toggle__input"
      {id}
      {name}
      {value}
      {disabled}
      {checked}
      onchange={handleChange}
      aria-label={ariaLabel ?? label ?? ''}
    />
    <span class="toggle__thumb"></span>
  </span>

  {#if label && labelPosition === 'right'}
    <span class="toggle__label toggle__label--right">{label}</span>
  {/if}
</label>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    cursor: pointer;
    user-select: none;
  }

  .toggle--disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .toggle__label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface, #111827);
    line-height: 1.5;
  }

  .toggle__track {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .toggle__input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .toggle__thumb {
    position: relative;
    background: var(--smrt-color-surface-container-highest, #e5e7eb);
    border-radius: var(--smrt-radius-full, 9999px);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .toggle__thumb::after {
    content: '';
    position: absolute;
    background: var(--smrt-color-surface, #ffffff);
    border-radius: var(--smrt-radius-full, 9999px);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 20%, transparent));
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  /* Checked state */
  .toggle__input:checked + .toggle__thumb {
    background: var(--smrt-color-primary, #005ac1);
  }

  /* Focus state */
  .toggle__input:focus-visible + .toggle__thumb {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  /* Hover state */
  .toggle:not(.toggle--disabled):hover .toggle__thumb {
    background: var(--smrt-color-surface-container-high, #d1d5db);
  }

  .toggle:not(.toggle--disabled):hover .toggle__input:checked + .toggle__thumb {
    background: var(--smrt-color-primary, #2563eb);
  }

  /* Size: Small */
  .toggle--sm .toggle__thumb {
    width: 32px;
    height: 18px;
  }

  .toggle--sm .toggle__thumb::after {
    width: 14px;
    height: 14px;
    top: 2px;
    left: 2px;
  }

  .toggle--sm .toggle__input:checked + .toggle__thumb::after {
    transform: translateX(14px);
  }

  /* Size: Medium (default) */
  .toggle--md .toggle__thumb {
    width: 44px;
    height: 24px;
  }

  .toggle--md .toggle__thumb::after {
    width: 20px;
    height: 20px;
    top: 2px;
    left: 2px;
  }

  .toggle--md .toggle__input:checked + .toggle__thumb::after {
    transform: translateX(20px);
  }

  /* Size: Large */
  .toggle--lg .toggle__thumb {
    width: 56px;
    height: 30px;
  }

  .toggle--lg .toggle__thumb::after {
    width: 26px;
    height: 26px;
    top: 2px;
    left: 2px;
  }

  .toggle--lg .toggle__input:checked + .toggle__thumb::after {
    transform: translateX(26px);
  }

  .toggle--lg .toggle__label {
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
</style>
