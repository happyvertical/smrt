<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { BadgeSize, BadgeVariant } from '../../types-generic';

interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'class'> {
  /** Visual variant for color and styling. */
  variant?: BadgeVariant;
  /** Size of the badge. */
  size?: BadgeSize;
  /** The badge content. */
  children?: Snippet;
}

const { variant = 'default', size = 'md', children, ...rest }: Props = $props();
</script>

<span class="smrt-badge__root smrt-badge__{variant} smrt-badge__{size}" {...rest} data-smrt-component="Badge">
  {@render children?.()}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-badge__root {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
  }
  .smrt-badge__sm {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-badge__md {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
  }
}
@layer smrt.theme {
  .smrt-badge__root {
    font-weight: var(--smrt-control-weight);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-badge__sm {
    font-size: var(--smrt-typography-body-small-size);
  }
  .smrt-badge__md {
    font-size: var(--smrt-typography-body-medium-size);
  }
  .smrt-badge__default {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }
  /* Quiet neutral status: outlined, square-cornered and unfilled so it does not read as a tonal button. */
  .smrt-badge__neutral {
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    border-color: var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-small);
  }
  .smrt-badge__primary {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-badge__success {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-badge__warning {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-badge__error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-badge__info {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-badge__root { background: Canvas; color: CanvasText; border-color: CanvasText; }
  }
}
</style>
