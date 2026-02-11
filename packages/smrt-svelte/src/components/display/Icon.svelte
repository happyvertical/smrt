<script lang="ts">
/**
 * Icon - SVG icon component
 *
 * Displays SVG icons from presets or custom paths.
 *
 * Accessibility:
 * - Use aria-label for informative icons
 * - Uses aria-hidden="true" by default (decorative)
 */

/** Props for Icon component */
export interface Props {
  /** Preset icon name */
  name?: string;
  /** Custom SVG path */
  path?: string;
  /** Icon size (number for pixels, string for CSS value) */
  size?: string | number;
  /** Icon color */
  color?: string;
  /** SVG viewBox */
  viewBox?: string;
  /** Accessible label (makes icon informative) */
  'aria-label'?: string;
}

const {
  name,
  path,
  size = 24,
  color = 'currentColor',
  viewBox = '0 0 24 24',
  'aria-label': ariaLabel,
}: Props = $props();

const isInformative = $derived(!!ariaLabel);

// Common M3 Icon Paths (Simplified)
const presets: Record<string, string> = {
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  search:
    'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  close:
    'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z',
  'chevron-right': 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6z',
  'chevron-left': 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59z',
  'chevron-down': 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.04 6.43 5 7.07V21h4v-2.93c2.96-.64 5-3.54 5-7.07h-2z',
};

const finalPath = $derived(path ?? (name ? presets[name] : ''));
const pxSize = $derived(typeof size === 'number' ? `${size}px` : size);
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={pxSize}
  height={pxSize}
  {viewBox}
  fill={color}
  aria-hidden={!isInformative}
  aria-label={ariaLabel}
  role={isInformative ? 'img' : undefined}
>
  <path d={finalPath} />
</svg>

<style>
  svg {
    display: inline-block;
    flex-shrink: 0;
    vertical-align: middle;
  }
</style>
