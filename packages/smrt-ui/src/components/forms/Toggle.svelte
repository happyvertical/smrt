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
  sm: 'smrt-toggle__sm',
  md: 'smrt-toggle__md',
  lg: 'smrt-toggle__lg',
};
</script>

<label class="smrt-toggle__root {sizeClasses[size]}" class:smrt-toggle__disabled={disabled} data-smrt-component="Toggle">
  {#if label && labelPosition === 'left'}
    <span class="smrt-toggle__label smrt-toggle__label--left" data-smrt-part="label">{label}</span>
  {/if}

  <span class="smrt-toggle__track" data-smrt-part="track">
    <input
      type="checkbox"
      class="smrt-toggle__input"
      data-smrt-part="input"
      {id}
      {name}
      {value}
      {disabled}
      {checked}
      onchange={handleChange}
      aria-label={ariaLabel ?? label ?? ''}
    />
    <span class="smrt-toggle__thumb" data-smrt-part="thumb"></span>
  </span>

  {#if label && labelPosition === 'right'}
    <span class="smrt-toggle__label smrt-toggle__label--right" data-smrt-part="label">{label}</span>
  {/if}
</label>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-toggle__root {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    cursor: pointer;
    user-select: none;
  }
  .smrt-toggle__disabled {
    cursor: not-allowed;
  }
  .smrt-toggle__track {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .smrt-toggle__input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .smrt-toggle__thumb {
    position: relative;
  }
  .smrt-toggle__thumb::after {
    content: '';
    position: absolute;
  }
  /* Size: Small */
  .smrt-toggle__sm .smrt-toggle__thumb {
    width: 32px;
    height: 18px;
  }
  .smrt-toggle__sm .smrt-toggle__thumb::after {
    width: 14px;
    height: 14px;
    top: 2px;
    left: 2px;
  }
  /* Size: Medium (default) */
  .smrt-toggle__md .smrt-toggle__thumb {
    width: 44px;
    height: 24px;
  }
  .smrt-toggle__md .smrt-toggle__thumb::after {
    width: 20px;
    height: 20px;
    top: 2px;
    left: 2px;
  }
  /* Size: Large */
  .smrt-toggle__lg .smrt-toggle__thumb {
    width: 56px;
    height: 30px;
  }
  .smrt-toggle__lg .smrt-toggle__thumb::after {
    width: 26px;
    height: 26px;
    top: 2px;
    left: 2px;
  }
  .smrt-toggle__sm .smrt-toggle__input:checked + .smrt-toggle__thumb::after {
    transform: translateX(14px);
  }
  .smrt-toggle__md .smrt-toggle__input:checked + .smrt-toggle__thumb::after {
    transform: translateX(20px);
  }
  .smrt-toggle__lg .smrt-toggle__input:checked + .smrt-toggle__thumb::after {
    transform: translateX(26px);
  }
}

@layer smrt.theme {
  .smrt-toggle__disabled {
    opacity: 0.5;
  }
  .smrt-toggle__label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
    line-height: 1.5;
  }
  .smrt-toggle__input {
    border: 0;
  }
  .smrt-toggle__thumb {
    background: var(--smrt-color-surface-container-highest);
    border-radius: var(--smrt-radius-full);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-toggle__thumb::after {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-full);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 20%, transparent));
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  /* Checked state */
  .smrt-toggle__input:checked + .smrt-toggle__thumb {
    background: var(--smrt-color-primary);
  }
  /* Focus state */
  .smrt-toggle__input:focus-visible + .smrt-toggle__thumb {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  /* Hover state */
  .smrt-toggle__root:not(.smrt-toggle__disabled):hover .smrt-toggle__thumb {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-toggle__root:not(.smrt-toggle__disabled):hover .smrt-toggle__input:checked + .smrt-toggle__thumb {
    background: var(--smrt-color-primary);
  }
  .smrt-toggle__lg .smrt-toggle__label {
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-toggle__thumb,
    .smrt-toggle__thumb::after {
      transition: none;
    }
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-toggle__thumb, .smrt-toggle__root:not(.smrt-toggle__disabled):hover .smrt-toggle__thumb {
      background: Canvas;
      outline: var(--smrt-hairline-strong);
      outline-offset: 0;
    }
    .smrt-toggle__input:checked + .smrt-toggle__thumb, .smrt-toggle__root:not(.smrt-toggle__disabled):hover .smrt-toggle__input:checked + .smrt-toggle__thumb {
      background: Highlight;
      outline-color: Highlight;
    }
    .smrt-toggle__thumb::after {
      background: CanvasText;
    }
    .smrt-toggle__input:checked + .smrt-toggle__thumb::after {
      background: HighlightText;
    }
    .smrt-toggle__input:focus-visible + .smrt-toggle__thumb {
      outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
      outline-offset: var(--smrt-focus-ring-offset);
    }
    .smrt-toggle__disabled {
      opacity: 1;
      color: GrayText;
    }
    .smrt-toggle__disabled .smrt-toggle__label {
      color: GrayText;
    }
    .smrt-toggle__disabled .smrt-toggle__thumb, .smrt-toggle__disabled .smrt-toggle__input:checked + .smrt-toggle__thumb {
      background: Canvas;
      outline-color: GrayText;
    }
    .smrt-toggle__disabled .smrt-toggle__thumb::after, .smrt-toggle__disabled .smrt-toggle__input:checked + .smrt-toggle__thumb::after {
      background: GrayText;
    }
  }
}

</style>
