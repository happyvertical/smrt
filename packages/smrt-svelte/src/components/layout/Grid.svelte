<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type GapSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Responsive columns configuration
 * Allows different column counts at different breakpoints
 */
interface ResponsiveColumns {
  /** Columns for small screens (< 640px) */
  sm?: number;
  /** Columns for medium screens (>= 640px) */
  md?: number;
  /** Columns for large screens (>= 1024px) */
  lg?: number;
  /** Columns for extra large screens (>= 1280px) */
  xl?: number;
}

/**
 * Gap configuration - can be a simple size or separate row/column gaps
 */
type GapConfig = GapSize | { row?: GapSize; column?: GapSize };

type AlignItems = 'start' | 'center' | 'end' | 'stretch';
type JustifyItems = 'start' | 'center' | 'end' | 'stretch';
type AutoFlow = 'row' | 'column' | 'row dense' | 'column dense';

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  /** Number of columns, 'auto' for auto-fill, or responsive object */
  columns?: number | 'auto' | ResponsiveColumns;
  /** Gap between items - size or { row, column } */
  gap?: GapConfig;
  /** Header snippet rendered above the grid */
  header?: Snippet;
  /** Main grid content */
  children?: Snippet;
  /** Vertical alignment of grid items */
  alignItems?: AlignItems;
  /** Horizontal alignment of grid items */
  justifyItems?: JustifyItems;
  /** Grid auto-flow direction */
  autoFlow?: AutoFlow;
}

const {
  columns = 'auto',
  gap = 'md',
  header,
  children,
  alignItems,
  justifyItems,
  autoFlow,
  ...rest
}: Props = $props();

// Determine if we're using responsive columns
const isResponsive = $derived(
  typeof columns === 'object' && columns !== null && !Array.isArray(columns),
);

// Build grid-template-columns for non-responsive case
const _gridColumns = $derived.by(() => {
  if (isResponsive) return undefined;
  if (columns === 'auto') {
    return 'repeat(auto-fill, minmax(300px, 1fr))';
  }
  return `repeat(${columns}, 1fr)`;
});

// Build CSS custom properties for responsive columns
const responsiveStyles = $derived.by(() => {
  if (!isResponsive) return '';
  const cols = columns as ResponsiveColumns;
  const vars: string[] = [];
  if (cols.sm !== undefined) vars.push(`--grid-columns-sm: ${cols.sm}`);
  if (cols.md !== undefined) vars.push(`--grid-columns-md: ${cols.md}`);
  if (cols.lg !== undefined) vars.push(`--grid-columns-lg: ${cols.lg}`);
  if (cols.xl !== undefined) vars.push(`--grid-columns-xl: ${cols.xl}`);
  return vars.join('; ');
});

// Parse gap configuration
const rowGap = $derived(typeof gap === 'object' ? gap.row : gap);
const columnGap = $derived(typeof gap === 'object' ? gap.column : gap);

// Build inline styles
const inlineStyles = $derived.by(() => {
  const styles: string[] = [];

  // Grid template columns (non-responsive only)
  if (_gridColumns) {
    styles.push(`grid-template-columns: ${_gridColumns}`);
  }

  // Responsive CSS variables
  if (responsiveStyles) {
    styles.push(responsiveStyles);
  }

  // Alignment
  if (alignItems) styles.push(`align-items: ${alignItems}`);
  if (justifyItems) styles.push(`justify-items: ${justifyItems}`);

  // Auto flow
  if (autoFlow) styles.push(`grid-auto-flow: ${autoFlow}`);

  return styles.join('; ');
});

// Build class names
const gridClasses = $derived.by(() => {
  const classes = ['grid'];

  // Responsive modifier
  if (isResponsive) {
    classes.push('grid-responsive');
  }

  // Gap classes (row and column may differ)
  if (rowGap && columnGap && rowGap === columnGap) {
    classes.push(`gap-${rowGap}`);
  } else {
    if (rowGap) classes.push(`row-gap-${rowGap}`);
    if (columnGap) classes.push(`col-gap-${columnGap}`);
  }

  return classes.join(' ');
});
</script>

{#if header}
  <div class="grid-header">
    {@render header()}
  </div>
{/if}
<div
  class={gridClasses}
  style={inlineStyles}
  {...rest}
>
  {@render children?.()}
</div>

<style>
  .grid {
    display: grid;
  }

  .grid-header {
    width: 100%;
    margin-bottom: var(--spacing-md);
  }

  /* Responsive grid - uses CSS variables set via inline styles */
  .grid-responsive {
    grid-template-columns: repeat(var(--grid-columns-sm, 1), 1fr);
  }

  @media (min-width: 640px) {
    .grid-responsive {
      grid-template-columns: repeat(var(--grid-columns-md, var(--grid-columns-sm, 2)), 1fr);
    }
  }

  @media (min-width: 1024px) {
    .grid-responsive {
      grid-template-columns: repeat(var(--grid-columns-lg, var(--grid-columns-md, var(--grid-columns-sm, 3))), 1fr);
    }
  }

  @media (min-width: 1280px) {
    .grid-responsive {
      grid-template-columns: repeat(var(--grid-columns-xl, var(--grid-columns-lg, var(--grid-columns-md, var(--grid-columns-sm, 4)))), 1fr);
    }
  }

  /* Uniform gap */
  .gap-sm {
    gap: var(--spacing-md);
  }

  .gap-md {
    gap: var(--spacing-lg);
  }

  .gap-lg {
    gap: var(--spacing-xl);
  }

  .gap-xl {
    gap: var(--spacing-2xl);
  }

  /* Row gap */
  .row-gap-sm {
    row-gap: var(--spacing-md);
  }

  .row-gap-md {
    row-gap: var(--spacing-lg);
  }

  .row-gap-lg {
    row-gap: var(--spacing-xl);
  }

  .row-gap-xl {
    row-gap: var(--spacing-2xl);
  }

  /* Column gap */
  .col-gap-sm {
    column-gap: var(--spacing-md);
  }

  .col-gap-md {
    column-gap: var(--spacing-lg);
  }

  .col-gap-lg {
    column-gap: var(--spacing-xl);
  }

  .col-gap-xl {
    column-gap: var(--spacing-2xl);
  }
</style>
